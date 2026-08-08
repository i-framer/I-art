/**
 * Order-item artworkTitle snapshot — real-DB integration.
 *
 * orderItemsTable.artworkTitle (lib/db/src/schema/orderItem.ts) stores a
 * snapshot of the artwork title at the time the order is created.  A
 * subsequent rename of the live artwork must NOT change the snapshotted value.
 *
 *  1. artworkTitle in the order item matches the artwork title at order time.
 *  2. Renaming the artwork AFTER order creation does not change the snapshot.
 *  3. Two separate orders snapshot the title independently.
 *  4. artworkTitle snapshot is isolated from other artwork field changes.
 *  5. Cross-tenant item isolation: foreign order items are not affected.
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

function uid() { return `${randomUUID()}-oits-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Title Snapshot Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id };
}

async function createArtwork(tenantId: string, title: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title, sku: `sku-${id}`, status: "SOLD",
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createOrder(tenantId: string) {
  const id = uid();
  await db.insert(ordersTable).values({
    id, tenantId, status: "PAID",
    totalCents: 30000,
    buyerEmail: `buyer-${id}@test.com`,
    buyerName: "Snapshot Buyer",
    fulfillmentType: "PICKUP",
    stripeSessionId: `cs_test_${id}`,
  } as any);
  createdOrderIds.push(id);
  return id;
}

async function createItem(orderId: string, artworkId: string, tenantId: string, artworkTitle: string) {
  const id = uid();
  await db.insert(orderItemsTable).values({
    id, orderId, artworkId, tenantId,
    artworkTitle,
    priceCents: 30000,
  } as any);
  createdItemIds.push(id);
  return id;
}

async function itemTitle(itemId: string) {
  const row = await db.query.orderItemsTable.findFirst({ where: eq(orderItemsTable.id, itemId) });
  return row?.artworkTitle ?? null;
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

describeIntegration("Order-item artworkTitle snapshot — real-DB integration", () => {
  it("artworkTitle in order item matches artwork title at order time", async () => {
    const { tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId, "Original Masterpiece");
    const orderId   = await createOrder(tenantId);
    const itemId    = await createItem(orderId, artworkId, tenantId, "Original Masterpiece");

    expect(await itemTitle(itemId)).toBe("Original Masterpiece");
  });

  it("renaming artwork after order creation does NOT change the item snapshot", async () => {
    const { tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId, "Before Rename");
    const orderId   = await createOrder(tenantId);
    const itemId    = await createItem(orderId, artworkId, tenantId, "Before Rename");

    // Rename the live artwork.
    await db
      .update(artworksTable)
      .set({ title: "After Rename" })
      .where(eq(artworksTable.id, artworkId));

    // Order-item snapshot must still be the original title.
    expect(await itemTitle(itemId)).toBe("Before Rename");

    // Live artwork has the new name.
    const art = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, artworkId) });
    expect(art?.title).toBe("After Rename");
  });

  it("two separate orders snapshot the title independently", async () => {
    const { tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId, "First Title");
    const order1Id  = await createOrder(tenantId);
    const item1Id   = await createItem(order1Id, artworkId, tenantId, "First Title");

    // Rename and create a second order.
    await db.update(artworksTable).set({ title: "Second Title" }).where(eq(artworksTable.id, artworkId));
    const order2Id = await createOrder(tenantId);
    const item2Id  = await createItem(order2Id, artworkId, tenantId, "Second Title");

    expect(await itemTitle(item1Id)).toBe("First Title");
    expect(await itemTitle(item2Id)).toBe("Second Title");
  });

  it("artworkTitle snapshot is isolated from other artwork field changes (status, price)", async () => {
    const { tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId, "Stable Snapshot Art");
    const orderId   = await createOrder(tenantId);
    const itemId    = await createItem(orderId, artworkId, tenantId, "Stable Snapshot Art");

    // Change artwork price and status (not title).
    await db
      .update(artworksTable)
      .set({ price: 99900, status: "SOLD" })
      .where(eq(artworksTable.id, artworkId));

    expect(await itemTitle(itemId)).toBe("Stable Snapshot Art");
  });

  it("cross-tenant item isolation: foreign order item artworkTitle is not changed", async () => {
    const { tenantId: ownId }     = await createTenant();
    const { tenantId: foreignId } = await createTenant();
    const foreignArtworkId = await createArtwork(foreignId, "Foreign Art");
    const foreignOrderId   = await createOrder(foreignId);
    const foreignItemId    = await createItem(foreignOrderId, foreignArtworkId, foreignId, "Foreign Art");

    // Own tenant renames its own artwork — should not affect foreign item.
    const ownArtworkId = await createArtwork(ownId, "Own Art");
    const ownOrderId   = await createOrder(ownId);
    await createItem(ownOrderId, ownArtworkId, ownId, "Own Art");
    await db.update(artworksTable).set({ title: "Renamed Own Art" }).where(eq(artworksTable.id, ownArtworkId));

    expect(await itemTitle(foreignItemId)).toBe("Foreign Art");
  });
});
