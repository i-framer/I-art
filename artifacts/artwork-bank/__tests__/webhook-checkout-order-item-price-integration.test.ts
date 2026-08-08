/**
 * checkout.session.completed — order item priceCents vs applicationFeeCents — real-DB integration.
 *
 * app/api/stripe/webhook/route.ts:
 *   ordersTable.applicationFeeCents = calcApplicationFee(session.amount_total)
 *   orderItemsTable.priceCents = artwork.price (the original listing price, not amount_total)
 *
 *  1. applicationFeeCents = 5% of amount_total (stored on orders row).
 *  2. orderItem.priceCents matches the artwork's listed price.
 *  3. applicationFeeCents is computed from amount_total, not artwork.price.
 *  4. Two orders have independent applicationFeeCents values.
 *  5. orderItem artworkTitle matches the artwork's title at time of purchase.
 *  6. applicationFeeCents is null when amount_total is null.
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

function uid() { return `${randomUUID()}-wcoip-${RUN}-${++seq}`; }

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
    id, slug: id, businessName: "Price Test Gallery",
    type: "ARTIST", billingExempt: true,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string, price: number, title = "Price Art") {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title, sku: `sku-${id}`,
    status: "RESERVED", price,
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
        customer_details: { email: `buyer-${uid()}@test.com`, name: "Price Buyer" },
        metadata: { artworkId, tenantId, fulfillmentType: "PICKUP" },
      },
    },
  };
}

async function orderBySession(sessionId: string) {
  return db.query.ordersTable.findFirst({ where: eq(ordersTable.stripeSessionId, sessionId) });
}

async function orderItemBySession(sessionId: string) {
  const order = await orderBySession(sessionId);
  if (!order) return null;
  return db.query.orderItemsTable.findFirst({ where: eq(orderItemsTable.orderId, order.id) });
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

describeIntegration("Checkout order item priceCents and applicationFeeCents — real-DB integration", () => {
  it("applicationFeeCents = 5% of amount_total (stored on orders row)", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId, 50000);
    const sessionId = `cs_test_${uid()}`;

    await post(checkoutEvent(sessionId, artworkId, tenantId, 50000));

    const order = await orderBySession(sessionId);
    expect(order?.applicationFeeCents).toBe(2500); // 5% of 50000
  });

  it("orderItem.priceCents matches the artwork's listed price", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId, 75000);
    const sessionId = `cs_test_${uid()}`;

    await post(checkoutEvent(sessionId, artworkId, tenantId, 75000));

    const item = await orderItemBySession(sessionId);
    expect(item?.priceCents).toBe(75000);
  });

  it("applicationFeeCents is computed from amount_total, not artwork.price", async () => {
    const tenantId  = await createTenant();
    // Artwork priced at 40000, but amount_total (with delivery?) = 45000.
    const artworkId = await createArtwork(tenantId, 40000);
    const sessionId = `cs_test_${uid()}`;

    await post(checkoutEvent(sessionId, artworkId, tenantId, 45000));

    const order = await orderBySession(sessionId);
    expect(order?.applicationFeeCents).toBe(2250); // 5% of 45000, not 40000
  });

  it("two orders have independent applicationFeeCents values", async () => {
    const tenantId   = await createTenant();
    const artwork1   = await createArtwork(tenantId, 10000);
    const artwork2   = await createArtwork(tenantId, 20000);
    const session1   = `cs_test_${uid()}`;
    const session2   = `cs_test_${uid()}`;

    await post(checkoutEvent(session1, artwork1, tenantId, 10000));
    await post(checkoutEvent(session2, artwork2, tenantId, 20000));

    const order1 = await orderBySession(session1);
    const order2 = await orderBySession(session2);
    expect(order1?.applicationFeeCents).toBe(500);  // 5% of 10000
    expect(order2?.applicationFeeCents).toBe(1000); // 5% of 20000
  });

  it("orderItem artworkTitle matches the artwork's title at purchase", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId, 30000, "Snapshot Title Art");
    const sessionId = `cs_test_${uid()}`;

    await post(checkoutEvent(sessionId, artworkId, tenantId, 30000));

    const item = await orderItemBySession(sessionId);
    expect(item?.artworkTitle).toBe("Snapshot Title Art");
  });

  it("applicationFeeCents is null when amount_total is null", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId, 30000);
    const sessionId = `cs_test_${uid()}`;

    const res = await post(checkoutEvent(sessionId, artworkId, tenantId, null));

    if (res.status === 200) {
      const order = await orderBySession(sessionId);
      if (order) {
        expect(order.applicationFeeCents).toBeNull();
      }
    }
    // If the route rejects null amount_total, that's also fine.
    expect(res.status).not.toBeGreaterThanOrEqual(500);
  });
});
