/**
 * Public storefront gallery listing — pagination and visibility — real-DB integration.
 *
 * The gallery listing page (app/t/[slug]/page.tsx) filters by:
 *  - tenantId (slug-resolved)
 *  - showInGallery = true
 *  - status IN ('AVAILABLE', 'SOLD', 'RESERVED')
 * with PAGE_SIZE=24 and optional category filter.
 *
 * Verifies:
 *  1. HIDDEN artworks are excluded even when showInGallery=true.
 *  2. Artworks with showInGallery=false are excluded regardless of status.
 *  3. AVAILABLE, SOLD, RESERVED all appear; HIDDEN does not.
 *  4. Cross-tenant isolation: another tenant's artworks never appear.
 *  5. Pagination: >24 artworks → page 1 = newest 24, page 2 = remainder, no overlap.
 *  6. Category filter only returns artworks linked to the category.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  artworkCategoriesTable,
  artworkCategoryOnArtworkTable,
} from "@workspace/db";
import {
  and,
  count,
  desc,
  eq,
  inArray,
} from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdCategoryIds: string[] = [];

function uid() { return `${randomUUID()}-sflist-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  const slug = `gallery-${id.slice(0, 8)}`;
  await db.insert(tenantsTable).values({
    id, slug, businessName: "Storefront Listing Test Gallery",
    type: "ARTIST", billingExempt: true,
  } as any);
  createdTenantIds.push(id);
  return { id, slug };
}

async function createArtwork(
  tenantId: string,
  opts: {
    title?: string;
    status?: string;
    showInGallery?: boolean;
  } = {},
) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId,
    title: opts.title ?? "Storefront Work",
    sku: `sku-${id.slice(0, 8)}`,
    status: opts.status ?? "AVAILABLE",
    showInGallery: opts.showInGallery ?? true,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createCategory(tenantId: string, name = "Prints") {
  const id = uid();
  await db.insert(artworkCategoriesTable).values({ id, tenantId, name } as any);
  createdCategoryIds.push(id);
  return id;
}

async function linkCategory(artworkId: string, categoryId: string) {
  await db.insert(artworkCategoryOnArtworkTable).values({ artworkId, categoryId } as any);
}

async function cleanup() {
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
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ── Inline query (mirrors app/t/[slug]/page.tsx logic) ───────────────────────

const PAGE_SIZE = 24;
const VISIBLE_STATUSES = ["AVAILABLE", "SOLD", "RESERVED"] as const;

async function queryStorefrontListing(
  tenantId: string,
  opts: { page?: number; categoryId?: string } = {},
) {
  const page = Math.max(1, opts.page ?? 1);
  const offset = (page - 1) * PAGE_SIZE;

  const conditions: ReturnType<typeof eq>[] = [
    eq(artworksTable.tenantId, tenantId),
    eq(artworksTable.showInGallery, true),
    inArray(artworksTable.status, VISIBLE_STATUSES as any),
  ];

  if (opts.categoryId) {
    const catRows = await db.select({ artworkId: artworkCategoryOnArtworkTable.artworkId })
      .from(artworkCategoryOnArtworkTable)
      .where(eq(artworkCategoryOnArtworkTable.categoryId, opts.categoryId));
    const catIds = catRows.map(r => r.artworkId);
    if (catIds.length === 0) return { rows: [], total: 0, totalPages: 0 };
    conditions.push(inArray(artworksTable.id, catIds) as any);
  }

  const where = and(...conditions);

  const [rows, countRows] = await Promise.all([
    db.select({ id: artworksTable.id, status: artworksTable.status, showInGallery: artworksTable.showInGallery })
      .from(artworksTable)
      .where(where)
      .orderBy(desc(artworksTable.createdAt))
      .limit(PAGE_SIZE)
      .offset(offset),
    db.select({ count: count() }).from(artworksTable).where(where),
  ]);

  const total = countRows[0]?.count ?? 0;
  return { rows, total, totalPages: Math.ceil(total / PAGE_SIZE) };
}

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Public storefront gallery listing — visibility and pagination — real-DB integration", () => {
  it("HIDDEN artworks are excluded even when showInGallery=true", async () => {
    const { id: tenantId } = await createTenant();
    const availId = await createArtwork(tenantId, { status: "AVAILABLE", showInGallery: true });
    const hiddenId = await createArtwork(tenantId, { status: "HIDDEN", showInGallery: true });

    const result = await queryStorefrontListing(tenantId);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].id).toBe(availId);
  });

  it("artworks with showInGallery=false excluded regardless of status", async () => {
    const { id: tenantId } = await createTenant();
    const visibleId = await createArtwork(tenantId, { status: "AVAILABLE", showInGallery: true });
    const hiddenId = await createArtwork(tenantId, { status: "AVAILABLE", showInGallery: false });

    const result = await queryStorefrontListing(tenantId);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].id).toBe(visibleId);
  });

  it("AVAILABLE, SOLD, RESERVED all appear; HIDDEN does not", async () => {
    const { id: tenantId } = await createTenant();
    const availId = await createArtwork(tenantId, { status: "AVAILABLE", showInGallery: true });
    const soldId = await createArtwork(tenantId, { status: "SOLD", showInGallery: true });
    const reservedId = await createArtwork(tenantId, { status: "RESERVED", showInGallery: true });
    const hiddenId = await createArtwork(tenantId, { status: "HIDDEN", showInGallery: true });

    const result = await queryStorefrontListing(tenantId);

    const ids = result.rows.map(r => r.id);
    expect(ids).toContain(availId);
    expect(ids).toContain(soldId);
    expect(ids).toContain(reservedId);
    expect(ids).not.toContain(hiddenId);
    expect(result.rows).toHaveLength(3);
  });

  it("cross-tenant: another tenant's artworks never appear", async () => {
    const { id: tenantId } = await createTenant();
    const { id: foreignTenantId } = await createTenant();

    const ownId = await createArtwork(tenantId, { status: "AVAILABLE" });
    const foreignId = await createArtwork(foreignTenantId, { status: "AVAILABLE" });

    const result = await queryStorefrontListing(tenantId);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].id).toBe(ownId);
  });

  it("pagination: >24 artworks → page 1 = 24, page 2 = remainder, no overlap", async () => {
    const { id: tenantId } = await createTenant();
    const ids: string[] = [];

    for (let i = 0; i < 26; i++) {
      ids.push(await createArtwork(tenantId, { title: `Work ${i}`, showInGallery: true }));
    }

    const p1 = await queryStorefrontListing(tenantId, { page: 1 });
    const p2 = await queryStorefrontListing(tenantId, { page: 2 });

    expect(p1.rows).toHaveLength(24);
    expect(p2.rows).toHaveLength(2);
    expect(p1.total).toBe(26);
    expect(p1.totalPages).toBe(2);

    const p1ids = new Set(p1.rows.map(r => r.id));
    for (const row of p2.rows) expect(p1ids.has(row.id)).toBe(false);
  });

  it("category filter: only artworks linked to the category appear", async () => {
    const { id: tenantId } = await createTenant();
    const catId = await createCategory(tenantId, "Prints");

    const inCatId = await createArtwork(tenantId, { title: "A Print" });
    const notInCatId = await createArtwork(tenantId, { title: "A Painting" });

    await linkCategory(inCatId, catId);

    const result = await queryStorefrontListing(tenantId, { categoryId: catId });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].id).toBe(inCatId);
  });
});
