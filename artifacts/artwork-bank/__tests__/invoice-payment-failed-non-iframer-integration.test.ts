/**
 * invoice.payment_failed for non-iFramer tenant — real-DB integration.
 *
 * app/api/stripe/webhook/route.ts:473-545:
 *   handleInvoicePaymentFailed sets subscriptionStatus = past_due for
 *   ANY matched tenant (not just i-Framer ones). The i-Framer-only path is
 *   the Slack alert; the status update applies to all tenants.
 *
 *  1. Non-iFramer tenant (no iframerAccountId) gets past_due on payment fail.
 *  2. already-past_due tenant stays past_due (idempotent).
 *  3. canceled tenant is NOT set to past_due (cancel guard).
 *  4. Non-matching customerId leaves tenant unchanged.
 *  5. Non-iFramer tenant failure does NOT create a stripeAlerts row.
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

function uid() { return `${randomUUID()}-ipfni-${RUN}-${++seq}`; }

vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(),
  getStripeWebhookSecret: vi.fn().mockResolvedValue(null),
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

function invoiceFailedEvent(eventId: string, customerId: string) {
  return {
    type: "invoice.payment_failed",
    id: eventId,
    data: {
      object: {
        id: `in_${uid()}`,
        customer: customerId,
        subscription: `sub_${uid()}`,
        attempt_count: 1,
        amount_due: 3000,
      },
    },
  };
}

async function createTenant(opts: {
  subscriptionStatus?: string;
  iframerAccountId?: string | null;
} = {}) {
  const id = uid();
  const customerId = `cus_${uid()}`;
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Non-iFramer Billing Test", type: "ARTIST",
    subscriptionStatus: opts.subscriptionStatus ?? "active",
    stripeCustomerId: customerId,
    stripeSubscriptionId: `sub_${uid()}`,
    iframerAccountId: opts.iframerAccountId === undefined ? null : opts.iframerAccountId,
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id, customerId };
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

describeIntegration("invoice.payment_failed for non-iFramer tenant — real-DB integration", () => {
  it("non-iFramer tenant gets past_due on payment failure", async () => {
    const { tenantId, customerId } = await createTenant({ iframerAccountId: null });
    const eventId = `evt_${uid()}`;

    const res = await post(invoiceFailedEvent(eventId, customerId));
    expect(res.status).toBe(200);

    expect(await tenantStatus(tenantId)).toBe("past_due");
  });

  it("already-past_due tenant stays past_due (idempotent)", async () => {
    const { tenantId, customerId } = await createTenant({
      subscriptionStatus: "past_due",
      iframerAccountId: null,
    });
    const eventId = `evt_${uid()}`;

    await post(invoiceFailedEvent(eventId, customerId));

    expect(await tenantStatus(tenantId)).toBe("past_due");
  });

  it("canceled tenant is NOT set to past_due (cancel guard enforced)", async () => {
    const { tenantId, customerId } = await createTenant({
      subscriptionStatus: "canceled",
      iframerAccountId: null,
    });
    const eventId = `evt_${uid()}`;

    await post(invoiceFailedEvent(eventId, customerId));

    expect(await tenantStatus(tenantId)).toBe("canceled"); // unchanged
  });

  it("non-matching customerId leaves tenant status unchanged", async () => {
    const { tenantId } = await createTenant({ iframerAccountId: null });
    const eventId = `evt_${uid()}`;

    await post(invoiceFailedEvent(eventId, `cus_nomatch_${uid()}`));

    expect(await tenantStatus(tenantId)).toBe("active"); // unchanged
  });

  it("non-iFramer tenant failure does NOT create a stripeAlerts row", async () => {
    const { customerId } = await createTenant({ iframerAccountId: null });
    const eventId = `evt_${uid()}`;

    await post(invoiceFailedEvent(eventId, customerId));

    const alerts = await db.query.stripeAlertsTable.findMany({
      where: eq(stripeAlertsTable.stripeEventId, eventId),
    });
    expect(alerts).toHaveLength(0);
  });
});
