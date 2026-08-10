/**
 * Admin orders list page query — real-DB integration.
 *
 * app/(admin)/(gated)/orders/page.tsx:54-57:
 *   LEFT JOIN orderItemsTable → artworkTitle on the list row.
 *   Orders without items still appear (left join).
 *
 *  1. Order with one item → artworkTitle returned on the list row.
 *  2. Order with no items → appears in list with artworkTitle=null.
 *  3. Multiple orders → all returned ordered by createdAt DESC.
 *  4. Another tenant's orders are excluded (tenant scoping).
 *  5. Status filter PAID → only PAID orders returned.
 *  6. Status filter FULFILLED → only FULFILLED orders returned.
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db, tenantsTable, artworksTable, ordersTable, orderItemsTable,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdOrderIds: string[] = [];

function uid() { return `${randomUUID()}-aolqi-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Order List Test", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: `Order List Art ${seq}`, sku: `sku-${id}`,
    status: "SOLD", price: 10000, showInGallery: true,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createOrder(tenantId: string, status: "PAID" | "FULFILLED" | "CANCELLED" = "PAID") {
  const id = uid();
  await db.insert(ordersTable).values({
    id, tenantId, status, totalCents: 10000,
    buyerEmail: `buyer-${id}@test.com`, buyerName: "List Buyer",
    fulfillmentType: "PICKUP",
  } as any);
  createdOrderIds.push(id);
  return id;
}

async function createOrderItem(orderId: string, artworkId: string, tenantId: string, title = "List Art") {
  await db.insert(orderItemsTable).values({
    id: uid(), orderId, artworkId, tenantId,
    artworkTitle: title, priceCents: 10000,
  } as any);
}

// Mirrors the page query.
async function queryOrderList(tenantId: string, statusFilter?: string) {
  const conditions: any[] = [eq(ordersTable.tenantId, tenantId)];
  if (statusFilter && statusFilter !== "ALL") {
    conditions.push(eq(ordersTable.status, statusFilter as any));
  }
  return db
    .select({
      order: ordersTable,
      artworkTitle: orderItemsTable.artworkTitle,
    })
    .from(ordersTable)
    .leftJoin(orderItemsTable, eq(orderItemsTable.orderId, ordersTable.id))
    .where(and(...conditions))
    .orderBy(desc(ordersTable.createdAt));
}

async function cleanup() {
  for (const id of createdOrderIds) {
    await db.delete(orderItemsTable).where(eq(orderItemsTable.orderId, id)).catch(() => {});
    await db.delete(ordersTable).where(eq(ordersTable.id, id)).catch(() => {});
  }
  createdOrderIds.splice(0);
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

describeIntegration("Admin orders list page query — real-DB integration", () => {
  it("order with one item → artworkTitle returned on the list row", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId   = await createOrder(tenantId);
    await createOrderItem(orderId, artworkId, tenantId, "The Masterpiece");

    const rows = await queryOrderList(tenantId);
    const row = rows.find(r => r.order.id === orderId);

    expect(row).not.toBeUndefined();
    expect(row?.artworkTitle).toBe("The Masterpiece");
  });

  it("order with no items → appears in list with artworkTitle=null (left join)", async () => {
    const tenantId = await createTenant();
    const orderId  = await createOrder(tenantId);
    // No orderItem row inserted.

    const rows = await queryOrderList(tenantId);
    const row = rows.find(r => r.order.id === orderId);

    expect(row).not.toBeUndefined();
    expect(row?.artworkTitle).toBeNull();
  });

  it("multiple orders appear, ordered by createdAt DESC", async () => {
    const tenantId = await createTenant();
    const order1   = await createOrder(tenantId);
    const order2   = await createOrder(tenantId);
    const order3   = await createOrder(tenantId);

    const rows = await queryOrderList(tenantId);
    const ids = rows.map(r => r.order.id);

    // All three orders appear.
    expect(ids).toContain(order1);
    expect(ids).toContain(order2);
    expect(ids).toContain(order3);
    // order3 was inserted last → should appear first in DESC order.
    const idx3 = ids.indexOf(order3);
    const idx1 = ids.indexOf(order1);
    expect(idx3).toBeLessThan(idx1);
  });

  it("another tenant's orders are excluded (tenant scoping)", async () => {
    const tenantA   = await createTenant();
    const tenantB   = await createTenant();
    const orderA    = await createOrder(tenantA);
    const orderB    = await createOrder(tenantB);

    const rowsA = await queryOrderList(tenantA);
    const rowsB = await queryOrderList(tenantB);

    const idsA = rowsA.map(r => r.order.id);
    const idsB = rowsB.map(r => r.order.id);

    expect(idsA).toContain(orderA);
    expect(idsA).not.toContain(orderB);
    expect(idsB).toContain(orderB);
    expect(idsB).not.toContain(orderA);
  });

  it("status filter PAID → only PAID orders returned", async () => {
    const tenantId   = await createTenant();
    const paidOrder  = await createOrder(tenantId, "PAID");
    const fulfilledOrder = await createOrder(tenantId, "FULFILLED");

    const rows = await queryOrderList(tenantId, "PAID");
    const ids = rows.map(r => r.order.id);

    expect(ids).toContain(paidOrder);
    expect(ids).not.toContain(fulfilledOrder);
  });

  it("status filter FULFILLED → only FULFILLED orders returned", async () => {
    const tenantId   = await createTenant();
    const paidOrder  = await createOrder(tenantId, "PAID");
    const fulfilledOrder = await createOrder(tenantId, "FULFILLED");

    const rows = await queryOrderList(tenantId, "FULFILLED");
    const ids = rows.map(r => r.order.id);

    expect(ids).toContain(fulfilledOrder);
    expect(ids).not.toContain(paidOrder);
  });
});
