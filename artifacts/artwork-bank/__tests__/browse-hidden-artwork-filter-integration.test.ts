/**
 * Integration tests: the /browse filter-option dropdowns must exclude
 * categories and represented artists that have no visible artworks.
 *
 * Task 228 added unit tests that confirm the WHERE shape of
 * categoryFilterWhere() and representedArtistFilterWhere() using mock DB
 * stubs.  Those tests verify structure but not real SQL execution.  These
 * integration tests run against a real PostgreSQL instance and confirm that
 * the EXISTS subqueries actually filter correctly — catching JOIN column
 * mismatches, schema drift, or any gap between the Drizzle query shape and
 * what the database executes.
 *
 * Coverage:
 *   - categoryFilterWhere(): a category whose only artwork has
 *     showInGallery=false must NOT appear in the dropdown.
 *   - representedArtistFilterWhere(): an artist whose only artwork has
 *     showInGallery=false must NOT appear in the dropdown.
 *   - Positive controls confirm that a category / artist DOES appear when
 *     the artwork is visible.
 */
import { it, expect, beforeEach, afterEach } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { randomUUID } from "node:crypto";

// ── Real DB (no mock) — that is the whole point of this integration test ──────
import {
  db,
  tenantsTable,
  artworksTable,
  artworkCategoriesTable,
  artworkCategoryOnArtworkTable,
  representedArtistsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  categoryFilterWhere,
  representedArtistFilterWhere,
} from "@/lib/browse-filter-options";

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid() {
  return randomUUID();
}

/** Minimal storefrontEnabled tenant. */
async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id,
    type: "FRAMER",
    businessName: `Test Gallery ${id}`,
    slug: `test-slug-${id}`,
    storefrontEnabled: true,
  } as any);
  return id;
}

/** Minimal artwork insert.  showInGallery=true, status=AVAILABLE by default. */
async function createArtwork(overrides: {
  tenantId: string;
  showInGallery?: boolean;
  status?: "AVAILABLE" | "SOLD" | "RESERVED" | "HIDDEN";
  representedArtistId?: string;
}) {
  const id = uid();
  await db.insert(artworksTable).values({
    id,
    tenantId: overrides.tenantId,
    title: `Test Artwork ${id}`,
    sku: `SKU-${id}`,
    showInGallery: overrides.showInGallery ?? true,
    status: overrides.status ?? "AVAILABLE",
    representedArtistId: overrides.representedArtistId ?? null,
  } as any);
  return id;
}

/** Minimal artwork category insert. */
async function createCategory(tenantId: string) {
  const id = uid();
  await db.insert(artworkCategoriesTable).values({
    id,
    tenantId,
    name: `Category ${id}`,
  });
  return id;
}

/** Tag an artwork with a category. */
async function linkArtworkToCategory(artworkId: string, categoryId: string) {
  await db.insert(artworkCategoryOnArtworkTable).values({ artworkId, categoryId });
}

/** Minimal represented-artist insert. */
async function createRepresentedArtist(tenantId: string) {
  const id = uid();
  await db.insert(representedArtistsTable).values({
    id,
    tenantId,
    name: `Artist ${id}`,
    commissionPct: 0,
  });
  return id;
}

/**
 * Run categoryFilterWhere() and return the category IDs from `seededIds` that
 * appear in the result.
 */
async function runCategoryQuery(seededIds: string[]) {
  const rows = await db
    .select({ categoryId: artworkCategoriesTable.id })
    .from(artworkCategoriesTable)
    .innerJoin(
      tenantsTable,
      eq(tenantsTable.id, artworkCategoriesTable.tenantId),
    )
    .where(categoryFilterWhere());

  const seededSet = new Set(seededIds);
  return rows
    .filter((r) => seededSet.has(r.categoryId))
    .map((r) => r.categoryId);
}

/**
 * Run representedArtistFilterWhere() and return the artist IDs from
 * `seededIds` that appear in the result.
 */
async function runArtistQuery(seededIds: string[]) {
  const rows = await db
    .select({ artistId: representedArtistsTable.id })
    .from(representedArtistsTable)
    .innerJoin(
      tenantsTable,
      eq(tenantsTable.id, representedArtistsTable.tenantId),
    )
    .where(representedArtistFilterWhere());

  const seededSet = new Set(seededIds);
  return rows
    .filter((r) => seededSet.has(r.artistId))
    .map((r) => r.artistId);
}

// ── Cleanup tracking ──────────────────────────────────────────────────────────

const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdArtistIds: string[] = [];

beforeEach(() => {
  createdTenantIds.length = 0;
  createdArtworkIds.length = 0;
  createdCategoryIds.length = 0;
  createdArtistIds.length = 0;
});

afterEach(async () => {
  // Delete join rows first (FK → artworks + categories), then artworks, then
  // categories, then artists, then tenants.
  for (const id of createdArtworkIds) {
    await db
      .delete(artworkCategoryOnArtworkTable)
      .where(eq(artworkCategoryOnArtworkTable.artworkId, id))
      .catch(() => {});
  }
  for (const id of createdArtworkIds) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdCategoryIds) {
    await db
      .delete(artworkCategoriesTable)
      .where(eq(artworkCategoriesTable.id, id))
      .catch(() => {});
  }
  for (const id of createdArtistIds) {
    await db
      .delete(representedArtistsTable)
      .where(eq(representedArtistsTable.id, id))
      .catch(() => {});
  }
  for (const id of createdTenantIds) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
});

// ── categoryFilterWhere tests ─────────────────────────────────────────────────

describeIntegration("categoryFilterWhere — categories with no visible artworks are hidden", () => {
  it("excludes a category whose only artwork has showInGallery=false", async () => {
    const tenantId = await createTenant();
    createdTenantIds.push(tenantId);

    const categoryId = await createCategory(tenantId);
    createdCategoryIds.push(categoryId);

    const artworkId = await createArtwork({
      tenantId,
      showInGallery: false,
      status: "AVAILABLE",
    });
    createdArtworkIds.push(artworkId);

    await linkArtworkToCategory(artworkId, categoryId);

    const matched = await runCategoryQuery([categoryId]);

    // showInGallery=false means the EXISTS subquery finds no visible artwork —
    // the category must not appear in the dropdown.
    expect(matched).toHaveLength(0);
  });

  it("excludes a category whose only artwork has status=HIDDEN", async () => {
    const tenantId = await createTenant();
    createdTenantIds.push(tenantId);

    const categoryId = await createCategory(tenantId);
    createdCategoryIds.push(categoryId);

    const artworkId = await createArtwork({
      tenantId,
      showInGallery: true,
      status: "HIDDEN",
    });
    createdArtworkIds.push(artworkId);

    await linkArtworkToCategory(artworkId, categoryId);

    const matched = await runCategoryQuery([categoryId]);

    expect(matched).toHaveLength(0);
  });

  it("excludes a category that has no artworks at all", async () => {
    const tenantId = await createTenant();
    createdTenantIds.push(tenantId);

    const categoryId = await createCategory(tenantId);
    createdCategoryIds.push(categoryId);

    // No artworks — the EXISTS subquery will return nothing.
    const matched = await runCategoryQuery([categoryId]);

    expect(matched).toHaveLength(0);
  });

  it("includes a category whose artwork is visible (showInGallery=true, status=AVAILABLE)", async () => {
    const tenantId = await createTenant();
    createdTenantIds.push(tenantId);

    const categoryId = await createCategory(tenantId);
    createdCategoryIds.push(categoryId);

    const artworkId = await createArtwork({ tenantId, showInGallery: true, status: "AVAILABLE" });
    createdArtworkIds.push(artworkId);

    await linkArtworkToCategory(artworkId, categoryId);

    const matched = await runCategoryQuery([categoryId]);

    expect(matched).toHaveLength(1);
    expect(matched[0]).toBe(categoryId);
  });

  it("includes a category when at least one artwork is visible (even if another is hidden)", async () => {
    const tenantId = await createTenant();
    createdTenantIds.push(tenantId);

    const categoryId = await createCategory(tenantId);
    createdCategoryIds.push(categoryId);

    const hiddenId = await createArtwork({ tenantId, showInGallery: false, status: "AVAILABLE" });
    const visibleId = await createArtwork({ tenantId, showInGallery: true, status: "AVAILABLE" });
    createdArtworkIds.push(hiddenId, visibleId);

    await linkArtworkToCategory(hiddenId, categoryId);
    await linkArtworkToCategory(visibleId, categoryId);

    const matched = await runCategoryQuery([categoryId]);

    // The visible artwork satisfies the EXISTS — the category must appear.
    expect(matched).toHaveLength(1);
  });

  it("includes a category whose only artwork has status=SOLD", async () => {
    const tenantId = await createTenant();
    createdTenantIds.push(tenantId);

    const categoryId = await createCategory(tenantId);
    createdCategoryIds.push(categoryId);

    const artworkId = await createArtwork({ tenantId, showInGallery: true, status: "SOLD" });
    createdArtworkIds.push(artworkId);

    await linkArtworkToCategory(artworkId, categoryId);

    const matched = await runCategoryQuery([categoryId]);

    // SOLD is a visible status — the category must appear in the dropdown.
    expect(matched).toHaveLength(1);
    expect(matched[0]).toBe(categoryId);
  });

  it("includes a category whose only artwork has status=RESERVED", async () => {
    const tenantId = await createTenant();
    createdTenantIds.push(tenantId);

    const categoryId = await createCategory(tenantId);
    createdCategoryIds.push(categoryId);

    const artworkId = await createArtwork({ tenantId, showInGallery: true, status: "RESERVED" });
    createdArtworkIds.push(artworkId);

    await linkArtworkToCategory(artworkId, categoryId);

    const matched = await runCategoryQuery([categoryId]);

    // RESERVED is a visible status — the category must appear in the dropdown.
    expect(matched).toHaveLength(1);
    expect(matched[0]).toBe(categoryId);
  });

  it("returns only the category with a visible artwork when compared side-by-side with a hidden-only category", async () => {
    const tenantId = await createTenant();
    createdTenantIds.push(tenantId);

    const visibleCategoryId = await createCategory(tenantId);
    const hiddenCategoryId = await createCategory(tenantId);
    createdCategoryIds.push(visibleCategoryId, hiddenCategoryId);

    const visibleArtworkId = await createArtwork({ tenantId, showInGallery: true, status: "AVAILABLE" });
    const hiddenArtworkId = await createArtwork({ tenantId, showInGallery: false, status: "AVAILABLE" });
    createdArtworkIds.push(visibleArtworkId, hiddenArtworkId);

    await linkArtworkToCategory(visibleArtworkId, visibleCategoryId);
    await linkArtworkToCategory(hiddenArtworkId, hiddenCategoryId);

    const matched = await runCategoryQuery([visibleCategoryId, hiddenCategoryId]);

    expect(matched).toHaveLength(1);
    expect(matched[0]).toBe(visibleCategoryId);
  });
});

// ── representedArtistFilterWhere tests ───────────────────────────────────────

describeIntegration("representedArtistFilterWhere — artists with no visible artworks are hidden", () => {
  it("excludes a represented artist whose only artwork has showInGallery=false", async () => {
    const tenantId = await createTenant();
    createdTenantIds.push(tenantId);

    const artistId = await createRepresentedArtist(tenantId);
    createdArtistIds.push(artistId);

    const artworkId = await createArtwork({
      tenantId,
      showInGallery: false,
      status: "AVAILABLE",
      representedArtistId: artistId,
    });
    createdArtworkIds.push(artworkId);

    const matched = await runArtistQuery([artistId]);

    // showInGallery=false means the EXISTS subquery finds no visible artwork —
    // the artist must not appear in the dropdown.
    expect(matched).toHaveLength(0);
  });

  it("excludes a represented artist whose only artwork has status=HIDDEN", async () => {
    const tenantId = await createTenant();
    createdTenantIds.push(tenantId);

    const artistId = await createRepresentedArtist(tenantId);
    createdArtistIds.push(artistId);

    const artworkId = await createArtwork({
      tenantId,
      showInGallery: true,
      status: "HIDDEN",
      representedArtistId: artistId,
    });
    createdArtworkIds.push(artworkId);

    const matched = await runArtistQuery([artistId]);

    expect(matched).toHaveLength(0);
  });

  it("excludes a represented artist with no artworks at all", async () => {
    const tenantId = await createTenant();
    createdTenantIds.push(tenantId);

    const artistId = await createRepresentedArtist(tenantId);
    createdArtistIds.push(artistId);

    // No artworks — the EXISTS subquery will return nothing.
    const matched = await runArtistQuery([artistId]);

    expect(matched).toHaveLength(0);
  });

  it("includes a represented artist whose artwork is visible (showInGallery=true, status=AVAILABLE)", async () => {
    const tenantId = await createTenant();
    createdTenantIds.push(tenantId);

    const artistId = await createRepresentedArtist(tenantId);
    createdArtistIds.push(artistId);

    const artworkId = await createArtwork({
      tenantId,
      showInGallery: true,
      status: "AVAILABLE",
      representedArtistId: artistId,
    });
    createdArtworkIds.push(artworkId);

    const matched = await runArtistQuery([artistId]);

    expect(matched).toHaveLength(1);
    expect(matched[0]).toBe(artistId);
  });

  it("includes an artist when at least one artwork is visible (even if another is hidden)", async () => {
    const tenantId = await createTenant();
    createdTenantIds.push(tenantId);

    const artistId = await createRepresentedArtist(tenantId);
    createdArtistIds.push(artistId);

    const hiddenId = await createArtwork({
      tenantId,
      showInGallery: false,
      status: "AVAILABLE",
      representedArtistId: artistId,
    });
    const visibleId = await createArtwork({
      tenantId,
      showInGallery: true,
      status: "AVAILABLE",
      representedArtistId: artistId,
    });
    createdArtworkIds.push(hiddenId, visibleId);

    const matched = await runArtistQuery([artistId]);

    // The visible artwork satisfies the EXISTS — the artist must appear.
    expect(matched).toHaveLength(1);
  });

  it("returns only the artist with a visible artwork when compared side-by-side with a hidden-only artist", async () => {
    const tenantId = await createTenant();
    createdTenantIds.push(tenantId);

    const visibleArtistId = await createRepresentedArtist(tenantId);
    const hiddenArtistId = await createRepresentedArtist(tenantId);
    createdArtistIds.push(visibleArtistId, hiddenArtistId);

    const visibleArtworkId = await createArtwork({
      tenantId,
      showInGallery: true,
      status: "AVAILABLE",
      representedArtistId: visibleArtistId,
    });
    const hiddenArtworkId = await createArtwork({
      tenantId,
      showInGallery: false,
      status: "AVAILABLE",
      representedArtistId: hiddenArtistId,
    });
    createdArtworkIds.push(visibleArtworkId, hiddenArtworkId);

    const matched = await runArtistQuery([visibleArtistId, hiddenArtistId]);

    expect(matched).toHaveLength(1);
    expect(matched[0]).toBe(visibleArtistId);
  });

  it("excludes an artist whose artwork is linked to a storefrontEnabled=false tenant", async () => {
    // Even though the artist record exists and the artwork is showInGallery=true,
    // the representedArtistFilterWhere() also requires storefrontEnabled=true via
    // the JOIN to tenantsTable — a disabled storefront must exclude the artist.
    const tenantId = await createTenant();
    createdTenantIds.push(tenantId);

    const artistId = await createRepresentedArtist(tenantId);
    createdArtistIds.push(artistId);

    const artworkId = await createArtwork({
      tenantId,
      showInGallery: true,
      status: "AVAILABLE",
      representedArtistId: artistId,
    });
    createdArtworkIds.push(artworkId);

    // Disable the storefront after seeding.
    await db
      .update(tenantsTable)
      .set({ storefrontEnabled: false } as any)
      .where(eq(tenantsTable.id, tenantId));

    const matched = await runArtistQuery([artistId]);

    // storefrontEnabled=false must exclude the artist.
    expect(matched).toHaveLength(0);

    // Re-enable so cleanup works cleanly.
    await db
      .update(tenantsTable)
      .set({ storefrontEnabled: true } as any)
      .where(eq(tenantsTable.id, tenantId));
  });
});
