/**
 * checkout.session.completed — null payment_intent — real-DB integration.
 *
 * app/api/stripe/webhook/route.ts:684-687:
 *   stripePaymentIntentId: typeof session.payment_intent === "string"
 *     ? session.payment_intent : null
 *   → when payment_intent is null or an object, stripePaymentIntentId is null.
 *
 *  1. null payment_intent → order created with stripePaymentIntentId=null.
 *  2. String payment_intent → order created with stripePaymentIntentId=that string.
 *  3. Object payment_intent (non-string) → stripePaymentIntentId=null.
 *  4. null payment_intent → artwork still set to SOLD.
 *  5. null payment_intent → order has status=PAID.
 *  6. Idempotent: duplicate null-payment-intent event → only one order.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db, tenantsTable, artworksTable, ordersTable, orderItemsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];

function uid() { return `${randomUUID()}-wcnpii-${RUN}-${++seq}`; }

vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(),
  getStripeWebhookSecret: vi.fn().mockResolvedValue(null),
  calcApplicationFee: vi.fn((cents: number) => Math.round(cents * 0.05)),
  StripeNotConfiguredError: class extends Error {},
}));
vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: vi.fn(async () => true),
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
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/base-url", () => ({ getTenantUrl: vi.fn(() => "https://example.com") }));

import { POST as webhookPOST } from "@/app/api/stripe/webhook/route";

function post(event: object) {
  return webhookPOST(new Request("http://localhost/api/stripe/webhook", {
    method: "POST",
    body: JSON.stringify(event),
  }));
}

function checkoutEvent(sessionId: string, artworkId: string, tenantId: string, paymentIntent: any) {
  return {
    type: "checkout.session.completed",
    id: `evt_${uid()}`,
    data: {
      object: {
        id: sessionId,
        payment_status: "paid",
        amount_total: 20000,
        payment_intent: paymentIntent,
        customer_details: { email: `buyer-${uid()}@test.com`, name: "Buyer" },
        metadata: { artworkId, tenantId, fulfillmentType: "PICKUP" },
      },
    },
  };
}

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({ id, slug: id, businessName: "PI Test", type: "ARTIST", billingExempt: true } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({ id, tenantId, title: "PI Test Art", sku: `sku-${id}`, status: "RESERVED", price: 20000, showInGallery: true } as any);
  createdArtworkIds.push(id);
  return id;
}

async function orderBySession(sessionId: string) {
  return db.query.ordersTable.findFirst({ where: eq(ordersTable.stripeSessionId, sessionId) });
}

async function artworkStatus(artworkId: string) {
  return (await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, artworkId) }))?.status;
}

async function cleanup() {
  for (const artworkId of createdArtworkIds) {
    const items = await db.query.orderItemsTable.findMany({ where: eq(orderItemsTable.artworkId, artworkId) });
    for (const item of items) {
      await db.delete(orderItemsTable).where(eq(orderItemsTable.id, item.id)).catch(() => {});
      await db.delete(ordersTable).where(eq(ordersTable.id, item.orderId)).catch(() => {});
    }
  }
  for (const id of createdArtworkIds.splice(0)) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Checkout null payment_intent persistence — real-DB integration", () => {
  it("null payment_intent → order created with stripePaymentIntentId=null", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    await post(checkoutEvent(sessionId, artworkId, tenantId, null));

    const order = await orderBySession(sessionId);
    expect(order).not.toBeUndefined();
    expect(order?.stripePaymentIntentId).toBeNull();
  });

  it("string payment_intent → order created with stripePaymentIntentId=that string", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;
    const pi        = `pi_${uid()}`;

    await post(checkoutEvent(sessionId, artworkId, tenantId, pi));

    const order = await orderBySession(sessionId);
    expect(order?.stripePaymentIntentId).toBe(pi);
  });

  it("object payment_intent (non-string) → stripePaymentIntentId=null", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    await post(checkoutEvent(sessionId, artworkId, tenantId, { id: `pi_${uid()}` }));

    const order = await orderBySession(sessionId);
    expect(order?.stripePaymentIntentId).toBeNull();
  });

  it("null payment_intent → artwork still set to SOLD", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    await post(checkoutEvent(sessionId, artworkId, tenantId, null));

    expect(await artworkStatus(artworkId)).toBe("SOLD");
  });

  it("null payment_intent → order has status=PAID", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    await post(checkoutEvent(sessionId, artworkId, tenantId, null));

    const order = await orderBySession(sessionId);
    expect(order?.status).toBe("PAID");
  });

  it("duplicate null-payment-intent event → only one order (idempotent)", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    await post(checkoutEvent(sessionId, artworkId, tenantId, null));
    await post(checkoutEvent(sessionId, artworkId, tenantId, null));

    const rows = await db.query.ordersTable.findMany({ where: eq(ordersTable.stripeSessionId, sessionId) });
    expect(rows).toHaveLength(1);
  });
});
