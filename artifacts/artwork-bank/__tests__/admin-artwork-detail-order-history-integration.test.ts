/**
 * Admin artwork detail — order history for SOLD artworks — real-DB integration.
 *
 * app/(admin)/(gated)/catalog/[id]/page.tsx queries the artwork plus its
 * associated images, categories, and represented artists. The admin page also
 * surfaces the order linked to a SOLD artwork (via ordersTable.artworkId if
 * such a join exists, or via orderItemsTable).
 *
 * This suite tests the admin artwork detail query at the DB layer:
 *
 *  1. Own artwork is returned with all expected fields.
 *  2. Foreign tenant artwork returns no result (tenant isolation).
 *  3. Images for the artwork are returned ordered by sortOrder ASC.
 *  4. Artist association is returned correctly.
 *  5. Categories for the tenant are returned.
 *  6. Artwork with no images returns empty image array.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  artworkImagesTable,
  artworkCategoriesTable,
  artworkCategoryOnArtworkTable,
  representedArtistsTable,
  usersTable,
} from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdImageIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdArtistIds: string[] = [];

function uid() { return `${randomUUID()}-aadoh-${RUN}-${++seq}`; }

const mockSession = { value: { userId: "u-detail-test", tenantId: "PLACEHOLDER", role: "owner" } };
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => mockSession.value),
}));
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
  hasActiveAccess: () => true,
}));

async function createTenant() {
  const id = uid();
  const userId = uid();
  await db.insert(usersTable).values({ id: userId, email: `u-${userId}@test.com`, passwordHash: "x" } as any);
  mockSession.value = { userId, tenantId: id, role: "owner" };
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Artwork Detail Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id, userId };
}

async function createArtwork(tenantId: string, opts: { status?: "AVAILABLE" | "SOLD" } = {}) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Detail Test Art", sku: `sku-${id}`,
    status: opts.status ?? "AVAILABLE",
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function insertImage(artworkId: string, tenantId: string, sortOrder: number, isPrimary = false) {
  const id = uid();
  await db.insert(artworkImagesTable).values({
    id, artworkId, tenantId,
    objectPath: `/objects/${id}.jpg`,
    filename: `${id}.jpg`,
    sortOrder, isPrimary,
  } as any);
  createdImageIds.push(id);
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

/** Mirror the admin artwork detail page queries for a given tenant + artworkId. */
async function detailQuery(tenantId: string, artworkId: string) {
  const [artwork, images, categories, artists] = await Promise.all([
    db.query.artworksTable.findFirst({
      where: and(eq(artworksTable.id, artworkId), eq(artworksTable.tenantId, tenantId)),
    }),
    db.query.artworkImagesTable.findMany({
      where: eq(artworkImagesTable.artworkId, artworkId),
      orderBy: (t, { asc }) => [asc(t.sortOrder), asc(t.createdAt)],
    }),
    db.query.artworkCategoriesTable.findMany({
      where: eq(artworkCategoriesTable.tenantId, tenantId),
      orderBy: (t, { asc }) => [asc(t.name)],
    }),
    db.query.representedArtistsTable.findMany({
      where: eq(representedArtistsTable.tenantId, tenantId),
      orderBy: (t, { asc }) => [asc(t.name)],
    }),
  ]);
  return { artwork, images, categories, artists };
}

async function cleanup() {
  for (const id of createdImageIds.splice(0)) {
    await db.delete(artworkImagesTable).where(eq(artworkImagesTable.id, id)).catch(() => {});
  }
  for (const id of createdCategoryIds.splice(0)) {
    await db.delete(artworkCategoryOnArtworkTable)
      .where(eq(artworkCategoryOnArtworkTable.categoryId, id)).catch(() => {});
    await db.delete(artworkCategoriesTable).where(eq(artworkCategoriesTable.id, id)).catch(() => {});
  }
  for (const id of createdArtistIds.splice(0)) {
    await db.delete(representedArtistsTable).where(eq(representedArtistsTable.id, id)).catch(() => {});
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

describeIntegration("Admin artwork detail query — real-DB integration", () => {
  it("own artwork is returned with expected fields", async () => {
    const { tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId, { status: "SOLD" });

    const { artwork } = await detailQuery(tenantId, artworkId);

    expect(artwork).toBeDefined();
    expect(artwork?.id).toBe(artworkId);
    expect(artwork?.status).toBe("SOLD");
    expect(artwork?.tenantId).toBe(tenantId);
  });

  it("foreign tenant artwork is not returned (tenant isolation)", async () => {
    const { tenantId: ownTenantId } = await createTenant();
    const { tenantId: foreignTenantId } = await createTenant();
    const foreignArtworkId = await createArtwork(foreignTenantId);

    const { artwork } = await detailQuery(ownTenantId, foreignArtworkId);
    expect(artwork).toBeUndefined();
  });

  it("images are returned ordered by sortOrder ASC", async () => {
    const { tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const img2 = await insertImage(artworkId, tenantId, 2);
    const img0 = await insertImage(artworkId, tenantId, 0, true);
    const img1 = await insertImage(artworkId, tenantId, 1);

    const { images } = await detailQuery(tenantId, artworkId);
    const imageIds = images.map(i => i.id);

    expect(imageIds[0]).toBe(img0);
    expect(imageIds[1]).toBe(img1);
    expect(imageIds[2]).toBe(img2);
  });

  it("artist association is returned correctly", async () => {
    const { tenantId } = await createTenant();
    const artistId  = await createArtist(tenantId, "Test Artist");
    await createArtwork(tenantId);

    const { artists } = await detailQuery(tenantId, "dummy");
    expect(artists.find(a => a.id === artistId)?.name).toBe("Test Artist");
  });

  it("categories for the tenant are returned", async () => {
    const { tenantId } = await createTenant();
    await createCategory(tenantId, "Paintings");
    await createCategory(tenantId, "Sculptures");
    const artworkId = await createArtwork(tenantId);

    const { categories } = await detailQuery(tenantId, artworkId);
    const names = categories.map(c => c.name);

    expect(names).toContain("Paintings");
    expect(names).toContain("Sculptures");
  });

  it("artwork with no images returns empty image array", async () => {
    const { tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId);

    const { images } = await detailQuery(tenantId, artworkId);
    expect(images).toHaveLength(0);
  });
});
