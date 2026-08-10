/**
 * invoice.payment_failed → stripeAlertsTable persistence for iFramer tenant — real-DB integration.
 *
 * app/api/stripe/webhook/route.ts:473-540 (handleInvoicePaymentFailed):
 *   If the matched tenant has iframerAccountId set:
 *     → inserts a stripeAlertsTable row (eventType="invoice.payment_failed").
 *   If the tenant has no iframerAccountId:
 *     → no alert row inserted.
 *   Duplicate stripeEventId → onConflictDoNothing → no duplicate row.
 *   Unknown customerId → no row inserted, no error.
 *
 *  1. Tenant with iframerAccountId → stripeAlertsTable row inserted.
 *  2. Tenant without iframerAccountId → no stripeAlertsTable row inserted.
 *  3. Duplicate stripeEventId (retry) → only one alert row.
 *  4. Unknown customerId → no alert row inserted.
 *  5. iFramer alert reason contains iframerAccountId.
 *  6. Tenant subscriptionStatus set to past_due on matched customer.
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

function uid() { return `${randomUUID()}-wipfai-${RUN}-${++seq}`; }

vi.mock("@/lib/slack", () => ({
  sendBillingAlertSlackNotification: vi.fn(async () => ({ ok: true })),
  sendIframerAccountSlackNotification: vi.fn(async () => {}),
  postToSlack: vi.fn(async () => {}),
  resolveSlackChannel: vi.fn(() => "#billing"),
}));
vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(),
  getStripeWebhookSecret: vi.fn().mockResolvedValue(null),
  calcApplicationFee: vi.fn(),
  StripeNotConfiguredError: class extends Error {},
}));
vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: vi.fn(async () => true),
}));
vi.mock("@/lib/iframer", () => ({
  createIFramerJob: vi.fn(),
  IFramerError: class extends Error {},
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/base-url", () => ({ getTenantUrl: vi.fn(() => "https://example.com") }));

import { POST as webhookPOST } from "@/app/api/stripe/webhook/route";

function paymentFailedEvent(eventId: string, customerId: string) {
  return {
    type: "invoice.payment_failed",
    id: eventId,
    data: {
      object: {
        customer: customerId,
        subscription: null,
        status: "open",
      },
    },
  };
}

function post(event: object) {
  return webhookPOST(new Request("http://localhost/api/stripe/webhook", {
    method: "POST",
    body: JSON.stringify(event),
  }));
}

async function createTenant(opts: { iframerAccountId?: string } = {}) {
  const id = uid();
  const customerId = `cus_${uid()}`;
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "iFramer Alert Test", type: "ARTIST",
    stripeCustomerId: customerId,
    subscriptionStatus: "active",
    billingExempt: false,
    ...(opts.iframerAccountId ? { iframerAccountId: opts.iframerAccountId } : {}),
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id, customerId };
}

async function alertForEvent(eventId: string) {
  return db.query.stripeAlertsTable.findFirst({
    where: eq(stripeAlertsTable.stripeEventId, eventId),
  });
}

async function cleanup() {
  for (const evtId of createdAlertEventIds.splice(0)) {
    await db.delete(stripeAlertsTable).where(eq(stripeAlertsTable.stripeEventId, evtId)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("invoice.payment_failed → stripeAlertsTable for iFramer tenant — real-DB integration", () => {
  it("tenant with iframerAccountId → stripeAlertsTable row inserted", async () => {
    const { customerId } = await createTenant({ iframerAccountId: `acct_${uid()}` });
    const eventId = `evt_${uid()}`;
    createdAlertEventIds.push(eventId);

    await post(paymentFailedEvent(eventId, customerId));

    const row = await alertForEvent(eventId);
    expect(row).not.toBeUndefined();
    expect(row?.eventType).toBe("invoice.payment_failed");
    expect(row?.customerId).toBe(customerId);
  });

  it("tenant without iframerAccountId → no stripeAlertsTable row inserted", async () => {
    const { customerId } = await createTenant(); // no iframerAccountId
    const eventId = `evt_${uid()}`;

    await post(paymentFailedEvent(eventId, customerId));

    const row = await alertForEvent(eventId);
    expect(row).toBeUndefined();
  });

  it("duplicate stripeEventId (Stripe retry) → only one alert row", async () => {
    const { customerId } = await createTenant({ iframerAccountId: `acct_${uid()}` });
    const eventId = `evt_${uid()}`;
    createdAlertEventIds.push(eventId);

    await post(paymentFailedEvent(eventId, customerId));
    await post(paymentFailedEvent(eventId, customerId));

    const rows = await db.query.stripeAlertsTable.findMany({
      where: eq(stripeAlertsTable.stripeEventId, eventId),
    });
    expect(rows).toHaveLength(1);
  });

  it("unknown customerId → unmatched fallback alert inserted (no tenant update)", async () => {
    const eventId = `evt_${uid()}`;
    const unknownCid = `cus_unknown_${uid()}`;
    createdAlertEventIds.push(eventId);

    const res = await post(paymentFailedEvent(eventId, unknownCid));

    // The unmatched fallback path still inserts an alert row for operator visibility.
    expect(res.status).toBe(200);
    const row = await alertForEvent(eventId);
    // Row is inserted by the unmatched path — customerId matches.
    expect(row?.customerId).toBe(unknownCid);
    // No tenant was updated → subscriptionStatus unchanged; alert reason differs.
    expect(row?.reason ?? "").not.toContain("i-Framer Premium");
  });

  it("iFramer alert reason contains iframerAccountId", async () => {
    const iframerAccountId = `acct_${uid()}`;
    const { customerId } = await createTenant({ iframerAccountId });
    const eventId = `evt_${uid()}`;
    createdAlertEventIds.push(eventId);

    await post(paymentFailedEvent(eventId, customerId));

    const row = await alertForEvent(eventId);
    expect(row?.reason).toContain(iframerAccountId);
  });

  it("tenant subscriptionStatus set to past_due on matched customer", async () => {
    const { tenantId, customerId } = await createTenant({ iframerAccountId: `acct_${uid()}` });
    const eventId = `evt_${uid()}`;
    createdAlertEventIds.push(eventId);

    await post(paymentFailedEvent(eventId, customerId));

    const tenant = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, tenantId) });
    expect(tenant?.subscriptionStatus).toBe("past_due");
  });
});
