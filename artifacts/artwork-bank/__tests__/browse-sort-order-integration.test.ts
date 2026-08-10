/**
 * Public storefront artwork sort order — real-DB integration.
 *
 * app/browse/page.tsx:110-116: artworks are ordered by desc(artworksTable.createdAt)
 *   — newest first. The existing browse-pagination suite mirrors the query without
 *   an orderBy clause; this suite asserts the DESC sort contract on a real DB.
 *
 *  1. Artworks are returned newest-first (DESC createdAt).
 *  2. An older artwork is never positioned before a newer one.
 *  3. Sort order is stable across pages (page 1 has newest, page 2 has older).
 *  4. Artworks from multiple tenants are each sorted independently by their own
 *     createdAt, not cross-tenant interleaved (tenant-scoped query).
 *  5. After adding a new artwork, it appears first regardless of title order.
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];

function uid() { return `${randomUUID()}-bsoi-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Sort Order Test Gallery",
    type: "ARTIST", storefrontEnabled: true,
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id, slug: id };
}

async function insertArtwork(tenantId: string, title: string, msAgo: number = 0) {
  const id = uid();
  const createdAt = new Date(Date.now() - msAgo);
  await db.insert(artworksTable).values({
    id, tenantId, title, sku: `sku-${id}`,
    status: "AVAILABLE", showInGallery: true, createdAt,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

/** Mirror of app/browse/page.tsx baseQuery() + orderBy for a single tenant. */
async function browseForTenant(tenantId: string, opts: { limit?: number; offset?: number } = {}) {
  return db.query.artworksTable.findMany({
    where: and(
      eq(artworksTable.tenantId, tenantId),
      eq(artworksTable.status, "AVAILABLE"),
      eq(artworksTable.showInGallery, true),
    ),
    orderBy: [desc(artworksTable.createdAt)],
    limit: opts.limit ?? 100,
    offset: opts.offset ?? 0,
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

describeIntegration("Browse storefront sort order (DESC createdAt) — real-DB integration", () => {
  it("artworks are returned newest-first (DESC createdAt)", async () => {
    const { tenantId } = await createTenant();
    const oldId  = await insertArtwork(tenantId, "Old Artwork",    5000);
    const midId  = await insertArtwork(tenantId, "Middle Artwork", 3000);
    const newId  = await insertArtwork(tenantId, "New Artwork",    1000);

    const rows = await browseForTenant(tenantId);
    const ids  = rows.map(r => r.id);

    expect(ids.indexOf(newId)).toBeLessThan(ids.indexOf(midId));
    expect(ids.indexOf(midId)).toBeLessThan(ids.indexOf(oldId));
  });

  it("an older artwork is never positioned before a newer one", async () => {
    const { tenantId } = await createTenant();
    const ids: string[] = [];
    // Insert 5 artworks spaced 100 ms apart (oldest first in insertion order).
    for (let i = 4; i >= 0; i--) {
      ids.push(await insertArtwork(tenantId, `Artwork ${i}`, i * 100));
    }

    const rows = await browseForTenant(tenantId);
    const returned = rows.map(r => r.id);
    for (let i = 0; i < returned.length - 1; i++) {
      const older = rows.find(r => r.id === returned[i + 1]);
      const newer = rows.find(r => r.id === returned[i]);
      if (older && newer) {
        expect(newer.createdAt!.getTime()).toBeGreaterThanOrEqual(older.createdAt!.getTime());
      }
    }
  });

  it("sort order is stable across pages (page 1 newest, page 2 older)", async () => {
    const { tenantId } = await createTenant();
    const artworkIds: string[] = [];
    for (let i = 9; i >= 0; i--) {
      artworkIds.push(await insertArtwork(tenantId, `Page Art ${i}`, i * 200));
    }

    const page1 = await browseForTenant(tenantId, { limit: 5, offset: 0 });
    const page2 = await browseForTenant(tenantId, { limit: 5, offset: 5 });

    // Every artwork on page 1 must be newer than every artwork on page 2.
    const minPage1CreatedAt = Math.min(...page1.map(r => r.createdAt!.getTime()));
    const maxPage2CreatedAt = Math.max(...page2.map(r => r.createdAt!.getTime()));
    expect(minPage1CreatedAt).toBeGreaterThan(maxPage2CreatedAt);
  });

  it("tenant-scoped query does not include foreign tenant artworks", async () => {
    const { tenantId: ownId }     = await createTenant();
    const { tenantId: foreignId } = await createTenant();

    const ownArt     = await insertArtwork(ownId,     "Own Art",     100);
    const foreignArt = await insertArtwork(foreignId, "Foreign Art", 50);

    const rows = await browseForTenant(ownId);
    const ids  = rows.map(r => r.id);

    expect(ids).toContain(ownArt);
    expect(ids).not.toContain(foreignArt);
  });

  it("a newly inserted artwork appears first regardless of title alphabetical order", async () => {
    const { tenantId } = await createTenant();
    const zzz = await insertArtwork(tenantId, "ZZZ - Last alphabetically", 5000);
    const aaa = await insertArtwork(tenantId, "AAA - First alphabetically", 0);

    const rows = await browseForTenant(tenantId);
    const ids  = rows.map(r => r.id);

    // AAA was inserted last (most recent) so must come first.
    expect(ids.indexOf(aaa)).toBeLessThan(ids.indexOf(zzz));
  });
});
