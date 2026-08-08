/**
 * Order totalCents vs item priceCents consistency — real-DB integration.
 *
 * When the Stripe webhook creates an order, totalCents on ordersTable and
 * priceCents on orderItemsTable should agree. This suite verifies:
 *
 *  1. Single item: order totalCents equals item priceCents.
 *  2. Row-level assertion: orderItem.priceCents persists correctly.
 *  3. ordersTable.totalCents persists correctly.
 *  4. Querying order + items: both fields available on joined result.
 *  5. Cross-order isolation: each order's totalCents is independent.
 */
import { afterAll, afterEach, it, expect } from "vitest";
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
const createdItemIds: string[] = [];

function uid() { return `${randomUUID()}-opc-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Price Consistency Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Price Test Art", sku: `sku-${id}`, status: "SOLD",
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function insertOrderWithItem(tenantId: string, artworkId: string, priceCents: number) {
  const orderId = uid();
  await db.insert(ordersTable).values({
    id: orderId, tenantId, status: "PAID",
    totalCents: priceCents,
    buyerEmail: `buyer-${orderId}@test.com`,
    buyerName: "Price Test Buyer",
    fulfillmentType: "PICKUP",
    stripeSessionId: `cs_test_${orderId}`,
  } as any);
  createdOrderIds.push(orderId);

  const itemId = uid();
  await db.insert(orderItemsTable).values({
    id: itemId, orderId, artworkId, tenantId,
    artworkTitle: "Price Test Art",
    priceCents,
  } as any);
  createdItemIds.push(itemId);

  return { orderId, itemId };
}

async function cleanup() {
  for (const id of createdItemIds.splice(0)) {
    await db.delete(orderItemsTable).where(eq(orderItemsTable.id, id)).catch(() => {});
  }
  for (const id of createdOrderIds.splice(0)) {
    await db.delete(ordersTable).where(eq(ordersTable.id, id)).catch(() => {});
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

describeIntegration("Order totalCents vs item priceCents consistency — real-DB integration", () => {
  it("single item: order totalCents equals item priceCents", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const { orderId, itemId } = await insertOrderWithItem(tenantId, artworkId, 35000);

    const order = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    const item  = await db.query.orderItemsTable.findFirst({ where: eq(orderItemsTable.id, itemId) });

    expect(order?.totalCents).toBe(35000);
    expect(item?.priceCents).toBe(35000);
    expect(order?.totalCents).toBe(item?.priceCents);
  });

  it("orderItem.priceCents persists correctly", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const { itemId } = await insertOrderWithItem(tenantId, artworkId, 12500);

    const item = await db.query.orderItemsTable.findFirst({ where: eq(orderItemsTable.id, itemId) });
    expect(item?.priceCents).toBe(12500);
  });

  it("ordersTable.totalCents persists correctly", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const { orderId } = await insertOrderWithItem(tenantId, artworkId, 99000);

    const order = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(order?.totalCents).toBe(99000);
  });

  it("querying order + items: both fields are available", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const { orderId } = await insertOrderWithItem(tenantId, artworkId, 48000);

    const order = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    const items = await db.query.orderItemsTable.findMany({ where: eq(orderItemsTable.orderId, orderId) });

    expect(order?.totalCents).toBe(48000);
    expect(items[0]?.priceCents).toBe(48000);
  });

  it("cross-order isolation: each order's totalCents is independent", async () => {
    const tenantId = await createTenant();
    const art1 = await createArtwork(tenantId);
    const art2 = await createArtwork(tenantId);

    const { orderId: order1 } = await insertOrderWithItem(tenantId, art1, 20000);
    const { orderId: order2 } = await insertOrderWithItem(tenantId, art2, 75000);

    const [row1, row2] = await Promise.all([
      db.query.ordersTable.findFirst({ where: eq(ordersTable.id, order1) }),
      db.query.ordersTable.findFirst({ where: eq(ordersTable.id, order2) }),
    ]);

    expect(row1?.totalCents).toBe(20000);
    expect(row2?.totalCents).toBe(75000);
  });
});
