/**
 * Admin artwork edit page — combined query — real-DB integration.
 *
 * app/(admin)/(gated)/catalog/[id]/page.tsx loads:
 *   1. artwork (tenant-scoped)
 *   2. tenant
 *   3. artworkImages (sortOrder ASC, createdAt ASC)
 *   4. categories (tenant-scoped, name ASC)
 *   5. category assignments for the artwork
 *   6. represented artists (tenant-scoped, name ASC)
 *
 * This suite verifies that combined query contract against real PostgreSQL:
 *
 *  1. Own artwork is found with all associations.
 *  2. Foreign-tenant artwork is not found (returns undefined).
 *  3. Category assignments are returned for the artwork.
 *  4. Images are returned sorted by sortOrder ASC then createdAt ASC.
 *  5. Artists list is tenant-scoped (foreign artists excluded).
 *  6. Category list is tenant-scoped (foreign categories excluded).
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  artworkImagesTable,
  artworkCategoriesTable,
  artworkCategoryOnArtworkTable,
  representedArtistsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdArtistIds: string[] = [];
const createdImageIds: string[] = [];

function uid() { return `${randomUUID()}-aaep-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Edit Page Query Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Edit Page Test Artwork", sku: `sku-${id}`, status: "AVAILABLE",
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createCategory(tenantId: string, name: string) {
  const id = uid();
  await db.insert(artworkCategoriesTable).values({ id, tenantId, name } as any);
  createdCategoryIds.push(id);
  return id;
}

async function createArtist(tenantId: string, name: string) {
  const id = uid();
  await db.insert(representedArtistsTable).values({ id, tenantId, name } as any);
  createdArtistIds.push(id);
  return id;
}

async function createImage(artworkId: string, tenantId: string, sortOrder: number, isPrimary = false) {
  const id = uid();
  await db.insert(artworkImagesTable).values({
    id, artworkId, tenantId,
    objectPath: `test/${id}.jpg`,
    filename: `${id}.jpg`,
    isPrimary, sortOrder,
  } as any);
  createdImageIds.push(id);
  return id;
}

async function assignCategory(artworkId: string, categoryId: string) {
  await db.insert(artworkCategoryOnArtworkTable).values({ artworkId, categoryId } as any);
}

/** Mirror the edit page combined query (tenant-scoped). */
async function editPageLoad(artworkId: string, tenantId: string) {
  const [artwork, tenant] = await Promise.all([
    db.query.artworksTable.findFirst({
      where: and(eq(artworksTable.id, artworkId), eq(artworksTable.tenantId, tenantId)),
    }),
    db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, tenantId) }),
  ]);
  if (!artwork || !tenant) return null;

  const [images, categories, catAssignments, artists] = await Promise.all([
    db.query.artworkImagesTable.findMany({
      where: eq(artworkImagesTable.artworkId, artworkId),
      orderBy: (t, { asc }) => [asc(t.sortOrder), asc(t.createdAt)],
    }),
    db.query.artworkCategoriesTable.findMany({
      where: eq(artworkCategoriesTable.tenantId, tenantId),
      orderBy: (t, { asc }) => [asc(t.name)],
    }),
    db.query.artworkCategoryOnArtworkTable.findMany({
      where: eq(artworkCategoryOnArtworkTable.artworkId, artworkId),
    }),
    db.query.representedArtistsTable.findMany({
      where: eq(representedArtistsTable.tenantId, tenantId),
      orderBy: (t, { asc }) => [asc(t.name)],
    }),
  ]);

  return { artwork, tenant, images, categories, catAssignments, artists };
}

async function cleanup() {
  for (const id of createdImageIds.splice(0)) {
    await db.delete(artworkImagesTable).where(eq(artworkImagesTable.id, id)).catch(() => {});
  }
  for (const id of createdArtworkIds) {
    await db.delete(artworkCategoryOnArtworkTable)
      .where(eq(artworkCategoryOnArtworkTable.artworkId, id)).catch(() => {});
  }
  for (const id of createdArtworkIds.splice(0)) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdCategoryIds.splice(0)) {
    await db.delete(artworkCategoriesTable).where(eq(artworkCategoriesTable.id, id)).catch(() => {});
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

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Admin artwork edit page — combined query — real-DB integration", () => {
  it("own artwork is found with all associations", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const catId = await createCategory(tenantId, "Impressionism");
    await assignCategory(artworkId, catId);

    const result = await editPageLoad(artworkId, tenantId);

    expect(result).not.toBeNull();
    expect(result!.artwork.id).toBe(artworkId);
    expect(result!.tenant.id).toBe(tenantId);
    expect(result!.catAssignments.map(a => a.categoryId)).toContain(catId);
    expect(result!.categories.map(c => c.id)).toContain(catId);
  });

  it("foreign-tenant artwork is not found (returns null)", async () => {
    const ownTenantId     = await createTenant();
    const foreignTenantId = await createTenant();
    const foreignArtworkId = await createArtwork(foreignTenantId);

    const result = await editPageLoad(foreignArtworkId, ownTenantId);
    expect(result).toBeNull();
  });

  it("images are returned sorted by sortOrder ASC then createdAt ASC", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);

    const img3 = await createImage(artworkId, tenantId, 3);
    const img1 = await createImage(artworkId, tenantId, 1, true);
    const img2 = await createImage(artworkId, tenantId, 2);

    const result = await editPageLoad(artworkId, tenantId);
    const imageIds = result!.images.map(i => i.id);

    // sortOrder 1 < 2 < 3.
    expect(imageIds[0]).toBe(img1);
    expect(imageIds[1]).toBe(img2);
    expect(imageIds[2]).toBe(img3);
  });

  it("artists list is tenant-scoped — foreign artists excluded", async () => {
    const ownTenantId     = await createTenant();
    const foreignTenantId = await createTenant();
    const artworkId       = await createArtwork(ownTenantId);

    const ownArtistId     = await createArtist(ownTenantId, "Own Artist");
    const foreignArtistId = await createArtist(foreignTenantId, "Foreign Artist");

    const result = await editPageLoad(artworkId, ownTenantId);
    const artistIds = result!.artists.map(a => a.id);

    expect(artistIds).toContain(ownArtistId);
    expect(artistIds).not.toContain(foreignArtistId);
  });

  it("categories list is tenant-scoped — foreign categories excluded", async () => {
    const ownTenantId     = await createTenant();
    const foreignTenantId = await createTenant();
    const artworkId       = await createArtwork(ownTenantId);

    const ownCatId     = await createCategory(ownTenantId, "Own Category");
    const foreignCatId = await createCategory(foreignTenantId, "Foreign Category");

    const result = await editPageLoad(artworkId, ownTenantId);
    const catIds = result!.categories.map(c => c.id);

    expect(catIds).toContain(ownCatId);
    expect(catIds).not.toContain(foreignCatId);
  });

  it("artwork with no images, categories, or artists returns empty arrays", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);

    const result = await editPageLoad(artworkId, tenantId);

    expect(result).not.toBeNull();
    expect(result!.images).toHaveLength(0);
    expect(result!.catAssignments).toHaveLength(0);
    expect(result!.artists).toHaveLength(0);
  });
});
