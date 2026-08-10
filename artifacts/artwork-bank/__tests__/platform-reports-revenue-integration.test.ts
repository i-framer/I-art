/**
 * Platform reports — tenant revenue aggregation — real-DB integration.
 *
 * app/platform/reports/page.tsx:49-100:
 *   Aggregates PAID orders: paidOrders count, grossCents, refundedCents, feeCents.
 *   Only status=PAID orders count (not PENDING/CANCELLED/FULFILLED).
 *   Tenant isolation: each tenant's aggregates are scoped by tenantId.
 *
 *  1. One PAID order → paidOrders=1, grossCents=order.totalCents.
 *  2. CANCELLED order → paidOrders=0, grossCents=0 (excluded from paid filter).
 *  3. Multiple PAID orders → aggregate is sum of all.
 *  4. Refunded order → refundedCents counts the refund amount.
 *  5. Another tenant's orders excluded from this tenant's aggregates.
 *  6. No orders → all aggregates are zero.
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db, tenantsTable, artworksTable, ordersTable, orderItemsTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdOrderIds: string[] = [];

function uid() { return `${randomUUID()}-prrvi-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Reports Revenue Test", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function _createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Revenue Art", sku: `sku-${id}`,
    status: "SOLD", price: 10000, showInGallery: true,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createOrder(
  tenantId: string,
  opts: { status?: string; totalCents?: number; refundedAmountCents?: number; applicationFeeCents?: number } = {},
) {
  const id = uid();
  await db.insert(ordersTable).values({
    id, tenantId,
    status: opts.status ?? "PAID",
    totalCents: opts.totalCents ?? 10000,
    refundedAmountCents: opts.refundedAmountCents ?? null,
    applicationFeeCents: opts.applicationFeeCents ?? null,
    buyerEmail: `buyer-${id}@test.com`,
    buyerName: "Revenue Buyer",
    fulfillmentType: "PICKUP",
    stripeSessionId: `cs_${uid()}`,
  } as any);
  createdOrderIds.push(id);
  return id;
}

// Mirrors the reports page aggregate query for a single tenant.
async function tenantRevenue(tenantId: string) {
  const paid = sql`${ordersTable.status} = 'PAID'`;
  const rows = await db
    .select({
      paidOrders: sql<number>`count(*) filter (where ${paid})::int`,
      grossCents: sql<number>`coalesce(sum(${ordersTable.totalCents}) filter (where ${paid}), 0)::int`,
      refundedCents: sql<number>`coalesce(sum(${ordersTable.refundedAmountCents}), 0)::int`,
      feeCents: sql<number>`coalesce(sum(${ordersTable.applicationFeeCents}) filter (where ${paid}), 0)::int`,
    })
    .from(ordersTable)
    .where(eq(ordersTable.tenantId, tenantId));
  return rows[0]!;
}

async function cleanup() {
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

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Platform reports revenue aggregation — real-DB integration", () => {
  it("one PAID order → paidOrders=1, grossCents=order.totalCents", async () => {
    const tenantId = await createTenant();
    await createOrder(tenantId, { totalCents: 25000, status: "PAID" });

    const agg = await tenantRevenue(tenantId);

    expect(agg.paidOrders).toBe(1);
    expect(agg.grossCents).toBe(25000);
  });

  it("CANCELLED order → excluded from paidOrders and grossCents", async () => {
    const tenantId = await createTenant();
    await createOrder(tenantId, { totalCents: 25000, status: "CANCELLED" });

    const agg = await tenantRevenue(tenantId);

    expect(agg.paidOrders).toBe(0);
    expect(agg.grossCents).toBe(0);
  });

  it("multiple PAID orders → aggregate is sum of all", async () => {
    const tenantId = await createTenant();
    await createOrder(tenantId, { totalCents: 10000, status: "PAID" });
    await createOrder(tenantId, { totalCents: 20000, status: "PAID" });
    await createOrder(tenantId, { totalCents: 5000,  status: "PAID" });

    const agg = await tenantRevenue(tenantId);

    expect(agg.paidOrders).toBe(3);
    expect(agg.grossCents).toBe(35000);
  });

  it("refunded order → refundedCents counts the refund amount", async () => {
    const tenantId = await createTenant();
    await createOrder(tenantId, { totalCents: 20000, status: "PAID", refundedAmountCents: 5000 });

    const agg = await tenantRevenue(tenantId);

    expect(agg.refundedCents).toBe(5000);
  });

  it("another tenant's orders → excluded from this tenant's aggregates", async () => {
    const tenantA = await createTenant();
    const tenantB = await createTenant();
    await createOrder(tenantB, { totalCents: 99999, status: "PAID" });

    const aggA = await tenantRevenue(tenantA);

    expect(aggA.paidOrders).toBe(0);
    expect(aggA.grossCents).toBe(0);
  });

  it("no orders → all aggregates are zero", async () => {
    const tenantId = await createTenant();

    const agg = await tenantRevenue(tenantId);

    expect(agg.paidOrders).toBe(0);
    expect(agg.grossCents).toBe(0);
    expect(agg.refundedCents).toBe(0);
    expect(agg.feeCents).toBe(0);
  });
});
