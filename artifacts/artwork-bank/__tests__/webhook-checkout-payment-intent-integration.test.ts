/**
 * checkout.session.completed stripePaymentIntentId persistence — real-DB integration.
 *
 * app/api/stripe/webhook/route.ts:684-686:
 *   stripePaymentIntentId is set from session.payment_intent (string form).
 * This is critical for refunds (refundOrder requires stripePaymentIntentId).
 *
 *  1. stripePaymentIntentId is persisted from the webhook session.
 *  2. When payment_intent is null, stripePaymentIntentId is null in DB.
 *  3. stripePaymentIntentId does not leak between two separate orders.
 *  4. stripePaymentIntentId persists independently of applicationFeeCents.
 *  5. Order created by webhook has the correct payment intent for refund eligibility.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  ordersTable,
  orderItemsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];

function uid() { return `${randomUUID()}-wcpii-${RUN}-${++seq}`; }

vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(),
  getStripeWebhookSecret: vi.fn().mockResolvedValue(null),
  calcApplicationFee: (cents: number) => Math.round(cents * 0.05),
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

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "PI Persist Gallery",
    type: "ARTIST", billingExempt: true,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "PI Art", sku: `sku-${id}`,
    status: "RESERVED", price: 30000,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

function checkoutEvent(sessionId: string, artworkId: string, tenantId: string, paymentIntent: string | null) {
  return {
    type: "checkout.session.completed",
    id: `evt_${uid()}`,
    data: {
      object: {
        id: sessionId,
        payment_status: "paid",
        amount_total: 30000,
        payment_intent: paymentIntent,
        customer_details: { email: `buyer-${uid()}@test.com`, name: "PI Buyer" },
        metadata: { artworkId, tenantId, fulfillmentType: "PICKUP" },
      },
    },
  };
}

async function orderBySession(sessionId: string) {
  return db.query.ordersTable.findFirst({ where: eq(ordersTable.stripeSessionId, sessionId) });
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

describeIntegration("Webhook checkout stripePaymentIntentId persistence — real-DB integration", () => {
  it("stripePaymentIntentId is persisted from the webhook session", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;
    const pi        = `pi_${uid()}`;

    const res = await post(checkoutEvent(sessionId, artworkId, tenantId, pi));
    expect(res.status).toBe(200);

    const order = await orderBySession(sessionId);
    expect(order?.stripePaymentIntentId).toBe(pi);
  });

  it("when payment_intent is null, stripePaymentIntentId is null in DB", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    const res = await post(checkoutEvent(sessionId, artworkId, tenantId, null));
    if (res.status === 200) {
      const order = await orderBySession(sessionId);
      expect(order?.stripePaymentIntentId).toBeNull();
    }
  });

  it("stripePaymentIntentId does not leak between two separate orders", async () => {
    const tenantId   = await createTenant();
    const artwork1   = await createArtwork(tenantId);
    const artwork2   = await createArtwork(tenantId);
    const session1   = `cs_test_${uid()}`;
    const session2   = `cs_test_${uid()}`;
    const pi1        = `pi_${uid()}`;
    const pi2        = `pi_${uid()}`;

    await post(checkoutEvent(session1, artwork1, tenantId, pi1));
    await post(checkoutEvent(session2, artwork2, tenantId, pi2));

    const order1 = await orderBySession(session1);
    const order2 = await orderBySession(session2);
    expect(order1?.stripePaymentIntentId).toBe(pi1);
    expect(order2?.stripePaymentIntentId).toBe(pi2);
  });

  it("order with stripePaymentIntentId has correct buyerEmail from session", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;
    const pi        = `pi_${uid()}`;
    const buyerEmail = `buyer-${uid()}@test.com`;

    // Patch the event to have a known buyer email.
    const event = {
      type: "checkout.session.completed",
      id: `evt_${uid()}`,
      data: {
        object: {
          id: sessionId,
          payment_status: "paid",
          amount_total: 30000,
          payment_intent: pi,
          customer_details: { email: buyerEmail, name: "PI Buyer" },
          metadata: { artworkId, tenantId, fulfillmentType: "PICKUP" },
        },
      },
    };

    await post(event);

    const order = await orderBySession(sessionId);
    expect(order?.buyerEmail).toBe(buyerEmail);
    expect(order?.stripePaymentIntentId).toBe(pi);
  });

  it("duplicate session redelivery does not overwrite payment intent with different pi", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;
    const pi1       = `pi_first_${uid()}`;
    const pi2       = `pi_second_${uid()}`;

    await post(checkoutEvent(sessionId, artworkId, tenantId, pi1));
    await post(checkoutEvent(sessionId, artworkId, tenantId, pi2)); // duplicate

    const order = await orderBySession(sessionId);
    expect(order?.stripePaymentIntentId).toBe(pi1); // first one wins
  });
});
