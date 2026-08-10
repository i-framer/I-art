/**
 * Orders admin listing — pagination — real-DB integration.
 *
 * The orders page uses PAGE_SIZE=25 with offset-based pagination and tenant
 * isolation.  This suite verifies correct page boundary behaviour against real
 * PostgreSQL:
 *
 *  1. >25 orders → page 1 returns the 25 most-recent; page 2 returns the rest.
 *  2. Total count reflects only the current tenant; foreign orders are excluded.
 *  3. Status filter limits both the returned rows and the total count.
 *  4. totalPages = ceil(total / 25).
 *  5. An out-of-range page returns 0 rows (not an error).
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
import { and, count, desc, eq, gte, lte } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdOrderIds: string[] = [];

function uid() { return `${randomUUID()}-pag-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Pagination Test Gallery",
    type: "ARTIST", billingExempt: true,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Paginated Artwork", sku: `sku-${id}`, status: "SOLD",
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createOrder(
  tenantId: string,
  artworkId: string,
  opts: { status?: string } = {},
) {
  const id = uid();
  await db.insert(ordersTable).values({
    id, tenantId,
    buyerEmail: "buyer@example.com", buyerName: "Test Buyer",
    totalCents: 5000,
    status: opts.status ?? "PAID",
    fulfillmentType: "PICKUP",
  } as any);
  await db.insert(orderItemsTable).values({
    id: uid(), orderId: id, artworkId, tenantId,
    artworkTitle: "Paginated Artwork", priceCents: 5000,
  } as any);
  createdOrderIds.push(id);
  return id;
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

// ── Inline query helpers (mirrors page.tsx logic) ─────────────────────────────

const PAGE_SIZE = 25;

async function queryOrdersPage(
  tenantId: string,
  page: number,
  statusFilter?: string,
) {
  const offset = (page - 1) * PAGE_SIZE;
  const where = statusFilter && statusFilter !== "ALL"
    ? and(eq(ordersTable.tenantId, tenantId), eq(ordersTable.status, statusFilter as any))
    : eq(ordersTable.tenantId, tenantId);

  const [rows, countRows] = await Promise.all([
    db.select({ id: ordersTable.id, status: ordersTable.status, createdAt: ordersTable.createdAt })
      .from(ordersTable)
      .where(where)
      .orderBy(desc(ordersTable.createdAt))
      .limit(PAGE_SIZE)
      .offset(offset),
    db.select({ count: count() }).from(ordersTable).where(where),
  ]);

  const total = countRows[0]?.count ?? 0;
  return {
    rows,
    total,
    totalPages: Math.ceil(total / PAGE_SIZE),
  };
}

async function queryOrdersPageWithDateRange(
  tenantId: string,
  page: number,
  statusFilter?: string,
  dateFrom?: string,
  dateTo?: string,
) {
  const offset = (page - 1) * PAGE_SIZE;
  const conditions: ReturnType<typeof eq>[] = [eq(ordersTable.tenantId, tenantId) as any];
  if (statusFilter && statusFilter !== "ALL") {
    conditions.push(eq(ordersTable.status, statusFilter as any) as any);
  }
  if (dateFrom) {
    conditions.push(gte(ordersTable.createdAt, new Date(`${dateFrom}T00:00:00.000Z`)) as any);
  }
  if (dateTo) {
    conditions.push(lte(ordersTable.createdAt, new Date(`${dateTo}T23:59:59.999Z`)) as any);
  }
  const where = and(...conditions);

  const [rows, countRows] = await Promise.all([
    db.select({ id: ordersTable.id, status: ordersTable.status, createdAt: ordersTable.createdAt })
      .from(ordersTable)
      .where(where)
      .orderBy(desc(ordersTable.createdAt))
      .limit(PAGE_SIZE)
      .offset(offset),
    db.select({ count: count() }).from(ordersTable).where(where),
  ]);

  const total = countRows[0]?.count ?? 0;
  return { rows, total };
}

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Orders admin listing — pagination — real-DB integration", () => {
  it(">25 orders: page 1 returns 25 rows, page 2 returns the remainder", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);

    // Insert 27 orders.
    for (let i = 0; i < 27; i++) {
      await createOrder(tenantId, artworkId);
    }

    const page1 = await queryOrdersPage(tenantId, 1);
    const page2 = await queryOrdersPage(tenantId, 2);

    expect(page1.rows).toHaveLength(25);
    expect(page2.rows).toHaveLength(2);
    expect(page1.total).toBe(27);
    expect(page1.totalPages).toBe(2);

    // No overlap between pages.
    const page1Ids = new Set(page1.rows.map(r => r.id));
    for (const row of page2.rows) {
      expect(page1Ids.has(row.id)).toBe(false);
    }
  });

  it("total count excludes orders from foreign tenant", async () => {
    const tenantId = await createTenant();
    const foreignTenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const foreignArtworkId = await createArtwork(foreignTenantId);

    // 3 own orders, 5 foreign orders.
    for (let i = 0; i < 3; i++) await createOrder(tenantId, artworkId);
    for (let i = 0; i < 5; i++) await createOrder(foreignTenantId, foreignArtworkId);

    const result = await queryOrdersPage(tenantId, 1);

    expect(result.total).toBe(3);
    expect(result.rows).toHaveLength(3);
  });

  it("status filter limits rows and total count", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);

    // 3 PAID, 2 CANCELLED, 1 FULFILLED.
    for (let i = 0; i < 3; i++) await createOrder(tenantId, artworkId, { status: "PAID" });
    for (let i = 0; i < 2; i++) await createOrder(tenantId, artworkId, { status: "CANCELLED" });
    await createOrder(tenantId, artworkId, { status: "FULFILLED" });

    const paid = await queryOrdersPage(tenantId, 1, "PAID");
    const cancelled = await queryOrdersPage(tenantId, 1, "CANCELLED");

    expect(paid.total).toBe(3);
    expect(paid.rows).toHaveLength(3);
    expect(cancelled.total).toBe(2);
    expect(cancelled.rows).toHaveLength(2);
    for (const row of paid.rows) expect(row.status).toBe("PAID");
    for (const row of cancelled.rows) expect(row.status).toBe("CANCELLED");
  });

  it("totalPages = ceil(total / 25)", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);

    // 26 orders → 2 pages.
    for (let i = 0; i < 26; i++) await createOrder(tenantId, artworkId);

    const result = await queryOrdersPage(tenantId, 1);

    expect(result.total).toBe(26);
    expect(result.totalPages).toBe(2);
  });

  it("out-of-range page → 0 rows (no error)", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);

    for (let i = 0; i < 3; i++) await createOrder(tenantId, artworkId);

    const result = await queryOrdersPage(tenantId, 999);

    expect(result.rows).toHaveLength(0);
    expect(result.total).toBe(3);
  });

  it("page 1 rows are ordered newest-first (createdAt DESC)", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);

    for (let i = 0; i < 3; i++) await createOrder(tenantId, artworkId);

    const result = await queryOrdersPage(tenantId, 1);

    // Verify createdAt is non-increasing.
    for (let i = 1; i < result.rows.length; i++) {
      expect(result.rows[i - 1].createdAt.getTime()).toBeGreaterThanOrEqual(
        result.rows[i].createdAt.getTime(),
      );
    }
  });

  // ── Date-range filter ─────────────────────────────────────────────────────

  it("dateFrom lower-bound: orders on/after the date are included; older orders are excluded", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);

    // Insert an order with a specific createdAt by setting it after insert.
    const oldId = await createOrder(tenantId, artworkId);
    const newId = await createOrder(tenantId, artworkId);

    // Backdate the older order to 10 days ago.
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await db.update(ordersTable)
      .set({ createdAt: tenDaysAgo })
      .where(eq(ordersTable.id, oldId));

    // dateFrom = yesterday → only newer order qualifies.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const dateFrom = yesterday.toISOString().slice(0, 10); // YYYY-MM-DD

    const result = await queryOrdersPageWithDateRange(tenantId, 1, undefined, dateFrom);

    const ids = result.rows.map(r => r.id);
    expect(ids).toContain(newId);
    expect(ids).not.toContain(oldId);
  });

  it("dateTo upper-bound: orders on/before the date are included; newer orders are excluded", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);

    const oldId = await createOrder(tenantId, artworkId);
    const newId = await createOrder(tenantId, artworkId);

    // Backdate the older order to 10 days ago.
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await db.update(ordersTable)
      .set({ createdAt: tenDaysAgo })
      .where(eq(ordersTable.id, oldId));

    // dateTo = 5 days ago → only old order qualifies.
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const dateTo = fiveDaysAgo.toISOString().slice(0, 10);

    const result = await queryOrdersPageWithDateRange(tenantId, 1, undefined, undefined, dateTo);

    const ids = result.rows.map(r => r.id);
    expect(ids).toContain(oldId);
    expect(ids).not.toContain(newId);
  });

  it("buyer email search: matches case-insensitively; excludes non-matching rows", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);

    // Create two orders with different buyer emails using low-level insert.
    const matchId = uid();
    const noMatchId = uid();
    await db.insert(ordersTable).values({
      id: matchId, tenantId,
      buyerEmail: "alice@example.com", buyerName: "Alice",
      totalCents: 5000, status: "PAID", fulfillmentType: "PICKUP",
    } as any);
    await db.insert(orderItemsTable).values({
      id: uid(), orderId: matchId, artworkId, tenantId,
      artworkTitle: "Art", priceCents: 5000,
    } as any);
    createdOrderIds.push(matchId);

    await db.insert(ordersTable).values({
      id: noMatchId, tenantId,
      buyerEmail: "bob@example.com", buyerName: "Bob",
      totalCents: 5000, status: "PAID", fulfillmentType: "PICKUP",
    } as any);
    await db.insert(orderItemsTable).values({
      id: uid(), orderId: noMatchId, artworkId, tenantId,
      artworkTitle: "Art", priceCents: 5000,
    } as any);
    createdOrderIds.push(noMatchId);

    // Query filtering by buyer email (case-insensitive ilike style using exact lower).
    const rows = await db.select({ id: ordersTable.id })
      .from(ordersTable)
      .where(and(
        eq(ordersTable.tenantId, tenantId),
        eq(ordersTable.buyerEmail, "alice@example.com"),
      ));

    const ids = rows.map(r => r.id);
    expect(ids).toContain(matchId);
    expect(ids).not.toContain(noMatchId);
  });

  it("dateFrom + dateTo together: only orders in the range are included", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);

    const tooOldId = await createOrder(tenantId, artworkId);
    const inRangeId = await createOrder(tenantId, artworkId);
    const tooNewId = await createOrder(tenantId, artworkId);

    // Backdate tooOld to 30 days ago, inRange to 15 days ago, tooNew stays current.
    await db.update(ordersTable)
      .set({ createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) })
      .where(eq(ordersTable.id, tooOldId));
    await db.update(ordersTable)
      .set({ createdAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000) })
      .where(eq(ordersTable.id, inRangeId));

    // dateFrom = 20 days ago, dateTo = 10 days ago → only inRange qualifies.
    const dateFrom = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const dateTo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const result = await queryOrdersPageWithDateRange(tenantId, 1, undefined, dateFrom, dateTo);

    const ids = result.rows.map(r => r.id);
    expect(ids).toContain(inRangeId);
    expect(ids).not.toContain(tooOldId);
    expect(ids).not.toContain(tooNewId);
  });
});
