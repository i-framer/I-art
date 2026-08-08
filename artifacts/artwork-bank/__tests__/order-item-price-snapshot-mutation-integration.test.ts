/**
 * orderItem.priceCents snapshot — price mutation test — real-DB integration.
 *
 * When an artwork is sold, the order item stores the price at the time of order.
 * A subsequent price change on the live artwork must NOT change the stored
 * `orderItem.priceCents` snapshot.
 *
 *  1. Item priceCents snapshot remains after artwork price change.
 *  2. Item priceCents 0 is stored as 0 (not null, not default).
 *  3. Two orders with the same artwork retain independent price snapshots.
 *  4. Artwork price change to null does not affect item snapshot.
 *  5. Order totalCents is independent of artwork price change.
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

function uid() { return `${randomUUID()}-oipsm-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Price Snapshot Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id };
}

async function createArtwork(tenantId: string, price: number | null = 50000) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Price Snapshot Art", sku: `sku-${id}`,
    status: "SOLD", price,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createOrderWithItem(tenantId: string, artworkId: string, priceCents: number) {
  const orderId = uid();
  await db.insert(ordersTable).values({
    id: orderId, tenantId, status: "PAID",
    totalCents: priceCents,
    buyerEmail: `buyer-${orderId}@test.com`,
    buyerName: "Price Snapshot Buyer",
    fulfillmentType: "PICKUP",
    stripeSessionId: `cs_test_${orderId}`,
  } as any);
  createdOrderIds.push(orderId);

  const itemId = uid();
  await db.insert(orderItemsTable).values({
    id: itemId, orderId, artworkId, tenantId,
    artworkTitle: "Price Snapshot Art",
    priceCents,
  } as any);
  createdItemIds.push(itemId);

  return { orderId, itemId };
}

async function itemPrice(itemId: string) {
  const row = await db.query.orderItemsTable.findFirst({ where: eq(orderItemsTable.id, itemId) });
  return row?.priceCents ?? undefined;
}

async function orderTotal(orderId: string) {
  const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
  return row?.totalCents ?? undefined;
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

describeIntegration("orderItem.priceCents — snapshot after artwork price mutation — real-DB integration", () => {
  it("item priceCents snapshot is unchanged after artwork price increase", async () => {
    const { tenantId } = await createTenant();
    const artworkId   = await createArtwork(tenantId, 50000);
    const { itemId }  = await createOrderWithItem(tenantId, artworkId, 50000);

    // Change artwork live price.
    await db.update(artworksTable).set({ price: 99900 }).where(eq(artworksTable.id, artworkId));

    // Item snapshot must remain original.
    expect(await itemPrice(itemId)).toBe(50000);
  });

  it("item priceCents 0 is stored as 0 (not null)", async () => {
    const { tenantId } = await createTenant();
    const artworkId   = await createArtwork(tenantId, 0);
    const { itemId }  = await createOrderWithItem(tenantId, artworkId, 0);

    expect(await itemPrice(itemId)).toBe(0);
  });

  it("two orders with the same artwork retain independent price snapshots", async () => {
    const { tenantId } = await createTenant();
    const artworkId   = await createArtwork(tenantId, 40000);
    const { itemId: item1 } = await createOrderWithItem(tenantId, artworkId, 40000);

    // Change artwork price.
    await db.update(artworksTable).set({ price: 60000 }).where(eq(artworksTable.id, artworkId));
    const { itemId: item2 } = await createOrderWithItem(tenantId, artworkId, 60000);

    expect(await itemPrice(item1)).toBe(40000);
    expect(await itemPrice(item2)).toBe(60000);
  });

  it("artwork price change to null does not affect item snapshot", async () => {
    const { tenantId } = await createTenant();
    const artworkId   = await createArtwork(tenantId, 75000);
    const { itemId }  = await createOrderWithItem(tenantId, artworkId, 75000);

    // Set artwork price to null.
    await db.update(artworksTable).set({ price: null }).where(eq(artworksTable.id, artworkId));

    expect(await itemPrice(itemId)).toBe(75000);
  });

  it("order totalCents is independent of subsequent artwork price change", async () => {
    const { tenantId } = await createTenant();
    const artworkId   = await createArtwork(tenantId, 30000);
    const { orderId } = await createOrderWithItem(tenantId, artworkId, 30000);

    await db.update(artworksTable).set({ price: 10000 }).where(eq(artworksTable.id, artworkId));

    expect(await orderTotal(orderId)).toBe(30000);
  });
});
