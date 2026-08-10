/**
 * Admin catalog listing — filters and tenant isolation — real-DB integration.
 *
 * CatalogPage queries artworks scoped to `session.tenantId` with optional
 * q/status/artistId/categoryId filters.  This suite verifies the query
 * behaviour against real PostgreSQL:
 *
 *  1. Unfiltered listing: all artworks for tenant, foreign tenant excluded.
 *  2. q= filter matches title (case-insensitive) and SKU.
 *  3. status= filter: AVAILABLE, SOLD, RESERVED, HIDDEN each work correctly.
 *  4. Admin listing includes HIDDEN artworks (unlike public browse).
 *  5. artistId= filter returns only artworks by the specified artist.
 *  6. categoryId= filter returns only artworks in the category.
 *  7. Combined filters (q + status) narrow results correctly.
 *  8. Pagination: PAGE_SIZE=20; page 2 returns the remainder.
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  representedArtistsTable,
  artworkCategoriesTable,
  artworkCategoryOnArtworkTable,
} from "@workspace/db";
import {
  and,
  count,
  desc,
  eq,
  ilike,
  inArray,
  or,
} from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtistIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdCategoryIds: string[] = [];

function uid() { return `${randomUUID()}-cat-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Catalog Browse Test Gallery",
    type: "ARTIST", billingExempt: true,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtist(tenantId: string, name = "Test Artist") {
  const id = uid();
  await db.insert(representedArtistsTable).values({ id, tenantId, name } as any);
  createdArtistIds.push(id);
  return id;
}

async function createCategory(tenantId: string, name = "Test Category") {
  const id = uid();
  await db.insert(artworkCategoriesTable).values({ id, tenantId, name } as any);
  createdCategoryIds.push(id);
  return id;
}

async function createArtwork(
  tenantId: string,
  opts: {
    title?: string;
    sku?: string;
    status?: string;
    representedArtistId?: string;
    showInGallery?: boolean;
  } = {},
) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId,
    title: opts.title ?? "Untitled",
    sku: opts.sku ?? `sku-${id.slice(0, 8)}`,
    status: opts.status ?? "AVAILABLE",
    representedArtistId: opts.representedArtistId ?? null,
    showInGallery: opts.showInGallery ?? true,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function linkCategory(artworkId: string, categoryId: string) {
  await db.insert(artworkCategoryOnArtworkTable).values({ artworkId, categoryId } as any);
}

async function cleanup() {
  // artwork-to-categories first, then categories, then artworks, then artists, then tenants.
  for (const id of createdArtworkIds) {
    await db.delete(artworkCategoryOnArtworkTable)
      .where(eq(artworkCategoryOnArtworkTable.artworkId, id)).catch(() => {});
  }
  for (const id of createdCategoryIds.splice(0)) {
    await db.delete(artworkCategoriesTable)
      .where(eq(artworkCategoriesTable.id, id)).catch(() => {});
  }
  for (const id of createdArtworkIds.splice(0)) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdArtistIds.splice(0)) {
    await db.delete(representedArtistsTable).where(eq(representedArtistsTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ── Inline query (mirrors CatalogPage logic) ──────────────────────────────────

const PAGE_SIZE = 20;
type Status = "AVAILABLE" | "SOLD" | "RESERVED" | "HIDDEN";

async function queryAdminCatalog(
  tenantId: string,
  opts: {
    page?: number;
    q?: string;
    status?: Status;
    artistId?: string;
    categoryId?: string;
  } = {},
  // subset of IDs to filter results to (test isolation helper)
  includeIds?: string[],
) {
  const page = Math.max(1, opts.page ?? 1);
  const offset = (page - 1) * PAGE_SIZE;

  const conditions: ReturnType<typeof eq>[] = [eq(artworksTable.tenantId, tenantId)];
  if (opts.status) conditions.push(eq(artworksTable.status, opts.status as any));
  if (opts.artistId) conditions.push(eq(artworksTable.representedArtistId, opts.artistId));
  if (opts.q) {
    conditions.push(
      or(
        ilike(artworksTable.title, `%${opts.q}%`),
        ilike(artworksTable.sku, `%${opts.q}%`),
      ) as any,
    );
  }

  let artworkIdSubset: string[] | undefined;
  if (opts.categoryId) {
    const rows = await db.select({ artworkId: artworkCategoryOnArtworkTable.artworkId })
      .from(artworkCategoryOnArtworkTable)
      .where(eq(artworkCategoryOnArtworkTable.categoryId, opts.categoryId));
    artworkIdSubset = rows.map((r: { artworkId: string }) => r.artworkId);
    if (artworkIdSubset.length > 0) {
      conditions.push(inArray(artworksTable.id, artworkIdSubset));
    } else {
      // Empty category → no results.
      return { rows: [], total: 0, totalPages: 0 };
    }
  }

  const where = and(...conditions);

  const [rows, countRows] = await Promise.all([
    db.select({ id: artworksTable.id, title: artworksTable.title, sku: artworksTable.sku, status: artworksTable.status, representedArtistId: artworksTable.representedArtistId })
      .from(artworksTable)
      .where(where)
      .orderBy(desc(artworksTable.createdAt))
      .limit(PAGE_SIZE)
      .offset(offset),
    db.select({ count: count() }).from(artworksTable).where(where),
  ]);

  const total = countRows[0]?.count ?? 0;
  const filteredRows = includeIds ? rows.filter(r => includeIds.includes(r.id)) : rows;
  const filteredTotal = includeIds ? filteredRows.length : total;
  return { rows: filteredRows, total: filteredTotal, totalPages: Math.ceil(filteredTotal / PAGE_SIZE) };
}

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Admin catalog listing — filters and tenant isolation — real-DB integration", () => {
  it("unfiltered: all own artworks appear; foreign tenant excluded", async () => {
    const tenantId = await createTenant();
    const foreignTenantId = await createTenant();

    const ownId = await createArtwork(tenantId, { title: "Own Artwork" });
    const foreignId = await createArtwork(foreignTenantId, { title: "Foreign Artwork" });

    const result = await queryAdminCatalog(tenantId, {}, [ownId, foreignId]);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].id).toBe(ownId);
  });

  it("q= filter matches title case-insensitively", async () => {
    const tenantId = await createTenant();
    const matchId = await createArtwork(tenantId, { title: "Sunset Over the Sea" });
    const noMatchId = await createArtwork(tenantId, { title: "Mountain Scene" });

    const result = await queryAdminCatalog(tenantId, { q: "sunset" }, [matchId, noMatchId]);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].id).toBe(matchId);
  });

  it("q= filter matches SKU", async () => {
    const tenantId = await createTenant();
    const matchId = await createArtwork(tenantId, { title: "Blue", sku: "BLUE-001" });
    const noMatchId = await createArtwork(tenantId, { title: "Red", sku: "RED-999" });

    const result = await queryAdminCatalog(tenantId, { q: "BLUE" }, [matchId, noMatchId]);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].id).toBe(matchId);
  });

  it("status=AVAILABLE excludes SOLD/RESERVED/HIDDEN", async () => {
    const tenantId = await createTenant();
    const availId = await createArtwork(tenantId, { status: "AVAILABLE" });
    const soldId = await createArtwork(tenantId, { status: "SOLD" });
    const hiddenId = await createArtwork(tenantId, { status: "HIDDEN" });

    const result = await queryAdminCatalog(tenantId, { status: "AVAILABLE" }, [availId, soldId, hiddenId]);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].id).toBe(availId);
  });

  it("status=HIDDEN: admin listing includes HIDDEN artworks", async () => {
    const tenantId = await createTenant();
    const hiddenId = await createArtwork(tenantId, { status: "HIDDEN" });
    const availId = await createArtwork(tenantId, { status: "AVAILABLE" });

    const hiddenResult = await queryAdminCatalog(tenantId, { status: "HIDDEN" }, [hiddenId, availId]);
    const allResult = await queryAdminCatalog(tenantId, {}, [hiddenId, availId]);

    // Hidden explicitly findable.
    expect(hiddenResult.rows).toHaveLength(1);
    expect(hiddenResult.rows[0].status).toBe("HIDDEN");
    // All-filter includes hidden too (no showInGallery exclusion in admin).
    expect(allResult.rows).toHaveLength(2);
  });

  it("artistId= filter returns only artworks by the specified artist", async () => {
    const tenantId = await createTenant();
    const artistId = await createArtist(tenantId, "Alice");
    const otherArtistId = await createArtist(tenantId, "Bob");

    const aliceId = await createArtwork(tenantId, { representedArtistId: artistId });
    const bobId = await createArtwork(tenantId, { representedArtistId: otherArtistId });

    const result = await queryAdminCatalog(tenantId, { artistId }, [aliceId, bobId]);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].id).toBe(aliceId);
  });

  it("categoryId= filter returns only artworks linked to the category", async () => {
    const tenantId = await createTenant();
    const catId = await createCategory(tenantId, "Prints");
    const inCatId = await createArtwork(tenantId, { title: "Print A" });
    const notInCatId = await createArtwork(tenantId, { title: "Painting B" });

    await linkCategory(inCatId, catId);

    const result = await queryAdminCatalog(tenantId, { categoryId: catId }, [inCatId, notInCatId]);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].id).toBe(inCatId);
  });

  it("combined q + status filter narrows results", async () => {
    const tenantId = await createTenant();
    const matchId = await createArtwork(tenantId, { title: "Blue Wave", status: "AVAILABLE" });
    const wrongStatusId = await createArtwork(tenantId, { title: "Blue Lagoon", status: "SOLD" });
    const wrongTitleId = await createArtwork(tenantId, { title: "Red Sun", status: "AVAILABLE" });

    const result = await queryAdminCatalog(
      tenantId,
      { q: "blue", status: "AVAILABLE" },
      [matchId, wrongStatusId, wrongTitleId],
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].id).toBe(matchId);
  });

  it("pagination: >20 artworks → page 1=20, page 2=remainder, no overlap", async () => {
    const tenantId = await createTenant();
    const ids: string[] = [];

    for (let i = 0; i < 22; i++) {
      ids.push(await createArtwork(tenantId, { title: `Artwork ${i}` }));
    }

    const p1 = await queryAdminCatalog(tenantId, { page: 1 }, ids);
    const p2 = await queryAdminCatalog(tenantId, { page: 2 }, ids);

    expect(p1.rows).toHaveLength(20);
    expect(p2.rows).toHaveLength(2);

    const p1ids = new Set(p1.rows.map(r => r.id));
    for (const row of p2.rows) expect(p1ids.has(row.id)).toBe(false);
  });
});
