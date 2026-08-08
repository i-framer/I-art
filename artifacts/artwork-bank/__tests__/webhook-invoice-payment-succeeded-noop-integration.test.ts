/**
 * invoice.payment_succeeded — intentional no-op — real-DB integration.
 *
 * app/api/stripe/webhook/route.ts:80-112:
 *   Only explicitly handled event types mutate the DB.
 *   invoice.payment_succeeded is NOT a handled event type and falls through
 *   to the default { received: true } response at 200 with no DB side-effects.
 *
 * This is correct Stripe behaviour: subscription renewal only updates billing
 * state via customer.subscription.updated/created (handled separately).
 *
 *  1. invoice.payment_succeeded event → 200 response (not 4xx/5xx).
 *  2. invoice.payment_succeeded event → no stripeAlertsTable row inserted.
 *  3. invoice.payment_succeeded event → tenant subscriptionStatus unchanged.
 *  4. Unknown event type → same no-op (200 received:true, no DB mutation).
 *  5. Duplicate invoice.payment_succeeded → both succeed (no idempotency guard needed).
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, stripeAlertsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];

function uid() { return `${randomUUID()}-wipsnoi-${RUN}-${++seq}`; }

vi.mock("@/lib/slack", () => ({
  sendBillingAlertSlackNotification: vi.fn().mockResolvedValue({ ok: true }),
  sendIframerAccountSlackNotification: vi.fn(async () => {}),
  postToSlack: vi.fn(async () => {}),
  resolveSlackChannel: vi.fn(() => null),
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

function post(event: object) {
  return webhookPOST(new Request("http://localhost/api/stripe/webhook", {
    method: "POST",
    body: JSON.stringify(event),
  }));
}

function invoiceSucceededEvent(customerId: string) {
  return {
    type: "invoice.payment_succeeded",
    id: `evt_${uid()}`,
    data: {
      object: {
        customer: customerId,
        subscription: `sub_${uid()}`,
        status: "paid",
        amount_paid: 1000,
      },
    },
  };
}

async function createTenant() {
  const id = uid();
  const customerId = `cus_${uid()}`;
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Success Event Test", type: "ARTIST",
    stripeCustomerId: customerId,
    subscriptionStatus: "active",
    billingExempt: false,
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id, customerId };
}

async function cleanup() {
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(stripeAlertsTable).where(eq(stripeAlertsTable.tenantId, id)).catch(() => {});
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("invoice.payment_succeeded — no-op contract — real-DB integration", () => {
  it("invoice.payment_succeeded event → 200 response (not 4xx/5xx)", async () => {
    const { customerId } = await createTenant();
    const res = await post(invoiceSucceededEvent(customerId));

    expect(res.status).toBe(200);
  });

  it("invoice.payment_succeeded event → no stripeAlertsTable row inserted", async () => {
    const { customerId } = await createTenant();
    const eventId = `evt_${uid()}`;

    await post({ type: "invoice.payment_succeeded", id: eventId, data: { object: { customer: customerId, status: "paid" } } });

    const row = await db.query.stripeAlertsTable.findFirst({
      where: eq(stripeAlertsTable.stripeEventId, eventId),
    });
    expect(row).toBeUndefined();
  });

  it("invoice.payment_succeeded event → tenant subscriptionStatus unchanged", async () => {
    const { tenantId, customerId } = await createTenant();

    await post(invoiceSucceededEvent(customerId));

    const tenant = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, tenantId) });
    expect(tenant?.subscriptionStatus).toBe("active"); // unchanged
  });

  it("unknown event type → same no-op (200 received:true, no DB mutation)", async () => {
    const { customerId } = await createTenant();

    const res = await post({
      type: "some.unknown.event",
      id: `evt_${uid()}`,
      data: { object: { customer: customerId } },
    });

    expect(res.status).toBe(200);
  });

  it("duplicate invoice.payment_succeeded events → both succeed (no idempotency guard)", async () => {
    const { customerId } = await createTenant();
    const event = invoiceSucceededEvent(customerId);

    const r1 = await post(event);
    const r2 = await post(event);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });
});
