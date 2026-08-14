/**
 * Real-DB integration: subscription retrieve failure → self-correcting access.
 *
 * Task #769 — "Prevent a repeated retrieve failure from silently extending
 * access each time Stripe retries the webhook."
 *
 * The design relies on two guarantees:
 *   1. A checkout.session.completed retrieve failure grants "active" access
 *      only once — Stripe retries (same event ID) hit the alert dedup and
 *      the isNewSubscription guard prevents re-granting.
 *   2. The subsequent customer.subscription.* events (which use the event
 *      payload directly, never calling retrieve) always correct whatever
 *      status the fail-open wrote — so access cannot be permanently locked
 *      in the wrong state.
 *
 * These tests verify both guarantees against a real PostgreSQL database.
 *
 * Covered scenarios:
 *   1. checkout retrieve-fail → tenant gains "active" → subscription.deleted
 *      arrives → tenant correctly moves to "canceled" (access revoked).
 *   2. checkout retrieve-fail → same event replayed (same Stripe event ID) →
 *      only ONE stripe_alert row exists (onConflictDoNothing deduplication);
 *      tenant subscriptionStatus is not re-written to "active" (isNewSubscription
 *      guard is false after the first write).
 *   3. checkout retrieve-fail → tenant gains "active" → subscription.updated
 *      with status "past_due" arrives → tenant correctly moves to "past_due".
 *   4. Stripe alert row created during retrieve failure contains the
 *      subscription ID and a descriptive reason so operators can reconcile.
 */
import { afterAll, afterEach, beforeEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { randomUUID } from "node:crypto";
import { db, tenantsTable, stripeAlertsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// ── Stub non-DB collaborators; keep real @workspace/db untouched ──────────────

// getStripeClient: retrieve() will throw in all tests (simulates key mismatch
// or Stripe unreachable at checkout time). The subscription event handler
// never calls retrieve, so mocking it to throw is safe for the full sequence.
const mockRetrieve = vi.hoisted(() =>
  vi.fn().mockRejectedValue(new Error("ECONNREFUSED stripe.com:443")),
);
vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(async () => ({
    subscriptions: { retrieve: mockRetrieve },
  })),
  getStripeWebhookSecret: vi.fn().mockResolvedValue(null), // dev-bypass: no sig check
  calcApplicationFee: (cents: number) => Math.round(cents * 0.05),
  StripeNotConfiguredError: class StripeNotConfiguredError extends Error {},
}));

vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: vi.fn(),
  sendBillingAlertNotification: vi.fn(),
}));
vi.mock("@/lib/slack", () => ({
  sendBillingAlertSlackNotification: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("@/lib/iframer", () => ({
  createIFramerJob: vi.fn(),
  IFramerError: class IFramerError extends Error {},
}));
// Dev-bypass mode: no Stripe-Signature header required.
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
}));
vi.mock("@/lib/base-url", () => ({
  getTenantUrl: vi.fn(() => "https://gallery.test/orders"),
}));
vi.stubEnv("STRIPE_WEBHOOK_DEV_BYPASS", "true");

import { POST as webhookPOST } from "@/app/api/stripe/webhook/route";

// Reset call counts before each test so assertions on mockRetrieve.toHaveBeenCalled()
// reflect only the current test's invocations, not those from earlier tests.
beforeEach(() => {
  mockRetrieve.mockClear();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
function uid() {
  return `${randomUUID()}-ri-${RUN}-${++seq}`;
}

const createdTenantIds: string[] = [];
const createdAlertEventIds: string[] = [];

async function createTenant(
  overrides: {
    subscriptionStatus?: string | null;
    stripeSubscriptionId?: string | null;
    stripeCustomerId?: string | null;
  } = {},
) {
  const id = uid();
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Retrieve-Failure Test Gallery",
    type: "ARTIST",
    billingExempt: false,
    subscriptionStatus: overrides.subscriptionStatus ?? null,
    stripeSubscriptionId: overrides.stripeSubscriptionId ?? null,
    stripeCustomerId: overrides.stripeCustomerId ?? null,
  } as any);
  createdTenantIds.push(id);
  return id;
}

function makeRequest(body: object) {
  return new Request("http://localhost/api/stripe/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Simulate checkout.session.completed (subscription mode) for a new tenant. */
function checkoutEvent(
  eventId: string,
  tenantId: string,
  subscriptionId: string,
  customerId = `cus-${tenantId}`,
) {
  return {
    id: eventId,
    type: "checkout.session.completed",
    data: {
      object: {
        id: `cs-${eventId}`,
        mode: "subscription",
        customer: customerId,
        subscription: subscriptionId,
        metadata: { billingTenantId: tenantId },
      },
    },
  };
}

/** Simulate customer.subscription.deleted or .updated. */
function subscriptionEvent(
  eventId: string,
  tenantId: string,
  subscriptionId: string,
  status: string,
  eventType: "customer.subscription.deleted" | "customer.subscription.updated",
) {
  return {
    id: eventId,
    type: eventType,
    data: {
      object: {
        id: subscriptionId,
        status,
        customer: `cus-${tenantId}`,
        metadata: { billingTenantId: tenantId },
        trial_end: null,
      },
    },
  };
}

async function getTenantStatus(id: string) {
  const row = await db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.id, id),
    columns: { subscriptionStatus: true, stripeSubscriptionId: true },
  });
  return row;
}

async function cleanup() {
  for (const eventId of createdAlertEventIds.splice(0)) {
    await db
      .delete(stripeAlertsTable)
      .where(eq(stripeAlertsTable.stripeEventId, eventId))
      .catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db
      .delete(tenantsTable)
      .where(eq(tenantsTable.id, id))
      .catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration(
  "Stripe webhook — subscription retrieve-failure self-correction — real-DB",
  () => {
    it(
      "checkout retrieve-fail → tenant gains 'active' → subscription.deleted corrects to 'canceled'",
      async () => {
        const tenantId = await createTenant();
        const subId = `sub-${uid()}`;
        const checkoutEventId = `evt-co-${uid()}`;
        const deletedEventId = `evt-del-${uid()}`;
        createdAlertEventIds.push(checkoutEventId);

        // Step 1: checkout.session.completed — retrieve() throws → fail-open
        const coRes = await webhookPOST(
          makeRequest(checkoutEvent(checkoutEventId, tenantId, subId)),
        );
        expect(coRes.status).toBe(200);

        // Tenant must be "active" after fail-open.
        const afterCheckout = await getTenantStatus(tenantId);
        expect(afterCheckout?.subscriptionStatus).toBe("active");
        expect(afterCheckout?.stripeSubscriptionId).toBe(subId);

        // Step 2: customer.subscription.deleted — uses event payload, no retrieve
        const delRes = await webhookPOST(
          makeRequest(
            subscriptionEvent(
              deletedEventId,
              tenantId,
              subId,
              "canceled",
              "customer.subscription.deleted",
            ),
          ),
        );
        expect(delRes.status).toBe(200);

        // Self-correction: tenant must now be "canceled" (access revoked).
        const afterDelete = await getTenantStatus(tenantId);
        expect(afterDelete?.subscriptionStatus).toBe("canceled");
      },
    );

    it(
      "checkout retrieve-fail → same event ID replayed → only ONE stripe_alert row (idempotent)",
      async () => {
        const tenantId = await createTenant();
        const subId = `sub-${uid()}`;
        const checkoutEventId = `evt-co-dedup-${uid()}`;
        createdAlertEventIds.push(checkoutEventId);

        const event = checkoutEvent(checkoutEventId, tenantId, subId);

        // First delivery
        await webhookPOST(makeRequest(event));
        // Second delivery — Stripe retry simulation with the same event ID
        await webhookPOST(makeRequest(event));

        // Exactly one alert row must exist (onConflictDoNothing deduplication).
        const alerts = await db
          .select({ id: stripeAlertsTable.id })
          .from(stripeAlertsTable)
          .where(eq(stripeAlertsTable.stripeEventId, checkoutEventId));
        expect(alerts).toHaveLength(1);

        // Tenant subscriptionStatus must be "active" — not double-written.
        const row = await getTenantStatus(tenantId);
        expect(row?.subscriptionStatus).toBe("active");
      },
    );

    it(
      "checkout retrieve-fail → tenant gains 'active' → subscription.updated with 'past_due' corrects status",
      async () => {
        const tenantId = await createTenant();
        const subId = `sub-${uid()}`;
        const checkoutEventId = `evt-co-pd-${uid()}`;
        const updatedEventId = `evt-upd-pd-${uid()}`;
        createdAlertEventIds.push(checkoutEventId);

        // Checkout fails → "active"
        await webhookPOST(makeRequest(checkoutEvent(checkoutEventId, tenantId, subId)));
        const afterCheckout = await getTenantStatus(tenantId);
        expect(afterCheckout?.subscriptionStatus).toBe("active");

        // Subscription updated to "past_due" → must override the fail-open "active"
        const updRes = await webhookPOST(
          makeRequest(
            subscriptionEvent(
              updatedEventId,
              tenantId,
              subId,
              "past_due",
              "customer.subscription.updated",
            ),
          ),
        );
        expect(updRes.status).toBe(200);

        const afterUpdate = await getTenantStatus(tenantId);
        expect(afterUpdate?.subscriptionStatus).toBe("past_due");
      },
    );

    it(
      "stripe_alert row from retrieve failure carries subscriptionId and descriptive reason",
      async () => {
        const tenantId = await createTenant();
        const subId = `sub-reason-${uid()}`;
        const checkoutEventId = `evt-co-reason-${uid()}`;
        createdAlertEventIds.push(checkoutEventId);

        await webhookPOST(makeRequest(checkoutEvent(checkoutEventId, tenantId, subId)));

        const alert = await db.query.stripeAlertsTable.findFirst({
          where: eq(stripeAlertsTable.stripeEventId, checkoutEventId),
        });
        expect(alert).toBeDefined();
        expect(alert?.subscriptionId).toBe(subId);
        expect(alert?.eventType).toBe("checkout.session.completed");
        // Reason must mention the subscription ID so operators can reconcile.
        expect(alert?.reason).toMatch(subId);
        expect(alert?.reason).toMatch(/subscriptions\.retrieve failed/);
      },
    );

    it(
      "second checkout retrieve-fail for same subscription does NOT re-run retrieve (isNewSubscription guard)",
      async () => {
        // Tenant already has the subscription as "active" from a prior checkout.
        const subId = `sub-isnew-${uid()}`;
        const tenantId = await createTenant({
          subscriptionStatus: "active",
          stripeSubscriptionId: subId,
        });
        const secondCheckoutEventId = `evt-co-isnew-${uid()}`;
        createdAlertEventIds.push(secondCheckoutEventId);

        // Post a second checkout for the SAME subscription ID.
        const res = await webhookPOST(
          makeRequest(checkoutEvent(secondCheckoutEventId, tenantId, subId)),
        );
        expect(res.status).toBe(200);

        // retrieve() must NOT have been called — isNewSubscription was false.
        expect(mockRetrieve).not.toHaveBeenCalled();

        // No alert row should have been inserted for this event.
        const alert = await db.query.stripeAlertsTable.findFirst({
          where: eq(stripeAlertsTable.stripeEventId, secondCheckoutEventId),
        });
        expect(alert).toBeUndefined();
      },
    );
  },
);
