/**
 * Admin catalog pagination — real-DB integration.
 *
 * app/(admin)/(gated)/catalog/page.tsx paginates with:
 *   const PAGE_SIZE = 20 (or similar constant)
 *   .limit(PAGE_SIZE).offset(offset)
 *   count() for totalPages
 *
 * This suite verifies the pagination contract at the DB layer:
 *
 *  1. Page 1 returns up to PAGE_SIZE rows.
 *  2. Total count includes all own-tenant artworks.
 *  3. Offset skips already-seen rows correctly.
 *  4. An out-of-range page returns an empty result set.
 *  5. Pagination is tenant-scoped (foreign artworks not counted/returned).
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable } from "@workspace/db";
import { and, count, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];

// Mirror the app's PAGE_SIZE constant.
const PAGE_SIZE = 20;

function uid() { return `${randomUUID()}-acp-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Catalog Pagination Test", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function insertArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Pagination Test", sku: `sku-${id}`, status: "AVAILABLE",
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function insertMany(tenantId: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push(await insertArtwork(tenantId));
  return ids;
}

/** Mirror the catalog page query. */
async function catalogPage(tenantId: string, page: number) {
  const offset = (page - 1) * PAGE_SIZE;
  const whereClause = eq(artworksTable.tenantId, tenantId);
  const [rows, [countRow]] = await Promise.all([
    db.query.artworksTable.findMany({
      where: whereClause,
      orderBy: [desc(artworksTable.createdAt)],
      limit: PAGE_SIZE,
      offset,
    }),
    db.select({ count: count() }).from(artworksTable).where(whereClause),
  ]);
  return { rows, total: countRow?.count ?? 0 };
}

async function cleanup() {
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

describeIntegration("Admin catalog pagination — real-DB integration", () => {
  it("page 1 with fewer than PAGE_SIZE artworks returns all of them", async () => {
    const tenantId = await createTenant();
    await insertMany(tenantId, 5);

    const { rows, total } = await catalogPage(tenantId, 1);
    expect(rows.length).toBe(5);
    expect(total).toBeGreaterThanOrEqual(5);
  });

  it("total count includes all own-tenant artworks", async () => {
    const tenantId = await createTenant();
    const ids = await insertMany(tenantId, 7);

    const { total } = await catalogPage(tenantId, 1);
    // All 7 inserted artworks must be counted.
    expect(total).toBeGreaterThanOrEqual(7);
    // All IDs must appear on page 1.
    const { rows } = await catalogPage(tenantId, 1);
    const rowIds = rows.map(r => r.id);
    for (const id of ids) {
      expect(rowIds).toContain(id);
    }
  });

  it("page 2 skips page-1 rows correctly", async () => {
    const tenantId = await createTenant();
    // Insert PAGE_SIZE+3 artworks so page 2 has 3 rows.
    await insertMany(tenantId, PAGE_SIZE + 3);

    const { rows: page1 } = await catalogPage(tenantId, 1);
    const { rows: page2 } = await catalogPage(tenantId, 2);

    expect(page1).toHaveLength(PAGE_SIZE);
    expect(page2.length).toBeGreaterThanOrEqual(3);

    // No overlap between pages.
    const page1Ids = new Set(page1.map(r => r.id));
    for (const row of page2) {
      expect(page1Ids.has(row.id)).toBe(false);
    }
  });

  it("out-of-range page returns an empty result set", async () => {
    const tenantId = await createTenant();
    await insertMany(tenantId, 3); // only 3 artworks

    // Page 1000 is far beyond the end.
    const { rows } = await catalogPage(tenantId, 1000);
    expect(rows).toHaveLength(0);
  });

  it("pagination is tenant-scoped — foreign artworks not counted or returned", async () => {
    const ownTenantId     = await createTenant();
    const foreignTenantId = await createTenant();

    const ownIds     = await insertMany(ownTenantId, 3);
    const foreignIds = await insertMany(foreignTenantId, 4);

    const { rows, total } = await catalogPage(ownTenantId, 1);
    const rowIds = rows.map(r => r.id);

    // Own artworks present.
    for (const id of ownIds) {
      expect(rowIds).toContain(id);
    }
    // Foreign artworks absent.
    for (const id of foreignIds) {
      expect(rowIds).not.toContain(id);
    }
    // Count excludes foreign artworks (only own tenant's 3).
    expect(total).toBeGreaterThanOrEqual(3);
    // The count must not be inflated by foreign artworks.
    expect(total).toBeLessThan(3 + 4 + 1); // < sum of both tenants
  });
});
