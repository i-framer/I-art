/**
 * invoice.payment_failed — iFramer-linked tenant billing-loss alert — real-DB integration.
 *
 * app/api/stripe/webhook/route.ts handles invoice.payment_failed.
 * When tenant has iframerAccountId AND payment fails:
 *   - Tenant subscriptionStatus → past_due.
 *   - A stripeAlerts row is inserted with iframerAccountId-specific reason.
 *   - Slack notification fires with iframerAccountId in the payload.
 *
 * Existing iframer-account-integration.test.ts covers action persistence.
 * This covers the webhook-triggered billing-loss alert path.
 *
 *  1. iFramer tenant payment failure creates a stripeAlerts row.
 *  2. Alert reason mentions iframerAccountId.
 *  3. Tenant subscriptionStatus is set to past_due.
 *  4. Duplicate event delivery does not create a second alert row.
 *  5. Non-iFramer tenant payment failure does NOT create a stripeAlerts row (distinct from iFramer path).
 *  6. Alert row has the correct stripeEventId.
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

function uid() { return `${randomUUID()}-wpfia-${RUN}-${++seq}`; }

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
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "iFramer Payment Failed Test", type: "FRAMER",
    billingExempt: false,
    stripeCustomerId: customerId,
    subscriptionStatus: "active",
    ...(iframerAccountId ? { iframerAccountId } : {}),
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id, customerId };
}

function paymentFailedEvent(eventId: string, customerId: string, tenantId: string) {
  return {
    type: "invoice.payment_failed",
    id: eventId,
    data: {
      object: {
        customer: customerId,
        subscription: `sub_${uid()}`,
        metadata: { billingTenantId: tenantId },
      },
    },
  };
}

async function alertByEventId(eventId: string) {
  return db.query.stripeAlertsTable.findFirst({ where: eq(stripeAlertsTable.stripeEventId, eventId) });
}

async function tenantStatus(tenantId: string) {
  const row = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, tenantId) });
  return row?.subscriptionStatus;
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

describeIntegration("invoice.payment_failed — iFramer billing-loss alert — real-DB integration", () => {
  it("iFramer tenant payment failure creates a stripeAlerts row", async () => {
    const iframerAccountId = `ifr_${uid()}`;
    const { tenantId, customerId } = await createTenant(iframerAccountId);
    const eventId = `evt_${uid()}`;
    createdAlertEventIds.push(eventId);

    const res = await post(paymentFailedEvent(eventId, customerId, tenantId));
    expect(res.status).toBe(200);

    const alert = await alertByEventId(eventId);
    expect(alert).not.toBeUndefined();
  });

  it("alert reason mentions iframerAccountId", async () => {
    const iframerAccountId = `ifr_acct_${uid()}`;
    const { tenantId, customerId } = await createTenant(iframerAccountId);
    const eventId = `evt_${uid()}`;
    createdAlertEventIds.push(eventId);

    await post(paymentFailedEvent(eventId, customerId, tenantId));

    const alert = await alertByEventId(eventId);
    expect(alert?.reason).toContain(iframerAccountId);
  });

  it("tenant subscriptionStatus is set to past_due after iFramer payment failure", async () => {
    const iframerAccountId = `ifr_${uid()}`;
    const { tenantId, customerId } = await createTenant(iframerAccountId);
    const eventId = `evt_${uid()}`;
    createdAlertEventIds.push(eventId);

    await post(paymentFailedEvent(eventId, customerId, tenantId));

    expect(await tenantStatus(tenantId)).toBe("past_due");
  });

  it("duplicate event delivery does not create a second alert row", async () => {
    const iframerAccountId = `ifr_${uid()}`;
    const { tenantId, customerId } = await createTenant(iframerAccountId);
    const eventId = `evt_${uid()}`;
    createdAlertEventIds.push(eventId);

    await post(paymentFailedEvent(eventId, customerId, tenantId));
    await post(paymentFailedEvent(eventId, customerId, tenantId)); // duplicate

    const alerts = await db.query.stripeAlertsTable.findMany({
      where: eq(stripeAlertsTable.stripeEventId, eventId),
    });
    expect(alerts).toHaveLength(1);
  });

  it("non-iFramer tenant payment failure does NOT create a stripeAlerts row", async () => {
    const { tenantId, customerId } = await createTenant(); // no iframerAccountId
    const eventId = `evt_${uid()}`;
    createdAlertEventIds.push(eventId);

    const res = await post(paymentFailedEvent(eventId, customerId, tenantId));
    expect(res.status).toBe(200);

    const alert = await alertByEventId(eventId);
    expect(alert).toBeUndefined();
  });

  it("alert row has the correct stripeEventId", async () => {
    const iframerAccountId = `ifr_${uid()}`;
    const { tenantId, customerId } = await createTenant(iframerAccountId);
    const eventId = `evt_event_id_check_${uid()}`;
    createdAlertEventIds.push(eventId);

    await post(paymentFailedEvent(eventId, customerId, tenantId));

    const alert = await alertByEventId(eventId);
    expect(alert?.stripeEventId).toBe(eventId);
  });
});
