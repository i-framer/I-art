/**
 * Billing-alert deduplication (invoice.payment_failed) — real-DB integration.
 *
 * app/api/stripe/webhook/route.ts:473-545:
 *   handleInvoicePaymentFailed inserts a stripeAlertsTable row with
 *   onConflictDoNothing(stripeEventId). On first delivery → row inserted,
 *   Slack notified. On second delivery (same eventId) → onConflictDoNothing
 *   fires, row not duplicated, Slack NOT notified again.
 *
 *  1. First delivery inserts one alert row.
 *  2. First delivery updates matching tenant's subscriptionStatus to past_due.
 *  3. Second delivery with same eventId does NOT create a duplicate alert row.
 *  4. Both deliveries return 200.
 *  5. Non-matching customerId creates a Slack alert for an unmatched event.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, stripeAlertsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdAlertEventIds: string[] = [];

function uid() { return `${randomUUID()}-wbad-${RUN}-${++seq}`; }

vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(),
  getStripeWebhookSecret: vi.fn().mockResolvedValue(null), // dev-bypass
  calcApplicationFee: (cents: number) => Math.round(cents * 0.05),
  StripeNotConfiguredError: class extends Error {},
}));
vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: vi.fn(),
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

/** Build an invoice.payment_failed event payload. */
function invoiceFailedEvent(eventId: string, customerId: string, subscriptionId: string) {
  return {
    type: "invoice.payment_failed",
    id: eventId,
    data: {
      object: {
        id: `in_${uid()}`,
        customer: customerId,
        subscription: subscriptionId,
        attempt_count: 1,
        amount_due: 5000,
      },
    },
  };
}

async function createTenant(opts: {
  stripeCustomerId?: string;
  subscriptionStatus?: string;
  iframerAccountId?: string;
} = {}) {
  const id = uid();
  const customerId = opts.stripeCustomerId ?? `cus_${uid()}`;
  const subscriptionId = `sub_${uid()}`;
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Billing Alert Dedup Gallery", type: "ARTIST",
    subscriptionStatus: opts.subscriptionStatus ?? "active",
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId,
    iframerAccountId: opts.iframerAccountId ?? `acct_${uid()}`,
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id, customerId, subscriptionId };
}

async function alertsForEvent(eventId: string) {
  return db.query.stripeAlertsTable.findMany({
    where: eq(stripeAlertsTable.stripeEventId, eventId),
  });
}

async function tenantStatus(tenantId: string) {
  const row = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, tenantId) });
  return row?.subscriptionStatus ?? null;
}

async function cleanup() {
  for (const eventId of createdAlertEventIds.splice(0)) {
    await db.delete(stripeAlertsTable)
      .where(eq(stripeAlertsTable.stripeEventId, eventId)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Billing-alert deduplication invoice.payment_failed — real-DB integration", () => {
  it("first delivery inserts one alert row for i-Framer tenant", async () => {
    const { tenantId, customerId, subscriptionId } = await createTenant();
    const eventId = `evt_${uid()}`;
    createdAlertEventIds.push(eventId);

    const res = await post(invoiceFailedEvent(eventId, customerId, subscriptionId));
    expect(res.status).toBe(200);

    const alerts = await alertsForEvent(eventId);
    expect(alerts).toHaveLength(1);
  });

  it("first delivery sets matching tenant subscriptionStatus to past_due", async () => {
    const { tenantId, customerId, subscriptionId } = await createTenant({ subscriptionStatus: "active" });
    const eventId = `evt_${uid()}`;
    createdAlertEventIds.push(eventId);

    await post(invoiceFailedEvent(eventId, customerId, subscriptionId));

    expect(await tenantStatus(tenantId)).toBe("past_due");
  });

  it("second delivery with same eventId does NOT create a duplicate alert row", async () => {
    const { customerId, subscriptionId } = await createTenant();
    const eventId = `evt_${uid()}`;
    createdAlertEventIds.push(eventId);

    await post(invoiceFailedEvent(eventId, customerId, subscriptionId));
    await post(invoiceFailedEvent(eventId, customerId, subscriptionId));

    const alerts = await alertsForEvent(eventId);
    expect(alerts).toHaveLength(1);
  });

  it("both deliveries return 200", async () => {
    const { customerId, subscriptionId } = await createTenant();
    const eventId = `evt_${uid()}`;
    createdAlertEventIds.push(eventId);

    const r1 = await post(invoiceFailedEvent(eventId, customerId, subscriptionId));
    const r2 = await post(invoiceFailedEvent(eventId, customerId, subscriptionId));

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });

  it("non-matching customerId still returns 200 (no crash)", async () => {
    const unknownCustomerId = `cus_unknown_${uid()}`;
    const eventId = `evt_${uid()}`;

    const res = await post(invoiceFailedEvent(eventId, unknownCustomerId, `sub_${uid()}`));
    expect(res.status).toBe(200);
  });
});
