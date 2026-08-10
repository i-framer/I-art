/**
 * Admin catalog listing — sort order — real-DB integration.
 *
 * The admin catalog page sorts artworks by `createdAt DESC` (newest first).
 * This suite verifies that sort contract holds in real PostgreSQL:
 *
 *  1. Three artworks with distinct createdAt values → returned newest-first.
 *  2. Two artworks with the same createdAt → neither order is asserted,
 *     but both appear (no row lost due to sort tie-breaking).
 *  3. An artwork created after an initial query would appear first in the
 *     next query (demonstrates live ordering, not a cached snapshot).
 *  4. Foreign-tenant artworks never appear in own tenant's sorted results.
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];

function uid() { return `${randomUUID()}-csrt-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Catalog Sort Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string, title: string, createdAt?: Date) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title, sku: `sku-${id}`, status: "AVAILABLE",
  } as any);
  if (createdAt) {
    await db.update(artworksTable)
      .set({ createdAt })
      .where(eq(artworksTable.id, id));
  }
  createdArtworkIds.push(id);
  return id;
}

/** Mirror the page query: tenant-scoped, newest-first. */
async function catalogQuery(tenantId: string) {
  return db.query.artworksTable.findMany({
    where: eq(artworksTable.tenantId, tenantId),
    orderBy: [desc(artworksTable.createdAt)],
  });
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

describeIntegration("Admin catalog listing — sort order — real-DB integration", () => {
  it("artworks with distinct createdAt are returned newest-first", async () => {
    const tenantId = await createTenant();
    const t1 = new Date("2024-01-01T00:00:00Z");
    const t2 = new Date("2024-06-01T00:00:00Z");
    const t3 = new Date("2025-01-01T00:00:00Z");

    const oldestId  = await createArtwork(tenantId, "Oldest", t1);
    const middleId  = await createArtwork(tenantId, "Middle", t2);
    const newestId  = await createArtwork(tenantId, "Newest", t3);

    const rows = await catalogQuery(tenantId);
    const ids = rows.map(r => r.id);

    expect(ids[0]).toBe(newestId);
    expect(ids[1]).toBe(middleId);
    expect(ids[2]).toBe(oldestId);
  });

  it("two artworks with the same createdAt both appear (no row lost)", async () => {
    const tenantId = await createTenant();
    const sameTime = new Date("2024-03-15T12:00:00Z");

    const id1 = await createArtwork(tenantId, "Twin A", sameTime);
    const id2 = await createArtwork(tenantId, "Twin B", sameTime);

    const rows = await catalogQuery(tenantId);
    const ids = rows.map(r => r.id);

    // Both must appear; relative order between ties is undefined.
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
  });

  it("a newly-created artwork appears first on a subsequent query", async () => {
    const tenantId = await createTenant();
    const olderTime = new Date(Date.now() - 5 * 60 * 1000);

    const oldId = await createArtwork(tenantId, "Old Artwork", olderTime);

    // Snapshot before new artwork.
    const before = await catalogQuery(tenantId);
    expect(before[0]!.id).toBe(oldId);

    // Add a newer artwork and re-query.
    const newId = await createArtwork(tenantId, "Brand New");

    const after = await catalogQuery(tenantId);
    expect(after[0]!.id).toBe(newId);
  });

  it("foreign-tenant artworks do not appear in sorted results", async () => {
    const ownTenantId = await createTenant();
    const foreignTenantId = await createTenant();

    const ownId = await createArtwork(ownTenantId, "Own Artwork");
    const foreignId = await createArtwork(foreignTenantId, "Foreign Artwork");

    const rows = await catalogQuery(ownTenantId);
    const ids = rows.map(r => r.id);

    expect(ids).toContain(ownId);
    expect(ids).not.toContain(foreignId);
  });
});
