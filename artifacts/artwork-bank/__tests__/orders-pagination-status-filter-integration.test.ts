/**
 * Admin orders list — FULFILLED/CANCELLED status filters and combined filters — real-DB integration.
 *
 * Extends coverage of orders-pagination-integration.test.ts which covers
 * PAID/CANCELLED and date ranges.
 *
 * lib/db/src/schema/order.ts: order status enum = PENDING, PAID, FULFILLED, CANCELLED.
 * (No REFUNDED/PARTIAL_REFUND at schema level — partial refunds stay PAID/FULFILLED
 *  with a refundedCents field.)
 *
 *  1. FULFILLED orders are returned when filtered by FULFILLED status.
 *  2. CANCELLED orders are returned in CANCELLED filter.
 *  3. PAID and FULFILLED mixed — filter by PAID excludes FULFILLED.
 *  4. Tenant isolation — FULFILLED orders from another tenant not returned.
 *  5. Combined filter (status=FULFILLED, tenantId=own) returns exactly own FULFILLED orders.
 *  6. refundedCents is set independently of status (PAID order can have partial refund amount).
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, ordersTable, orderItemsTable, artworksTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdOrderIds: string[] = [];
const createdItemIds: string[] = [];
const createdArtworkIds: string[] = [];

function uid() { return `${randomUUID()}-opsfii-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({ id, slug: id, businessName: "Orders Status Test", type: "ARTIST" } as any);
  createdTenantIds.push(id);
  return id;
}

async function createOrder(tenantId: string, status: string, opts: { refundedCents?: number } = {}) {
  const artworkId = uid();
  await db.insert(artworksTable).values({
    id: artworkId, tenantId, title: "Order Status Art", sku: `sku-${artworkId}`,
    status: status === "FULFILLED" ? "SOLD" : "AVAILABLE",
  } as any);
  createdArtworkIds.push(artworkId);

  const orderId = uid();
  await db.insert(ordersTable).values({
    id: orderId, tenantId, status,
    totalCents: 30000,
    buyerEmail: `buyer-${orderId}@test.com`,
    buyerName: "Status Test Buyer",
    fulfillmentType: "PICKUP",
    stripeSessionId: `cs_test_${orderId}`,
    refundedAmountCents: opts.refundedCents ?? null,
  } as any);
  createdOrderIds.push(orderId);

  const itemId = uid();
  await db.insert(orderItemsTable).values({
    id: itemId, orderId, artworkId, tenantId,
    artworkTitle: "Order Status Art", priceCents: 30000,
  } as any);
  createdItemIds.push(itemId);

  return orderId;
}

async function ordersByStatus(tenantId: string, status: string) {
  return db.query.ordersTable.findMany({
    where: and(eq(ordersTable.tenantId, tenantId), eq(ordersTable.status, status)),
  });
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

describeIntegration("Admin orders status filters — real-DB integration", () => {
  it("FULFILLED orders are returned when filtered by FULFILLED status", async () => {
    const tenantId = await createTenant();
    const orderId = await createOrder(tenantId, "FULFILLED");

    const rows = await ordersByStatus(tenantId, "FULFILLED");
    expect(rows.map(r => r.id)).toContain(orderId);
  });

  it("CANCELLED orders are returned in CANCELLED filter", async () => {
    const tenantId = await createTenant();
    const orderId = await createOrder(tenantId, "CANCELLED");

    const rows = await ordersByStatus(tenantId, "CANCELLED");
    expect(rows.map(r => r.id)).toContain(orderId);
  });

  it("PAID filter excludes FULFILLED orders", async () => {
    const tenantId = await createTenant();
    const paidId      = await createOrder(tenantId, "PAID");
    const fulfilledId = await createOrder(tenantId, "FULFILLED");

    const rows = await ordersByStatus(tenantId, "PAID");
    const ids = rows.map(r => r.id);

    expect(ids).toContain(paidId);
    expect(ids).not.toContain(fulfilledId);
  });

  it("tenant isolation — FULFILLED orders from another tenant not returned", async () => {
    const tenantA = await createTenant();
    const tenantB = await createTenant();
    const orderA  = await createOrder(tenantA, "FULFILLED");
    const orderB  = await createOrder(tenantB, "FULFILLED");

    const rowsA = await ordersByStatus(tenantA, "FULFILLED");
    const idsA = rowsA.map(r => r.id);

    expect(idsA).toContain(orderA);
    expect(idsA).not.toContain(orderB);
  });

  it("combined filter (status=FULFILLED, tenantId=own) returns exactly own FULFILLED orders", async () => {
    const tenantA = await createTenant();
    const tenantB = await createTenant();
    await createOrder(tenantA, "FULFILLED");
    await createOrder(tenantA, "FULFILLED");
    await createOrder(tenantA, "PAID");      // different status
    await createOrder(tenantB, "FULFILLED"); // different tenant

    const rows = await ordersByStatus(tenantA, "FULFILLED");
    for (const row of rows) {
      expect(row.tenantId).toBe(tenantA);
      expect(row.status).toBe("FULFILLED");
    }
    expect(rows).toHaveLength(2);
  });

  it("refundedCents is set independently of status (PAID order can have partial refund amount)", async () => {
    const tenantId = await createTenant();
    const orderId = await createOrder(tenantId, "PAID", { refundedCents: 5000 });

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.status).toBe("PAID");
    expect(row?.refundedAmountCents).toBe(5000);
  });
});
