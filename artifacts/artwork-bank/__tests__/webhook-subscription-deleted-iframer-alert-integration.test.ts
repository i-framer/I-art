/**
 * customer.subscription.deleted — iFramer billing-loss alert — real-DB integration.
 *
 * app/api/stripe/webhook/route.ts:handleSubscriptionEvent:
 *   When a matched iFramer-linked tenant reaches a BILLING_LOSS_STATUSES (canceled,
 *   past_due, unpaid, incomplete_expired, paused), an alert row is inserted into
 *   stripeAlertsTable and Slack is notified.
 *   customer.subscription.deleted delivers status="canceled".
 *
 *  1. subscription.deleted for iFramer tenant creates a stripeAlerts row.
 *  2. Alert row has correct subscriptionId.
 *  3. Alert row has correct reason mentioning iframerAccountId.
 *  4. Duplicate event delivery (same eventId) does not create a second alert row.
 *  5. Non-iFramer tenant cancellation does NOT create an alert row.
 *  6. Tenant subscriptionStatus is set to "canceled" on deletion.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, stripeAlertsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdAlertEventIds: string[] = [];

function uid() { return `${randomUUID()}-wsdia-${RUN}-${++seq}`; }

vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(),
  getStripeWebhookSecret: vi.fn().mockResolvedValue(null),
  calcApplicationFee: vi.fn(),
  StripeNotConfiguredError: class extends Error {},
}));
vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: vi.fn(async () => true),
  sendBillingAlertNotification: vi.fn(),
}));
vi.mock("@/lib/slack", () => ({
  sendBillingAlertSlackNotification: vi.fn().mockResolvedValue({ ok: true }),
  sendIframerAccountSlackNotification: vi.fn(async () => {}),
  postToSlack: vi.fn(async () => {}),
}));
vi.mock("@/lib/iframer", () => ({
  createIFramerJob: vi.fn(),
  IFramerError: class extends Error {},
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));
vi.mock("@/lib/base-url", () => ({
  getTenantUrl: vi.fn(() => "https://example.com"),
}));

import { POST as webhookPOST } from "@/app/api/stripe/webhook/route";

function post(event: object) {
  return webhookPOST(
    new Request("http://localhost/api/stripe/webhook", {
      method: "POST",
      body: JSON.stringify(event),
    }),
  );
}

async function createTenant(iframerAccountId?: string) {
  const id = uid();
  const customerId = `cus_${uid()}`;
  const subId = `sub_${uid()}`;
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Sub Deleted Alert Test", type: "FRAMER",
    billingExempt: false,
    stripeCustomerId: customerId,
    stripeSubscriptionId: subId,
    subscriptionStatus: "active",
    ...(iframerAccountId ? { iframerAccountId } : {}),
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id, customerId, subId };
}

function subscriptionDeletedEvent(eventId: string, customerId: string, subscriptionId: string, tenantId: string) {
  return {
    type: "customer.subscription.deleted",
    id: eventId,
    data: {
      object: {
        id: subscriptionId,
        object: "subscription",
        status: "canceled",
        customer: customerId,
        trial_end: null,
        metadata: { billingTenantId: tenantId },
      },
    },
  };
}

async function alertsByEventId(eventId: string) {
  return db.query.stripeAlertsTable.findMany({ where: eq(stripeAlertsTable.stripeEventId, eventId) });
}

async function cleanup() {
  for (const eventId of createdAlertEventIds.splice(0)) {
    await db.delete(stripeAlertsTable).where(eq(stripeAlertsTable.stripeEventId, eventId)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("subscription.deleted iFramer billing-loss alert — real-DB integration", () => {
  it("subscription.deleted for iFramer tenant creates a stripeAlerts row", async () => {
    const iframerAcctId = `ifr_${uid()}`;
    const { tenantId, customerId, subId } = await createTenant(iframerAcctId);
    const eventId = `evt_${uid()}`;
    createdAlertEventIds.push(eventId);

    const res = await post(subscriptionDeletedEvent(eventId, customerId, subId, tenantId));
    expect(res.status).toBe(200);

    const alerts = await alertsByEventId(eventId);
    expect(alerts).toHaveLength(1);
  });

  it("alert row has the correct subscriptionId", async () => {
    const iframerAcctId = `ifr_${uid()}`;
    const { tenantId, customerId, subId } = await createTenant(iframerAcctId);
    const eventId = `evt_${uid()}`;
    createdAlertEventIds.push(eventId);

    await post(subscriptionDeletedEvent(eventId, customerId, subId, tenantId));

    const [alert] = await alertsByEventId(eventId);
    expect(alert?.subscriptionId).toBe(subId);
  });

  it("alert row reason mentions iframerAccountId", async () => {
    const iframerAcctId = `ifr_acc_${uid()}`;
    const { tenantId, customerId, subId } = await createTenant(iframerAcctId);
    const eventId = `evt_${uid()}`;
    createdAlertEventIds.push(eventId);

    await post(subscriptionDeletedEvent(eventId, customerId, subId, tenantId));

    const [alert] = await alertsByEventId(eventId);
    expect(alert?.reason).toContain(iframerAcctId);
  });

  it("duplicate event delivery (same eventId) does not create a second alert row", async () => {
    const iframerAcctId = `ifr_${uid()}`;
    const { tenantId, customerId, subId } = await createTenant(iframerAcctId);
    const eventId = `evt_${uid()}`;
    createdAlertEventIds.push(eventId);

    await post(subscriptionDeletedEvent(eventId, customerId, subId, tenantId));
    await post(subscriptionDeletedEvent(eventId, customerId, subId, tenantId)); // duplicate

    const alerts = await alertsByEventId(eventId);
    expect(alerts).toHaveLength(1);
  });

  it("non-iFramer tenant cancellation does NOT create an alert row", async () => {
    const { tenantId, customerId, subId } = await createTenant(); // no iframerAccountId
    const eventId = `evt_${uid()}`;
    createdAlertEventIds.push(eventId);

    const res = await post(subscriptionDeletedEvent(eventId, customerId, subId, tenantId));
    expect(res.status).toBe(200);

    const alerts = await alertsByEventId(eventId);
    expect(alerts).toHaveLength(0);
  });

  it("tenant subscriptionStatus is set to 'canceled' on subscription deletion", async () => {
    const iframerAcctId = `ifr_${uid()}`;
    const { tenantId, customerId, subId } = await createTenant(iframerAcctId);
    const eventId = `evt_${uid()}`;
    createdAlertEventIds.push(eventId);

    await post(subscriptionDeletedEvent(eventId, customerId, subId, tenantId));

    const row = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, tenantId) });
    expect(row?.subscriptionStatus).toBe("canceled");
  });
});
