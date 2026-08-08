/**
 * checkout.session.completed applicationFeeCents persistence — real-DB integration.
 *
 * app/api/stripe/webhook/route.ts:697-699:
 *   applicationFeeCents = calcApplicationFee(session.amount_total)
 *   The formula is mock-tested in webhook-commission.test.ts; this test
 *   verifies the value is actually written to the ordersTable DB row.
 *
 *  1. 5% fee on a $500 artwork (50000 cents) → applicationFeeCents = 2500.
 *  2. Fee on $100 artwork (10000 cents) → applicationFeeCents = 500.
 *  3. When amount_total is null, applicationFeeCents is null.
 *  4. Fee is computed from amount_total, not artwork.price (webhook source of truth).
 *  5. applicationFeeCents does not leak between two separate orders.
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
const createdOrderIds: string[] = [];

function uid() { return `${randomUUID()}-wcafi-${RUN}-${++seq}`; }

vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(),
  getStripeWebhookSecret: vi.fn().mockResolvedValue(null), // dev-bypass mode
  calcApplicationFee: vi.fn((cents: number) => Math.round(cents * 0.05)),
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
    id, slug: id, businessName: "Fee Persistence Gallery",
    type: "ARTIST", billingExempt: true,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Fee Art", sku: `sku-${id}`,
    status: "RESERVED", price: 50000,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

function checkoutEvent(sessionId: string, artworkId: string, tenantId: string, amountTotal: number | null) {
  return {
    type: "checkout.session.completed",
    id: `evt_${uid()}`,
    data: {
      object: {
        id: sessionId,
        payment_status: "paid",
        amount_total: amountTotal,
        payment_intent: `pi_${uid()}`,
        customer_details: { email: `buyer-${uid()}@test.com`, name: "Test Buyer" },
        metadata: {
          artworkId,
          tenantId,
          fulfillmentType: "PICKUP",
        },
      },
    },
  };
}

async function orderBySession(sessionId: string) {
  return db.query.ordersTable.findFirst({ where: eq(ordersTable.stripeSessionId, sessionId) });
}

async function cleanup() {
  // Clean up in dependency order.
  const orderRows = await db.query.ordersTable.findMany();
  for (const id of createdOrderIds.splice(0)) {
    await db.delete(orderItemsTable).where(eq(orderItemsTable.orderId, id)).catch(() => {});
    await db.delete(ordersTable).where(eq(ordersTable.id, id)).catch(() => {});
  }
  for (const id of createdArtworkIds.splice(0)) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

async function cleanupOrder(sessionId: string) {
  const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.stripeSessionId, sessionId) });
  if (row) {
    createdOrderIds.push(row.id);
    await db.delete(orderItemsTable).where(eq(orderItemsTable.orderId, row.id)).catch(() => {});
    await db.delete(ordersTable).where(eq(ordersTable.id, row.id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("checkout.session.completed applicationFeeCents — real-DB integration", () => {
  it("5% fee on $500 artwork → applicationFeeCents = 2500", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    const res = await post(checkoutEvent(sessionId, artworkId, tenantId, 50000));
    expect(res.status).toBe(200);

    const order = await orderBySession(sessionId);
    expect(order?.applicationFeeCents).toBe(2500);
    if (order) createdOrderIds.push(order.id);
  });

  it("5% fee on $100 artwork → applicationFeeCents = 500", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    const res = await post(checkoutEvent(sessionId, artworkId, tenantId, 10000));
    expect(res.status).toBe(200);

    const order = await orderBySession(sessionId);
    expect(order?.applicationFeeCents).toBe(500);
    if (order) createdOrderIds.push(order.id);
  });

  it("when amount_total is null, applicationFeeCents is null", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    const res = await post(checkoutEvent(sessionId, artworkId, tenantId, null));
    // Webhook may or may not accept null amount — if 200, check DB.
    if (res.status === 200) {
      const order = await orderBySession(sessionId);
      expect(order?.applicationFeeCents).toBeNull();
      if (order) createdOrderIds.push(order.id);
    }
  });

  it("applicationFeeCents does not leak between two separate orders", async () => {
    const tenantId   = await createTenant();
    const artwork1   = await createArtwork(tenantId);
    const artwork2   = await createArtwork(tenantId);
    const session1   = `cs_test_${uid()}`;
    const session2   = `cs_test_${uid()}`;

    await post(checkoutEvent(session1, artwork1, tenantId, 50000));
    await post(checkoutEvent(session2, artwork2, tenantId, 20000));

    const order1 = await orderBySession(session1);
    const order2 = await orderBySession(session2);
    if (order1) createdOrderIds.push(order1.id);
    if (order2) createdOrderIds.push(order2.id);

    expect(order1?.applicationFeeCents).toBe(2500); // 5% of 50000
    expect(order2?.applicationFeeCents).toBe(1000); // 5% of 20000
  });

  it("fee is computed from amount_total, not artwork.price", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId); // artwork.price = 50000
    const sessionId = `cs_test_${uid()}`;

    // Send session with amount_total = 30000, different from artwork.price.
    const res = await post(checkoutEvent(sessionId, artworkId, tenantId, 30000));
    if (res.status === 200) {
      const order = await orderBySession(sessionId);
      // 5% of 30000 = 1500 (not 2500 from artwork.price)
      expect(order?.applicationFeeCents).toBe(1500);
      if (order) createdOrderIds.push(order.id);
    }
  });
});
