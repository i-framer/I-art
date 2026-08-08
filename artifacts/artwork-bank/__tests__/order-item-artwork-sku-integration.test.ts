/**
 * Order item artworkSku field — persistence — real-DB integration.
 *
 * The `artworkSku` column on `orderItemsTable` is nullable text.
 * The Stripe webhook checkout handler populates it from `artwork.sku`
 * (app/api/stripe/webhook/route.ts:710).
 *
 * This suite verifies insert/update semantics at the DB layer:
 *
 *  1. artworkSku is persisted and read back correctly.
 *  2. Null artworkSku is stored and returned as null.
 *  3. artworkSku can be updated to a new value.
 *  4. artworkSku and artworkTitle are both persisted independently.
 *  5. artworkSku is visible via the admin detail query (by orderId).
 *  6. artworkSku does not bleed across orders (tenant/order isolation).
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

function uid() { return `${randomUUID()}-oias-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "SKU Persistence Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string, sku: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "SKU Test Art", sku, status: "SOLD",
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createOrder(tenantId: string) {
  const id = uid();
  await db.insert(ordersTable).values({
    id, tenantId, status: "PAID",
    totalCents: 10000,
    buyerName: "Test Buyer",
    buyerEmail: `buyer-${id}@test.com`,
    fulfillmentType: "PICKUP",
    stripeSessionId: `cs_test_${id}`,
  } as any);
  createdOrderIds.push(id);
  return id;
}

async function insertItem(orderId: string, artworkId: string, tenantId: string, artworkSku: string | null) {
  const id = uid();
  await db.insert(orderItemsTable).values({
    id, orderId, artworkId, tenantId,
    artworkTitle: "SKU Test Art",
    artworkSku,
    priceCents: 10000,
  } as any);
  createdItemIds.push(id);
  return id;
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

describeIntegration("Order item artworkSku field — persistence — real-DB integration", () => {
  it("artworkSku is persisted and read back correctly", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId, "CS-2024-001");
    const orderId = await createOrder(tenantId);
    const itemId = await insertItem(orderId, artworkId, tenantId, "CS-2024-001");

    const item = await db.query.orderItemsTable.findFirst({ where: eq(orderItemsTable.id, itemId) });
    expect(item?.artworkSku).toBe("CS-2024-001");
  });

  it("null artworkSku is stored and returned as null", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId, "no-sku-art");
    const orderId = await createOrder(tenantId);
    const itemId = await insertItem(orderId, artworkId, tenantId, null);

    const item = await db.query.orderItemsTable.findFirst({ where: eq(orderItemsTable.id, itemId) });
    expect(item?.artworkSku).toBeNull();
  });

  it("artworkSku can be updated to a new value", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId, "OLD-SKU");
    const orderId = await createOrder(tenantId);
    const itemId = await insertItem(orderId, artworkId, tenantId, "OLD-SKU");

    await db.update(orderItemsTable)
      .set({ artworkSku: "NEW-SKU" })
      .where(eq(orderItemsTable.id, itemId));

    const item = await db.query.orderItemsTable.findFirst({ where: eq(orderItemsTable.id, itemId) });
    expect(item?.artworkSku).toBe("NEW-SKU");
  });

  it("artworkSku and artworkTitle are both persisted independently", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId, "SKU-INDEP");
    const orderId = await createOrder(tenantId);
    const itemId = await insertItem(orderId, artworkId, tenantId, "SKU-INDEP");

    const item = await db.query.orderItemsTable.findFirst({ where: eq(orderItemsTable.id, itemId) });
    expect(item?.artworkSku).toBe("SKU-INDEP");
    expect(item?.artworkTitle).toBe("SKU Test Art");
  });

  it("artworkSku is visible via the admin order items query (by orderId)", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId, "ADMIN-SKU-001");
    const orderId = await createOrder(tenantId);
    await insertItem(orderId, artworkId, tenantId, "ADMIN-SKU-001");

    const items = await db.query.orderItemsTable.findMany({
      where: eq(orderItemsTable.orderId, orderId),
    });

    expect(items).toHaveLength(1);
    expect(items[0]!.artworkSku).toBe("ADMIN-SKU-001");
  });

  it("artworkSku does not bleed across orders (isolation)", async () => {
    const tenantId = await createTenant();
    const art1 = await createArtwork(tenantId, "SKU-ORDER-1");
    const art2 = await createArtwork(tenantId, "SKU-ORDER-2");
    const order1 = await createOrder(tenantId);
    const order2 = await createOrder(tenantId);
    const item1 = await insertItem(order1, art1, tenantId, "SKU-ORDER-1");
    const item2 = await insertItem(order2, art2, tenantId, "SKU-ORDER-2");

    const itemsForOrder1 = await db.query.orderItemsTable.findMany({
      where: eq(orderItemsTable.orderId, order1),
    });
    const itemsForOrder2 = await db.query.orderItemsTable.findMany({
      where: eq(orderItemsTable.orderId, order2),
    });

    expect(itemsForOrder1[0]!.artworkSku).toBe("SKU-ORDER-1");
    expect(itemsForOrder2[0]!.artworkSku).toBe("SKU-ORDER-2");
    // SKUs must not cross orders.
    expect(itemsForOrder1.map(i => i.id)).not.toContain(item2);
    expect(itemsForOrder2.map(i => i.id)).not.toContain(item1);
  });
});
