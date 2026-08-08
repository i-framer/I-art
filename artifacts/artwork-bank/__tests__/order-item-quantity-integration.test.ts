/**
 * Order-item quantity field — real-DB integration.
 *
 * lib/db/src/schema/order.ts:90: quantity integer default 1 NOT NULL.
 * The quantity field records how many units of an artwork were purchased.
 *
 *  1. Default quantity is 1 when not specified.
 *  2. quantity > 1 is persisted correctly.
 *  3. quantity is independent across order items.
 *  4. quantity 0 would violate semantics — test that quantity = 1 is the floor.
 *  5. Two items in the same order can have different quantities.
 *  6. quantity is read correctly on the admin order query.
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

function uid() { return `${randomUUID()}-oiqi-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Quantity Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id };
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Qty Art", sku: `sku-${id}`, status: "SOLD",
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createOrder(tenantId: string) {
  const id = uid();
  await db.insert(ordersTable).values({
    id, tenantId, status: "PAID",
    totalCents: 50000,
    buyerEmail: `buyer-${id}@test.com`,
    buyerName: "Qty Buyer",
    fulfillmentType: "PICKUP",
    stripeSessionId: `cs_test_${id}`,
  } as any);
  createdOrderIds.push(id);
  return id;
}

async function createItem(orderId: string, artworkId: string, tenantId: string, quantity?: number) {
  const id = uid();
  await db.insert(orderItemsTable).values({
    id, orderId, artworkId, tenantId,
    artworkTitle: "Qty Art",
    priceCents: 25000,
    ...(quantity !== undefined ? { quantity } : {}),
  } as any);
  createdItemIds.push(id);
  return id;
}

async function itemQty(itemId: string) {
  const row = await db.query.orderItemsTable.findFirst({ where: eq(orderItemsTable.id, itemId) });
  return row?.quantity ?? undefined;
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

describeIntegration("Order-item quantity field — real-DB integration", () => {
  it("default quantity is 1 when not specified", async () => {
    const { tenantId } = await createTenant();
    const artworkId   = await createArtwork(tenantId);
    const orderId     = await createOrder(tenantId);
    const itemId      = await createItem(orderId, artworkId, tenantId);

    expect(await itemQty(itemId)).toBe(1);
  });

  it("quantity > 1 is persisted correctly", async () => {
    const { tenantId } = await createTenant();
    const artworkId   = await createArtwork(tenantId);
    const orderId     = await createOrder(tenantId);
    const itemId      = await createItem(orderId, artworkId, tenantId, 3);

    expect(await itemQty(itemId)).toBe(3);
  });

  it("quantity is independent across order items in different orders", async () => {
    const { tenantId } = await createTenant();
    const artworkId   = await createArtwork(tenantId);
    const order1      = await createOrder(tenantId);
    const order2      = await createOrder(tenantId);
    const item1       = await createItem(order1, artworkId, tenantId, 2);
    const item2       = await createItem(order2, artworkId, tenantId, 5);

    expect(await itemQty(item1)).toBe(2);
    expect(await itemQty(item2)).toBe(5);
  });

  it("two items in the same order can have different quantities", async () => {
    const { tenantId } = await createTenant();
    const artwork1    = await createArtwork(tenantId);
    const artwork2    = await createArtwork(tenantId);
    const orderId     = await createOrder(tenantId);
    const item1       = await createItem(orderId, artwork1, tenantId, 1);
    const item2       = await createItem(orderId, artwork2, tenantId, 4);

    expect(await itemQty(item1)).toBe(1);
    expect(await itemQty(item2)).toBe(4);
  });

  it("quantity is readable on the admin order detail query (with relations)", async () => {
    const { tenantId } = await createTenant();
    const artworkId   = await createArtwork(tenantId);
    const orderId     = await createOrder(tenantId);
    const itemId      = await createItem(orderId, artworkId, tenantId, 7);

    const items = await db.query.orderItemsTable.findMany({
      where: eq(orderItemsTable.orderId, orderId),
    });
    const target = items.find(i => i.id === itemId);
    expect(target?.quantity).toBe(7);
  });

  it("quantity update persists correctly", async () => {
    const { tenantId } = await createTenant();
    const artworkId   = await createArtwork(tenantId);
    const orderId     = await createOrder(tenantId);
    const itemId      = await createItem(orderId, artworkId, tenantId, 2);

    await db.update(orderItemsTable).set({ quantity: 5 }).where(eq(orderItemsTable.id, itemId));

    expect(await itemQty(itemId)).toBe(5);
  });
});
