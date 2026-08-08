/**
 * Admin catalog listing — pagination boundary — real-DB integration.
 *
 * app/(admin)/(gated)/catalog/page.tsx:29,57-109,159:
 *   PAGE_SIZE = 20, orderBy createdAt DESC, limit/offset, totalPages.
 *
 *  1. Exactly 20 artworks → page 1 returns 20, totalPages=1.
 *  2. 21 artworks → page 1=20, page 2=1.
 *  3. No artworks → page 1 returns 0.
 *  4. Artworks ordered by createdAt DESC (newest first on page 1).
 *  5. Tenant isolation: only this tenant's artworks on page 1.
 *  6. Page 2 IDs are not duplicated on page 1 (no overlap).
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

const PAGE_SIZE = 20;

function uid() { return `${randomUUID()}-acpi-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Catalog Pagination Test", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtworks(tenantId: string, n: number) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = uid();
    await db.insert(artworksTable).values({
      id, tenantId, title: `Artwork ${i}`, sku: `sku-${id}`,
      status: "AVAILABLE", price: 10000, showInGallery: true,
    } as any);
    ids.push(id);
    createdArtworkIds.push(id);
  }
  return ids;
}

// Mirrors the catalog page query.
async function queryPage(tenantId: string, page: number) {
  const offset = (page - 1) * PAGE_SIZE;
  const rows = await db
    .select({ id: artworksTable.id, createdAt: artworksTable.createdAt })
    .from(artworksTable)
    .where(eq(artworksTable.tenantId, tenantId))
    .orderBy(desc(artworksTable.createdAt))
    .limit(PAGE_SIZE)
    .offset(offset);
  const [{ total }] = await db
    .select({ total: count() })
    .from(artworksTable)
    .where(eq(artworksTable.tenantId, tenantId));
  const totalPages = Math.ceil((total ?? 0) / PAGE_SIZE);
  return { rows, total: total ?? 0, totalPages };
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

describeIntegration("Admin catalog pagination boundary — real-DB integration", () => {
  it("exactly 20 artworks → page 1 returns 20, totalPages=1", async () => {
    const tenantId = await createTenant();
    await createArtworks(tenantId, 20);

    const { rows, totalPages } = await queryPage(tenantId, 1);

    expect(rows.length).toBe(20);
    expect(totalPages).toBe(1);
  });

  it("21 artworks → page 1=20, page 2=1", async () => {
    const tenantId = await createTenant();
    await createArtworks(tenantId, 21);

    const p1 = await queryPage(tenantId, 1);
    const p2 = await queryPage(tenantId, 2);

    expect(p1.rows.length).toBe(20);
    expect(p2.rows.length).toBe(1);
    expect(p1.totalPages).toBe(2);
  });

  it("no artworks → page 1 returns 0 rows", async () => {
    const tenantId = await createTenant();

    const { rows, total } = await queryPage(tenantId, 1);

    expect(rows.length).toBe(0);
    expect(total).toBe(0);
  });

  it("artworks ordered by createdAt DESC (newest artwork appears first)", async () => {
    const tenantId = await createTenant();
    // Insert three artworks — because they are inserted sequentially the last
    // inserted has the latest createdAt and should appear first.
    const [oldId, , newId] = await createArtworks(tenantId, 3);

    const { rows } = await queryPage(tenantId, 1);
    const ids = rows.map(r => r.id);

    const newIdx = ids.indexOf(newId!);
    const oldIdx = ids.indexOf(oldId!);
    // Newest (newId) should come before oldest (oldId) in DESC order.
    expect(newIdx).toBeLessThan(oldIdx);
  });

  it("tenant isolation: only this tenant's artworks on page 1", async () => {
    const tenantA = await createTenant();
    const tenantB = await createTenant();
    await createArtworks(tenantA, 3);
    await createArtworks(tenantB, 15);

    const { rows } = await queryPage(tenantA, 1);

    expect(rows.length).toBe(3);
  });

  it("page 2 IDs are not duplicated on page 1 (no overlap)", async () => {
    const tenantId = await createTenant();
    await createArtworks(tenantId, 21);

    const p1 = await queryPage(tenantId, 1);
    const p2 = await queryPage(tenantId, 2);

    const p1Ids = new Set(p1.rows.map(r => r.id));
    for (const row of p2.rows) {
      expect(p1Ids.has(row.id)).toBe(false);
    }
  });
});
