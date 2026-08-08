/**
 * Admin orders listing — pagination boundary — real-DB integration.
 *
 * app/(admin)/(gated)/orders/page.tsx:14,40-66:
 *   PAGE_SIZE = 25, offset = (page - 1) * PAGE_SIZE.
 *   Inline query mirrors here for real-DB assertions.
 *
 *  1. Exactly PAGE_SIZE=25 orders → page 1 returns 25, totalPages=1.
 *  2. PAGE_SIZE+1=26 orders → page 1 returns 25, page 2 returns 1.
 *  3. No orders → page 1 returns 0.
 *  4. Status filter applied at boundary: 26 PAID + 5 CANCELLED → page 1 (PAID) returns 25.
 *  5. Tenant isolation: page 1 only returns this tenant's orders.
 *  6. Orders on page 2 are not duplicated on page 1 (no overlap).
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db, tenantsTable, artworksTable, ordersTable, orderItemsTable,
} from "@workspace/db";
import { and, eq, count, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdOrderIds: string[] = [];

const PAGE_SIZE = 25;

function uid() { return `${randomUUID()}-aopi-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Orders Pagination Test", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createOrders(tenantId: string, n: number, status = "PAID") {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = uid();
    await db.insert(ordersTable).values({
      id, tenantId,
      status,
      totalCents: 10000 + i,
      buyerEmail: `buyer-${id}@test.com`,
      buyerName: "Test Buyer",
      fulfillmentType: "PICKUP",
      stripeSessionId: `cs_${uid()}`,
    } as any);
    ids.push(id);
    createdOrderIds.push(id);
  }
  return ids;
}

// Mirrors the admin orders query from page.tsx
async function queryPage(tenantId: string, page: number, status?: string) {
  const offset = (page - 1) * PAGE_SIZE;
  const where = and(
    eq(ordersTable.tenantId, tenantId),
    status ? eq(ordersTable.status, status as any) : undefined,
  );
  const rows = await db
    .select({ id: ordersTable.id, status: ordersTable.status })
    .from(ordersTable)
    .where(where)
    .orderBy(ordersTable.createdAt)
    .limit(PAGE_SIZE)
    .offset(offset);
  const [{ total }] = await db
    .select({ total: count() })
    .from(ordersTable)
    .where(where);
  const totalPages = Math.ceil((total ?? 0) / PAGE_SIZE);
  return { rows, total: total ?? 0, totalPages };
}

async function cleanup() {
  for (const id of createdOrderIds.splice(0)) {
    await db.delete(orderItemsTable).where(eq(orderItemsTable.orderId, id)).catch(() => {});
    await db.delete(ordersTable).where(eq(ordersTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Admin orders pagination boundary — real-DB integration", () => {
  it("exactly 25 orders → page 1 returns 25, totalPages=1", async () => {
    const tenantId = await createTenant();
    await createOrders(tenantId, 25);

    const { rows, totalPages } = await queryPage(tenantId, 1);

    expect(rows.length).toBe(25);
    expect(totalPages).toBe(1);
  });

  it("26 orders → page 1 returns 25; page 2 returns 1", async () => {
    const tenantId = await createTenant();
    await createOrders(tenantId, 26);

    const p1 = await queryPage(tenantId, 1);
    const p2 = await queryPage(tenantId, 2);

    expect(p1.rows.length).toBe(25);
    expect(p2.rows.length).toBe(1);
    expect(p1.totalPages).toBe(2);
  });

  it("no orders → page 1 returns 0 rows", async () => {
    const tenantId = await createTenant();

    const { rows, total } = await queryPage(tenantId, 1);

    expect(rows.length).toBe(0);
    expect(total).toBe(0);
  });

  it("status filter at boundary: 26 PAID + 5 CANCELLED → page 1 (PAID) returns 25", async () => {
    const tenantId = await createTenant();
    await createOrders(tenantId, 26, "PAID");
    await createOrders(tenantId, 5, "CANCELLED");

    const { rows } = await queryPage(tenantId, 1, "PAID");

    expect(rows.length).toBe(25);
    expect(rows.every(r => r.status === "PAID")).toBe(true);
  });

  it("tenant isolation: page 1 returns only this tenant's orders", async () => {
    const tenantA = await createTenant();
    const tenantB = await createTenant();
    await createOrders(tenantA, 5);
    await createOrders(tenantB, 20);

    const { rows } = await queryPage(tenantA, 1);

    expect(rows.length).toBe(5);
  });

  it("page 2 orders are not duplicated on page 1 (no overlap)", async () => {
    const tenantId = await createTenant();
    await createOrders(tenantId, 26);

    const p1 = await queryPage(tenantId, 1);
    const p2 = await queryPage(tenantId, 2);

    const p1Ids = new Set(p1.rows.map(r => r.id));
    for (const row of p2.rows) {
      expect(p1Ids.has(row.id)).toBe(false);
    }
  });
});
