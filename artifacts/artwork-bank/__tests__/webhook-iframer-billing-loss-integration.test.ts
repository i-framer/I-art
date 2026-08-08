/**
 * Task #484 — Confirm the i-Framer billing-loss Slack alert reaches the
 * operator when a subscription lapses on a real database.
 *
 * The unit test (webhook-iframer-billing-alert.test.ts) proves branching logic
 * with a mocked DB.  This integration test completes the picture by using a
 * real postgres row with iframerAccountId set, driving the webhook route, and
 * asserting:
 *  1. The stripe_alert row is persisted in the real DB.
 *  2. sendBillingAlertSlackNotification is called with the correct iframerAccountId.
 *  3. customer.subscription.deleted (canceled) triggers the alert.
 *  4. customer.subscription.updated with billing-loss statuses (past_due, unpaid,
 *     incomplete_expired) triggers the alert.
 *  5. Non-billing-loss statuses (active, trialing) do NOT trigger the alert.
 *  6. invoice.payment_failed triggers the alert when iframerAccountId is set.
 *  7. A tenant WITHOUT iframerAccountId does NOT trigger the Slack call.
 *  8. Stripe event idempotency: duplicate event ID suppresses a second alert insert.
 */
import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { randomUUID } from "node:crypto";

// ── Stub non-DB collaborators; keep the real @workspace/db untouched ──────────

vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(),
  getStripeWebhookSecret: vi.fn().mockResolvedValue(null),
  calcApplicationFee: (cents: number) => Math.round(cents * 0.05),
  StripeNotConfiguredError: class StripeNotConfiguredError extends Error {},
}));

vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: vi.fn(),
  sendBillingAlertNotification: vi.fn(),
}));

// Slack mocked to resolve — we assert call arguments, not a real Slack post.
const sendBillingAlertSlackNotification = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ ok: true }),
);
vi.mock("@/lib/slack", () => ({
  sendBillingAlertSlackNotification: (...a: unknown[]) =>
    sendBillingAlertSlackNotification(...a),
}));

vi.mock("@/lib/iframer", () => ({
  createIFramerJob: vi.fn(),
  IFramerError: class IFramerError extends Error {},
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/base-url", () => ({ getTenantUrl: vi.fn() }));

// ── Real DB + webhook handler ─────────────────────────────────────────────────

import { db, tenantsTable, stripeAlertsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { POST as webhookPOST } from "@/app/api/stripe/webhook/route";

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid() {
  return randomUUID();
}

/** Insert a tenant with an i-Framer account linked (or without, for contrast). */
async function createTenant(overrides: {
  id?: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  subscriptionStatus?: string;
  iframerAccountId?: string | null;
} = {}) {
  const id = overrides.id ?? uid();
  await db.insert(tenantsTable).values({
    id,
    type: "ARTIST",
    businessName: "i-Framer Integration Test Gallery",
    slug: `iframer-billing-loss-${id}`,
    stripeCustomerId: overrides.stripeCustomerId ?? null,
    stripeSubscriptionId: overrides.stripeSubscriptionId ?? null,
    subscriptionStatus: overrides.subscriptionStatus ?? "active",
    iframerAccountId: overrides.iframerAccountId !== undefined
      ? overrides.iframerAccountId
      : `ifr-${id}`,
  } as any);
  return id;
}

/** Read the persisted stripe_alert rows for a given Stripe event ID. */
async function getAlertsByEventId(stripeEventId: string) {
  return db.query.stripeAlertsTable.findMany({
    where: eq(stripeAlertsTable.stripeEventId, stripeEventId),
  });
}

/** Post a fake Stripe webhook (dev-bypass mode skips signature verification). */
function post(event: object) {
  return webhookPOST(
    new Request("http://localhost/api/stripe/webhook", {
      method: "POST",
      body: JSON.stringify(event),
    }),
  );
}

/** Build a customer.subscription.* event. */
function subscriptionEvent(
  status: string,
  type: string,
  tenantId: string,
  overrides: { id?: string } = {},
) {
  const evtId = overrides.id ?? `evt-484-${type.replace(/\./g, "-")}-${uid()}`;
  return {
    id: evtId,
    type,
    data: {
      object: {
        id: `sub-484-${uid()}`,
        status,
        customer: `cus-484-${uid()}`,
        metadata: { billingTenantId: tenantId },
      },
    },
  };
}

/** Build an invoice.payment_failed event. */
function invoiceFailedEvent(
  tenantId: string,
  stripeCustomerId: string,
  overrides: { id?: string } = {},
) {
  const evtId = overrides.id ?? `evt-484-invoice-failed-${uid()}`;
  return {
    id: evtId,
    type: "invoice.payment_failed",
    data: {
      object: {
        customer: stripeCustomerId,
        subscription: `sub-484-${uid()}`,
        billing_reason: "subscription_cycle",
      },
    },
  };
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

const createdTenantIds: string[] = [];
const createdAlertEventIds: string[] = [];

beforeEach(() => {
  process.env.STRIPE_WEBHOOK_DEV_BYPASS = "true";
  createdTenantIds.length = 0;
  createdAlertEventIds.length = 0;
  sendBillingAlertSlackNotification.mockClear();
  sendBillingAlertSlackNotification.mockResolvedValue({ ok: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  delete process.env.STRIPE_WEBHOOK_DEV_BYPASS;
  vi.restoreAllMocks();
  for (const eventId of createdAlertEventIds) {
    await db
      .delete(stripeAlertsTable)
      .where(eq(stripeAlertsTable.stripeEventId, eventId))
      .catch(() => {});
  }
  for (const id of createdTenantIds) {
    await db
      .delete(tenantsTable)
      .where(eq(tenantsTable.id, id))
      .catch(() => {});
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describeIntegration(
  "i-Framer billing-loss Slack alert on real DB — Task #484",
  () => {
    it("customer.subscription.deleted persists a stripe_alert row for an i-Framer tenant", async () => {
      const tenantId = await createTenant({ subscriptionStatus: "active" });
      createdTenantIds.push(tenantId);

      const evt = subscriptionEvent(
        "canceled",
        "customer.subscription.deleted",
        tenantId,
      );
      createdAlertEventIds.push(evt.id);

      const res = await post(evt);
      expect(res.status).toBe(200);

      const alerts = await getAlertsByEventId(evt.id);
      expect(alerts).toHaveLength(1);
      // The alert reason must embed the i-Framer account ID for operator triage.
      expect(alerts[0]?.reason).toContain("ifr-");
    });

    it("customer.subscription.deleted calls sendBillingAlertSlackNotification with the correct iframerAccountId", async () => {
      const iframerAccountId = `ifr-test-${uid()}`;
      const tenantId = await createTenant({
        subscriptionStatus: "active",
        iframerAccountId,
      });
      createdTenantIds.push(tenantId);

      const evt = subscriptionEvent(
        "canceled",
        "customer.subscription.deleted",
        tenantId,
      );
      createdAlertEventIds.push(evt.id);

      await post(evt);

      // The Slack call must include the iframerAccountId so the operator knows
      // which Premium customer lost access.
      expect(sendBillingAlertSlackNotification).toHaveBeenCalledOnce();
      const [callArg] = sendBillingAlertSlackNotification.mock.calls[0] as [
        Record<string, unknown>,
      ];
      expect(callArg?.iframerAccountId).toBe(iframerAccountId);
    });

    it("customer.subscription.updated to past_due triggers the alert for an i-Framer tenant", async () => {
      const iframerAccountId = `ifr-test-${uid()}`;
      const tenantId = await createTenant({
        subscriptionStatus: "active",
        iframerAccountId,
      });
      createdTenantIds.push(tenantId);

      const evt = subscriptionEvent(
        "past_due",
        "customer.subscription.updated",
        tenantId,
      );
      createdAlertEventIds.push(evt.id);

      const res = await post(evt);
      expect(res.status).toBe(200);

      const alerts = await getAlertsByEventId(evt.id);
      expect(alerts).toHaveLength(1);
      expect(sendBillingAlertSlackNotification).toHaveBeenCalledOnce();
    });

    it("customer.subscription.updated to unpaid triggers the alert for an i-Framer tenant", async () => {
      const iframerAccountId = `ifr-test-${uid()}`;
      const tenantId = await createTenant({
        subscriptionStatus: "active",
        iframerAccountId,
      });
      createdTenantIds.push(tenantId);

      const evt = subscriptionEvent(
        "unpaid",
        "customer.subscription.updated",
        tenantId,
      );
      createdAlertEventIds.push(evt.id);

      await post(evt);

      const alerts = await getAlertsByEventId(evt.id);
      expect(alerts).toHaveLength(1);
      expect(sendBillingAlertSlackNotification).toHaveBeenCalledOnce();
      const [callArg] = sendBillingAlertSlackNotification.mock.calls[0] as [
        Record<string, unknown>,
      ];
      expect(callArg?.iframerAccountId).toBe(iframerAccountId);
    });

    it("customer.subscription.updated to incomplete_expired triggers the alert for an i-Framer tenant", async () => {
      const iframerAccountId = `ifr-test-${uid()}`;
      const tenantId = await createTenant({
        subscriptionStatus: "trialing",
        iframerAccountId,
      });
      createdTenantIds.push(tenantId);

      const evt = subscriptionEvent(
        "incomplete_expired",
        "customer.subscription.updated",
        tenantId,
      );
      createdAlertEventIds.push(evt.id);

      await post(evt);

      const alerts = await getAlertsByEventId(evt.id);
      expect(alerts).toHaveLength(1);
      expect(sendBillingAlertSlackNotification).toHaveBeenCalledOnce();
    });

    it("customer.subscription.updated to active does NOT trigger the alert", async () => {
      const tenantId = await createTenant({ subscriptionStatus: "past_due" });
      createdTenantIds.push(tenantId);

      const evt = subscriptionEvent(
        "active",
        "customer.subscription.updated",
        tenantId,
      );
      // No alert expected; still track event ID for cleanup safety.
      createdAlertEventIds.push(evt.id);

      const res = await post(evt);
      expect(res.status).toBe(200);

      const alerts = await getAlertsByEventId(evt.id);
      expect(alerts).toHaveLength(0);
      expect(sendBillingAlertSlackNotification).not.toHaveBeenCalled();
    });

    it("customer.subscription.updated to trialing does NOT trigger the alert", async () => {
      const tenantId = await createTenant({ subscriptionStatus: "active" });
      createdTenantIds.push(tenantId);

      const evt = subscriptionEvent(
        "trialing",
        "customer.subscription.updated",
        tenantId,
      );
      createdAlertEventIds.push(evt.id);

      await post(evt);

      const alerts = await getAlertsByEventId(evt.id);
      expect(alerts).toHaveLength(0);
      expect(sendBillingAlertSlackNotification).not.toHaveBeenCalled();
    });

    it("a tenant WITHOUT iframerAccountId does NOT trigger the Slack billing-loss call", async () => {
      const tenantId = await createTenant({
        subscriptionStatus: "active",
        iframerAccountId: null,
      });
      createdTenantIds.push(tenantId);

      const evt = subscriptionEvent(
        "canceled",
        "customer.subscription.deleted",
        tenantId,
      );
      createdAlertEventIds.push(evt.id);

      const res = await post(evt);
      expect(res.status).toBe(200);

      // A stripe_alert row may still be inserted (normal billing path), but
      // the i-Framer-specific Slack call must NOT have been made.
      expect(sendBillingAlertSlackNotification).not.toHaveBeenCalled();
    });

    it("invoice.payment_failed persists an alert and calls Slack for an i-Framer tenant", async () => {
      const iframerAccountId = `ifr-invoice-${uid()}`;
      const cusId = `cus-484-inv-${uid()}`;
      const tenantId = await createTenant({
        subscriptionStatus: "active",
        stripeCustomerId: cusId,
        iframerAccountId,
      });
      createdTenantIds.push(tenantId);

      const evt = invoiceFailedEvent(tenantId, cusId);
      createdAlertEventIds.push(evt.id);

      const res = await post(evt);
      expect(res.status).toBe(200);

      const alerts = await getAlertsByEventId(evt.id);
      expect(alerts).toHaveLength(1);
      expect(sendBillingAlertSlackNotification).toHaveBeenCalledOnce();
      const [callArg] = sendBillingAlertSlackNotification.mock.calls[0] as [
        Record<string, unknown>,
      ];
      expect(callArg?.iframerAccountId).toBe(iframerAccountId);
    });

    it("duplicate Stripe event ID suppresses a second stripe_alert insert (idempotency)", async () => {
      const iframerAccountId = `ifr-dedup-${uid()}`;
      const tenantId = await createTenant({
        subscriptionStatus: "active",
        iframerAccountId,
      });
      createdTenantIds.push(tenantId);

      const sharedEvtId = `evt-484-dedup-${uid()}`;
      const evt = subscriptionEvent(
        "canceled",
        "customer.subscription.deleted",
        tenantId,
        { id: sharedEvtId },
      );
      createdAlertEventIds.push(sharedEvtId);

      // First delivery.
      await post(evt);
      // Second delivery (Stripe redelivery with same event ID).
      await post(evt);

      const alerts = await getAlertsByEventId(sharedEvtId);
      // Only one alert row must exist regardless of the redelivery.
      expect(alerts).toHaveLength(1);
      // Slack called only once — second delivery suppressed.
      expect(sendBillingAlertSlackNotification).toHaveBeenCalledTimes(1);
    });
  },
);
