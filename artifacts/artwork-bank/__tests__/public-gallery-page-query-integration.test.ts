/**
 * Public tenant gallery page (/t/[slug]) query — real-DB integration.
 *
 * app/t/[slug]/page.tsx:47-97 queries:
 *   1. Tenant by slug (notFound if absent or storefrontEnabled=false).
 *   2. Artworks with showInGallery=true AND status IN (AVAILABLE, SOLD, RESERVED).
 *   3. Categories for the filter sidebar.
 *   4. Joins primary image via left join.
 *   Ordered by desc(artworksTable.createdAt).
 *
 *  1. AVAILABLE artworks appear on the gallery page.
 *  2. SOLD artworks appear (VISIBLE_STATUSES includes SOLD).
 *  3. RESERVED artworks appear.
 *  4. HIDDEN artworks are excluded.
 *  5. showInGallery=false artworks are excluded.
 *  6. Foreign-tenant artworks are excluded.
 *  7. storefrontEnabled=false tenant returns no artworks (and would notFound).
 *  8. Results are ordered newest-first.
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  artworkImagesTable,
  artworkCategoriesTable,
} from "@workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdImageIds: string[] = [];
const createdCategoryIds: string[] = [];

const VISIBLE_STATUSES = ["AVAILABLE", "SOLD", "RESERVED"] as const;

function uid() { return `${randomUUID()}-pgpq-${RUN}-${++seq}`; }

async function createTenant(opts: { storefrontEnabled?: boolean } = {}) {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Public Gallery Test Gallery", type: "ARTIST",
    storefrontEnabled: opts.storefrontEnabled ?? true,
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id, slug: id };
}

async function insertArtwork(tenantId: string, opts: {
  status?: "AVAILABLE" | "SOLD" | "RESERVED" | "HIDDEN";
  showInGallery?: boolean;
} = {}) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId,
    title: "Gallery Page Test Art",
    sku: `sku-${id}`,
    status: opts.status ?? "AVAILABLE",
    showInGallery: opts.showInGallery ?? true,
  } as any);
  createdArtworkIds.push(id);
  await new Promise(r => setTimeout(r, 2));
  return id;
}

/** Mirror the public gallery page artwork query. */
async function galleryQuery(slug: string) {
  const tenant = await db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.slug, slug),
  });
  if (!tenant || !tenant.storefrontEnabled) return { tenant: null, artworks: [] };

  const whereClause = and(
    eq(artworksTable.tenantId, tenant.id),
    eq(artworksTable.showInGallery, true),
    inArray(artworksTable.status, VISIBLE_STATUSES),
  );

  const rows = await db
    .select({ artwork: artworksTable, primaryImage: artworkImagesTable })
    .from(artworksTable)
    .leftJoin(
      artworkImagesTable,
      and(
        eq(artworkImagesTable.artworkId, artworksTable.id),
        eq(artworkImagesTable.isPrimary, true),
      ),
    )
    .where(whereClause)
    .orderBy(desc(artworksTable.createdAt));

  return { tenant, artworks: rows };
}

async function cleanup() {
  for (const id of createdImageIds.splice(0)) {
    await db.delete(artworkImagesTable).where(eq(artworkImagesTable.id, id)).catch(() => {});
  }
  for (const id of createdCategoryIds.splice(0)) {
    await db.delete(artworkCategoriesTable).where(eq(artworkCategoriesTable.id, id)).catch(() => {});
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

describeIntegration("Public tenant gallery page query — real-DB integration", () => {
  it("AVAILABLE artworks appear on the gallery page", async () => {
    const { tenantId, slug } = await createTenant();
    const id = await insertArtwork(tenantId, { status: "AVAILABLE" });

    const { artworks } = await galleryQuery(slug);
    expect(artworks.map(a => a.artwork.id)).toContain(id);
  });

  it("SOLD artworks appear (VISIBLE_STATUSES includes SOLD)", async () => {
    const { tenantId, slug } = await createTenant();
    const id = await insertArtwork(tenantId, { status: "SOLD" });

    const { artworks } = await galleryQuery(slug);
    expect(artworks.map(a => a.artwork.id)).toContain(id);
  });

  it("RESERVED artworks appear on the gallery page", async () => {
    const { tenantId, slug } = await createTenant();
    const id = await insertArtwork(tenantId, { status: "RESERVED" });

    const { artworks } = await galleryQuery(slug);
    expect(artworks.map(a => a.artwork.id)).toContain(id);
  });

  it("HIDDEN artworks are excluded from the gallery page", async () => {
    const { tenantId, slug } = await createTenant();
    const id = await insertArtwork(tenantId, { status: "HIDDEN" });

    const { artworks } = await galleryQuery(slug);
    expect(artworks.map(a => a.artwork.id)).not.toContain(id);
  });

  it("showInGallery=false artworks are excluded", async () => {
    const { tenantId, slug } = await createTenant();
    const id = await insertArtwork(tenantId, { showInGallery: false });

    const { artworks } = await galleryQuery(slug);
    expect(artworks.map(a => a.artwork.id)).not.toContain(id);
  });

  it("foreign-tenant artworks are excluded", async () => {
    const { tenantId: ownId, slug } = await createTenant();
    const { tenantId: foreignId }   = await createTenant();
    const ownArtworkId     = await insertArtwork(ownId);
    const foreignArtworkId = await insertArtwork(foreignId);

    const { artworks } = await galleryQuery(slug);
    const ids = artworks.map(a => a.artwork.id);

    expect(ids).toContain(ownArtworkId);
    expect(ids).not.toContain(foreignArtworkId);
  });

  it("storefrontEnabled=false tenant returns null (would notFound)", async () => {
    const { tenantId, slug } = await createTenant({ storefrontEnabled: false });
    await insertArtwork(tenantId);

    const { tenant } = await galleryQuery(slug);
    expect(tenant).toBeNull();
  });

  it("gallery artworks are ordered newest-first (createdAt DESC)", async () => {
    const { tenantId, slug } = await createTenant();
    const first  = await insertArtwork(tenantId);
    const second = await insertArtwork(tenantId);
    const third  = await insertArtwork(tenantId);

    const { artworks } = await galleryQuery(slug);
    const ids = artworks.map(a => a.artwork.id);

    expect(ids.indexOf(third)).toBeLessThan(ids.indexOf(second));
    expect(ids.indexOf(second)).toBeLessThan(ids.indexOf(first));
  });
});
