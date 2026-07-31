/**
 * Integration tests: the public /browse category filter must return only
 * artworks that belong to the requested category.
 *
 * These complement the mock-based browse-visibility.test.ts by running the
 * buildBrowseWhere() EXISTS subquery against a real PostgreSQL instance,
 * catching any gap between the query shape and what the database actually
 * executes (e.g. join mismatches, type coercions, or schema drift).
 *
 * Pattern follows browse-storefront-disabled-integration.test.ts.
 */
import { it, expect, beforeEach, afterEach } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { randomUUID } from "node:crypto";

// ── Real DB (no mock) — that is the whole point of this integration test ──────
import {
  db,
  tenantsTable,
  artworksTable,
  representedArtistsTable,
  artworkImagesTable,
  artworkCategoriesTable,
  artworkCategoryOnArtworkTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { buildBrowseWhere } from "@/lib/browse-where";

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid() {
  return randomUUID();
}

/** Minimal tenant insert; storefrontEnabled defaults to true. */
async function createTenant(overrides: { id?: string; storefrontEnabled?: boolean } = {}) {
  const id = overrides.id ?? uid();
  await db.insert(tenantsTable).values({
    id,
    type: "ARTIST",
    businessName: `Test Gallery ${id}`,
    slug: `test-slug-${id}`,
    storefrontEnabled: overrides.storefrontEnabled ?? true,
  } as any);
  return id;
}

/** Minimal artwork insert — showInGallery=true, status=AVAILABLE by default. */
async function createArtwork(overrides: {
  tenantId: string;
  title?: string;
  showInGallery?: boolean;
  status?: "AVAILABLE" | "SOLD" | "RESERVED" | "HIDDEN";
}) {
  const id = uid();
  await db.insert(artworksTable).values({
    id,
    tenantId: overrides.tenantId,
    title: overrides.title ?? `Test Artwork ${id}`,
    sku: `SKU-${id}`,
    showInGallery: overrides.showInGallery ?? true,
    status: overrides.status ?? "AVAILABLE",
  } as any);
  return id;
}

/** Create a category owned by a tenant. */
async function createCategory(tenantId: string, name: string) {
  const id = uid();
  await db.insert(artworkCategoriesTable).values({
    id,
    tenantId,
    name,
  } as any);
  return id;
}

/** Assign a category to an artwork. */
async function assignCategory(artworkId: string, categoryId: string) {
  await db.insert(artworkCategoryOnArtworkTable).values({
    artworkId,
    categoryId,
  } as any);
}

/**
 * Run the same browse join the browse page runs and return the matching rows.
 * The WHERE clause comes from buildBrowseWhere() — the function under test.
 */
async function runBrowseQuery(searchParams: Record<string, string> = {}) {
  const whereClause = buildBrowseWhere(searchParams);
  return db
    .select({ artworkId: artworksTable.id, tenantId: tenantsTable.id })
    .from(artworksTable)
    .innerJoin(tenantsTable, eq(tenantsTable.id, artworksTable.tenantId))
    .leftJoin(
      representedArtistsTable,
      eq(representedArtistsTable.id, artworksTable.representedArtistId),
    )
    .leftJoin(
      artworkImagesTable,
      and(
        eq(artworkImagesTable.artworkId, artworksTable.id),
        eq(artworkImagesTable.isPrimary, true),
      ),
    )
    .where(whereClause);
}

// Track created row IDs for cleanup.
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdCategoryIds: string[] = [];

beforeEach(() => {
  createdTenantIds.length = 0;
  createdArtworkIds.length = 0;
  createdCategoryIds.length = 0;
});

afterEach(async () => {
  // FK chain: artwork_category_on_artwork → artworks + artwork_category → tenants
  // Cascade deletes handle the join table rows when artworks/categories are deleted.
  for (const id of createdArtworkIds) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdCategoryIds) {
    await db
      .delete(artworkCategoriesTable)
      .where(eq(artworkCategoriesTable.id, id))
      .catch(() => {});
  }
  for (const id of createdTenantIds) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describeIntegration("browse query — category filter", () => {
  it("returns only the artwork assigned to the requested category", async () => {
    const tenantId = await createTenant();
    createdTenantIds.push(tenantId);

    const matchingId = await createArtwork({ tenantId });
    const unassignedId = await createArtwork({ tenantId });
    createdArtworkIds.push(matchingId, unassignedId);

    const categoryId = await createCategory(tenantId, "Painting");
    createdCategoryIds.push(categoryId);

    // Only matchingId gets the category assignment.
    await assignCategory(matchingId, categoryId);

    const rows = await runBrowseQuery({ category: "Painting" });
    const seeded = new Set<string>([matchingId, unassignedId]);
    const matched = rows.filter((r) => seeded.has(r.artworkId));

    // Only the artwork with the category assigned should appear.
    expect(matched).toHaveLength(1);
    expect(matched[0].artworkId).toBe(matchingId);
  });

  it("excludes artworks with no category assignment when a category filter is applied", async () => {
    const tenantId = await createTenant();
    createdTenantIds.push(tenantId);

    const artworkId = await createArtwork({ tenantId });
    createdArtworkIds.push(artworkId);

    // No category is created or assigned — the artwork has no category at all.

    const rows = await runBrowseQuery({ category: "Sculpture" });
    const matched = rows.filter((r) => r.artworkId === artworkId);

    expect(matched).toHaveLength(0);
  });

  it("excludes artworks assigned to a different category", async () => {
    const tenantId = await createTenant();
    createdTenantIds.push(tenantId);

    const artworkId = await createArtwork({ tenantId });
    createdArtworkIds.push(artworkId);

    const wrongCategoryId = await createCategory(tenantId, "Photography");
    createdCategoryIds.push(wrongCategoryId);

    // The artwork is assigned to Photography, not Drawing.
    await assignCategory(artworkId, wrongCategoryId);

    const rows = await runBrowseQuery({ category: "Drawing" });
    const matched = rows.filter((r) => r.artworkId === artworkId);

    expect(matched).toHaveLength(0);
  });

  it("returns an artwork assigned to multiple categories when any one is matched", async () => {
    const tenantId = await createTenant();
    createdTenantIds.push(tenantId);

    const artworkId = await createArtwork({ tenantId });
    createdArtworkIds.push(artworkId);

    const catPrintId = await createCategory(tenantId, "Print");
    const catSculptureId = await createCategory(tenantId, "Sculpture");
    createdCategoryIds.push(catPrintId, catSculptureId);

    await assignCategory(artworkId, catPrintId);
    await assignCategory(artworkId, catSculptureId);

    const rowsPrint = await runBrowseQuery({ category: "Print" });
    const matchedPrint = rowsPrint.filter((r) => r.artworkId === artworkId);
    expect(matchedPrint).toHaveLength(1);

    const rowsSculpture = await runBrowseQuery({ category: "Sculpture" });
    const matchedSculpture = rowsSculpture.filter((r) => r.artworkId === artworkId);
    expect(matchedSculpture).toHaveLength(1);
  });

  it("returns all artworks when no category filter is specified (baseline sanity check)", async () => {
    const tenantId = await createTenant();
    createdTenantIds.push(tenantId);

    const withCatId = await createArtwork({ tenantId });
    const withoutCatId = await createArtwork({ tenantId });
    createdArtworkIds.push(withCatId, withoutCatId);

    const categoryId = await createCategory(tenantId, "Watercolour");
    createdCategoryIds.push(categoryId);
    await assignCategory(withCatId, categoryId);

    // No category filter — both artworks should appear.
    const rows = await runBrowseQuery({});
    const seeded = new Set<string>([withCatId, withoutCatId]);
    const matched = rows.filter((r) => seeded.has(r.artworkId));

    expect(matched).toHaveLength(2);
  });

  it("combined q + category returns only the artwork that satisfies both filters", async () => {
    const tenantId = await createTenant();
    createdTenantIds.push(tenantId);

    // Artwork A: matches keyword AND is in the target category — should appear.
    const matchBothId = await createArtwork({ tenantId, title: "Unique Sunrise Oil" });

    // Artwork B: is in the target category but does NOT match the keyword — should not appear.
    const categoryOnlyId = await createArtwork({ tenantId, title: "Quiet Mountains" });

    // Artwork C: matches the keyword but belongs to a DIFFERENT category — should not appear.
    const keywordOnlyId = await createArtwork({ tenantId, title: "Unique Sunrise Watercolour" });

    createdArtworkIds.push(matchBothId, categoryOnlyId, keywordOnlyId);

    // Target category: "Oil"
    const oilCategoryId = await createCategory(tenantId, "Oil");
    // Different category: "Watercolour"
    const watercolourCategoryId = await createCategory(tenantId, "Watercolour");
    createdCategoryIds.push(oilCategoryId, watercolourCategoryId);

    await assignCategory(matchBothId, oilCategoryId);
    await assignCategory(categoryOnlyId, oilCategoryId);
    await assignCategory(keywordOnlyId, watercolourCategoryId);

    const rows = await runBrowseQuery({ q: "Unique Sunrise", category: "Oil" });
    const seeded = new Set<string>([matchBothId, categoryOnlyId, keywordOnlyId]);
    const matched = rows.filter((r) => seeded.has(r.artworkId));

    // Only matchBothId satisfies both the keyword and the category condition.
    expect(matched).toHaveLength(1);
    expect(matched[0].artworkId).toBe(matchBothId);
  });
});
