/**
 * Integration tests: the public /browse sellerType filter must return only
 * artworks whose tenant matches the requested seller type (ARTIST or FRAMER).
 *
 * These complement the mock-based browse-visibility.test.ts by running the
 * buildBrowseWhere() clause against a real PostgreSQL instance, catching any
 * gap between the query shape and what the database actually executes (e.g.
 * type or enum mismatches the mock cannot surface).
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

/** Minimal tenant insert with a required type (ARTIST or FRAMER). */
async function createTenant(overrides: {
  id?: string;
  type: "ARTIST" | "FRAMER";
  storefrontEnabled?: boolean;
}) {
  const id = overrides.id ?? uid();
  await db.insert(tenantsTable).values({
    id,
    type: overrides.type,
    businessName: `Test Gallery ${id}`,
    slug: `test-slug-${id}`,
    storefrontEnabled: overrides.storefrontEnabled ?? true,
  } as any);
  return id;
}

/** Minimal artwork insert — showInGallery=true, status=AVAILABLE by default. */
async function createArtwork(overrides: {
  tenantId: string;
  showInGallery?: boolean;
  status?: "AVAILABLE" | "SOLD" | "RESERVED" | "HIDDEN";
}) {
  const id = uid();
  await db.insert(artworksTable).values({
    id,
    tenantId: overrides.tenantId,
    title: `Test Artwork ${id}`,
    sku: `SKU-${id}`,
    showInGallery: overrides.showInGallery ?? true,
    status: overrides.status ?? "AVAILABLE",
  } as any);
  return id;
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
  // FK chain: artwork_category_on_artwork rows cascade-delete when artworks
  // or categories are removed.  Delete artworks first, then categories, then tenants.
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

describeIntegration("browse query — sellerType filter", () => {
  it("returns only the ARTIST artwork when filtering by sellerType=ARTIST", async () => {
    // Seed one ARTIST tenant and one FRAMER tenant, both with enabled storefronts.
    const artistTenantId = await createTenant({ type: "ARTIST", storefrontEnabled: true });
    const framerTenantId = await createTenant({ type: "FRAMER", storefrontEnabled: true });
    createdTenantIds.push(artistTenantId, framerTenantId);

    const artistArtworkId = await createArtwork({ tenantId: artistTenantId, status: "AVAILABLE" });
    const framerArtworkId = await createArtwork({ tenantId: framerTenantId, status: "AVAILABLE" });
    createdArtworkIds.push(artistArtworkId, framerArtworkId);

    const rows = await runBrowseQuery({ sellerType: "ARTIST" });

    // Filter to only the rows we seeded (other tests may have left rows in the DB).
    const seededIds = new Set<string>([artistArtworkId, framerArtworkId]);
    const matched = rows.filter((r) => seededIds.has(r.artworkId));

    expect(matched).toHaveLength(1);
    expect(matched[0].artworkId).toBe(artistArtworkId);
  });

  it("returns only the FRAMER artwork when filtering by sellerType=FRAMER", async () => {
    // Seed one ARTIST tenant and one FRAMER tenant, both with enabled storefronts.
    const artistTenantId = await createTenant({ type: "ARTIST", storefrontEnabled: true });
    const framerTenantId = await createTenant({ type: "FRAMER", storefrontEnabled: true });
    createdTenantIds.push(artistTenantId, framerTenantId);

    const artistArtworkId = await createArtwork({ tenantId: artistTenantId, status: "AVAILABLE" });
    const framerArtworkId = await createArtwork({ tenantId: framerTenantId, status: "AVAILABLE" });
    createdArtworkIds.push(artistArtworkId, framerArtworkId);

    const rows = await runBrowseQuery({ sellerType: "FRAMER" });

    const seededIds = new Set<string>([artistArtworkId, framerArtworkId]);
    const matched = rows.filter((r) => seededIds.has(r.artworkId));

    expect(matched).toHaveLength(1);
    expect(matched[0].artworkId).toBe(framerArtworkId);
  });

  it("returns artworks from both types when no sellerType filter is applied (control)", async () => {
    const artistTenantId = await createTenant({ type: "ARTIST", storefrontEnabled: true });
    const framerTenantId = await createTenant({ type: "FRAMER", storefrontEnabled: true });
    createdTenantIds.push(artistTenantId, framerTenantId);

    const artistArtworkId = await createArtwork({ tenantId: artistTenantId, status: "AVAILABLE" });
    const framerArtworkId = await createArtwork({ tenantId: framerTenantId, status: "AVAILABLE" });
    createdArtworkIds.push(artistArtworkId, framerArtworkId);

    const rows = await runBrowseQuery(); // no sellerType filter

    const seededIds = new Set<string>([artistArtworkId, framerArtworkId]);
    const matched = rows.filter((r) => seededIds.has(r.artworkId));

    expect(matched).toHaveLength(2);
  });

  it("excludes an ARTIST artwork whose storefront is disabled", async () => {
    // Disabled storefront should still be excluded even if sellerType matches.
    const disabledTenantId = await createTenant({ type: "ARTIST", storefrontEnabled: false });
    const enabledTenantId = await createTenant({ type: "ARTIST", storefrontEnabled: true });
    createdTenantIds.push(disabledTenantId, enabledTenantId);

    const disabledArtworkId = await createArtwork({ tenantId: disabledTenantId, status: "AVAILABLE" });
    const enabledArtworkId = await createArtwork({ tenantId: enabledTenantId, status: "AVAILABLE" });
    createdArtworkIds.push(disabledArtworkId, enabledArtworkId);

    const rows = await runBrowseQuery({ sellerType: "ARTIST" });

    const seededIds = new Set<string>([disabledArtworkId, enabledArtworkId]);
    const matched = rows.filter((r) => seededIds.has(r.artworkId));

    // Only the enabled-storefront artwork should appear.
    expect(matched).toHaveLength(1);
    expect(matched[0].artworkId).toBe(enabledArtworkId);
  });

  it("ignores an unrecognised sellerType value and returns artworks of all types", async () => {
    const artistTenantId = await createTenant({ type: "ARTIST", storefrontEnabled: true });
    const framerTenantId = await createTenant({ type: "FRAMER", storefrontEnabled: true });
    createdTenantIds.push(artistTenantId, framerTenantId);

    const artistArtworkId = await createArtwork({ tenantId: artistTenantId, status: "AVAILABLE" });
    const framerArtworkId = await createArtwork({ tenantId: framerTenantId, status: "AVAILABLE" });
    createdArtworkIds.push(artistArtworkId, framerArtworkId);

    // An unrecognised value should be ignored (code only accepts ARTIST or FRAMER).
    const rows = await runBrowseQuery({ sellerType: "UNKNOWN" });

    const seededIds = new Set<string>([artistArtworkId, framerArtworkId]);
    const matched = rows.filter((r) => seededIds.has(r.artworkId));

    expect(matched).toHaveLength(2);
  });
});

describeIntegration("browse query — sellerType filter with SOLD / RESERVED / HIDDEN statuses", () => {
  it("returns a SOLD ARTIST artwork when filtering by sellerType=ARTIST", async () => {
    const artistTenantId = await createTenant({ type: "ARTIST", storefrontEnabled: true });
    const framerTenantId = await createTenant({ type: "FRAMER", storefrontEnabled: true });
    createdTenantIds.push(artistTenantId, framerTenantId);

    const artistArtworkId = await createArtwork({ tenantId: artistTenantId, status: "SOLD" });
    const framerArtworkId = await createArtwork({ tenantId: framerTenantId, status: "SOLD" });
    createdArtworkIds.push(artistArtworkId, framerArtworkId);

    const rows = await runBrowseQuery({ sellerType: "ARTIST" });

    const seededIds = new Set<string>([artistArtworkId, framerArtworkId]);
    const matched = rows.filter((r) => seededIds.has(r.artworkId));

    expect(matched).toHaveLength(1);
    expect(matched[0].artworkId).toBe(artistArtworkId);
  });

  it("returns a RESERVED ARTIST artwork when filtering by sellerType=ARTIST", async () => {
    const artistTenantId = await createTenant({ type: "ARTIST", storefrontEnabled: true });
    const framerTenantId = await createTenant({ type: "FRAMER", storefrontEnabled: true });
    createdTenantIds.push(artistTenantId, framerTenantId);

    const artistArtworkId = await createArtwork({ tenantId: artistTenantId, status: "RESERVED" });
    const framerArtworkId = await createArtwork({ tenantId: framerTenantId, status: "RESERVED" });
    createdArtworkIds.push(artistArtworkId, framerArtworkId);

    const rows = await runBrowseQuery({ sellerType: "ARTIST" });

    const seededIds = new Set<string>([artistArtworkId, framerArtworkId]);
    const matched = rows.filter((r) => seededIds.has(r.artworkId));

    expect(matched).toHaveLength(1);
    expect(matched[0].artworkId).toBe(artistArtworkId);
  });

  it("returns a SOLD FRAMER artwork when filtering by sellerType=FRAMER", async () => {
    const artistTenantId = await createTenant({ type: "ARTIST", storefrontEnabled: true });
    const framerTenantId = await createTenant({ type: "FRAMER", storefrontEnabled: true });
    createdTenantIds.push(artistTenantId, framerTenantId);

    const artistArtworkId = await createArtwork({ tenantId: artistTenantId, status: "SOLD" });
    const framerArtworkId = await createArtwork({ tenantId: framerTenantId, status: "SOLD" });
    createdArtworkIds.push(artistArtworkId, framerArtworkId);

    const rows = await runBrowseQuery({ sellerType: "FRAMER" });

    const seededIds = new Set<string>([artistArtworkId, framerArtworkId]);
    const matched = rows.filter((r) => seededIds.has(r.artworkId));

    expect(matched).toHaveLength(1);
    expect(matched[0].artworkId).toBe(framerArtworkId);
  });

  it("returns a RESERVED FRAMER artwork when filtering by sellerType=FRAMER", async () => {
    const artistTenantId = await createTenant({ type: "ARTIST", storefrontEnabled: true });
    const framerTenantId = await createTenant({ type: "FRAMER", storefrontEnabled: true });
    createdTenantIds.push(artistTenantId, framerTenantId);

    const artistArtworkId = await createArtwork({ tenantId: artistTenantId, status: "RESERVED" });
    const framerArtworkId = await createArtwork({ tenantId: framerTenantId, status: "RESERVED" });
    createdArtworkIds.push(artistArtworkId, framerArtworkId);

    const rows = await runBrowseQuery({ sellerType: "FRAMER" });

    const seededIds = new Set<string>([artistArtworkId, framerArtworkId]);
    const matched = rows.filter((r) => seededIds.has(r.artworkId));

    expect(matched).toHaveLength(1);
    expect(matched[0].artworkId).toBe(framerArtworkId);
  });

  it("excludes HIDDEN artworks even when their tenant type matches the sellerType filter", async () => {
    const artistTenantId = await createTenant({ type: "ARTIST", storefrontEnabled: true });
    createdTenantIds.push(artistTenantId);

    const hiddenArtworkId = await createArtwork({ tenantId: artistTenantId, status: "HIDDEN" });
    const visibleArtworkId = await createArtwork({ tenantId: artistTenantId, status: "AVAILABLE" });
    createdArtworkIds.push(hiddenArtworkId, visibleArtworkId);

    const rows = await runBrowseQuery({ sellerType: "ARTIST" });

    const seededIds = new Set<string>([hiddenArtworkId, visibleArtworkId]);
    const matched = rows.filter((r) => seededIds.has(r.artworkId));

    // Only the AVAILABLE artwork should appear; the HIDDEN one must be excluded.
    expect(matched).toHaveLength(1);
    expect(matched[0].artworkId).toBe(visibleArtworkId);
  });

  it("excludes HIDDEN FRAMER artworks even when sellerType=FRAMER is requested", async () => {
    const framerTenantId = await createTenant({ type: "FRAMER", storefrontEnabled: true });
    createdTenantIds.push(framerTenantId);

    const hiddenArtworkId = await createArtwork({ tenantId: framerTenantId, status: "HIDDEN" });
    const soldArtworkId = await createArtwork({ tenantId: framerTenantId, status: "SOLD" });
    createdArtworkIds.push(hiddenArtworkId, soldArtworkId);

    const rows = await runBrowseQuery({ sellerType: "FRAMER" });

    const seededIds = new Set<string>([hiddenArtworkId, soldArtworkId]);
    const matched = rows.filter((r) => seededIds.has(r.artworkId));

    // HIDDEN must be excluded; the SOLD artwork must appear.
    expect(matched).toHaveLength(1);
    expect(matched[0].artworkId).toBe(soldArtworkId);
  });
});

// ── seller (slug) filter ───────────────────────────────────────────────────────

/** Creates a tenant with a deterministic slug so we can pass it as a filter. */
async function createTenantWithSlug(overrides: {
  type: "ARTIST" | "FRAMER";
  slug: string;
  storefrontEnabled?: boolean;
}) {
  const id = uid();
  await db.insert(tenantsTable).values({
    id,
    type: overrides.type,
    businessName: `Test Gallery ${id}`,
    slug: overrides.slug,
    storefrontEnabled: overrides.storefrontEnabled ?? true,
  } as any);
  return id;
}

describeIntegration("browse query — seller (slug) filter", () => {
  it("returns an AVAILABLE artwork when filtering by seller=slug", async () => {
    const slug = `slug-avail-${uid()}`;
    const targetTenantId = await createTenantWithSlug({ type: "ARTIST", slug });
    const otherTenantId = await createTenant({ type: "ARTIST", storefrontEnabled: true });
    createdTenantIds.push(targetTenantId, otherTenantId);

    const targetArtworkId = await createArtwork({ tenantId: targetTenantId, status: "AVAILABLE" });
    const otherArtworkId = await createArtwork({ tenantId: otherTenantId, status: "AVAILABLE" });
    createdArtworkIds.push(targetArtworkId, otherArtworkId);

    const rows = await runBrowseQuery({ seller: slug });

    const seededIds = new Set<string>([targetArtworkId, otherArtworkId]);
    const matched = rows.filter((r) => seededIds.has(r.artworkId));

    expect(matched).toHaveLength(1);
    expect(matched[0].artworkId).toBe(targetArtworkId);
  });

  it("returns a SOLD artwork when filtering by seller=slug", async () => {
    const slug = `slug-sold-${uid()}`;
    const targetTenantId = await createTenantWithSlug({ type: "ARTIST", slug });
    const otherTenantId = await createTenant({ type: "ARTIST", storefrontEnabled: true });
    createdTenantIds.push(targetTenantId, otherTenantId);

    const targetArtworkId = await createArtwork({ tenantId: targetTenantId, status: "SOLD" });
    const otherArtworkId = await createArtwork({ tenantId: otherTenantId, status: "SOLD" });
    createdArtworkIds.push(targetArtworkId, otherArtworkId);

    const rows = await runBrowseQuery({ seller: slug });

    const seededIds = new Set<string>([targetArtworkId, otherArtworkId]);
    const matched = rows.filter((r) => seededIds.has(r.artworkId));

    expect(matched).toHaveLength(1);
    expect(matched[0].artworkId).toBe(targetArtworkId);
  });

  it("returns a RESERVED artwork when filtering by seller=slug", async () => {
    const slug = `slug-reserved-${uid()}`;
    const targetTenantId = await createTenantWithSlug({ type: "FRAMER", slug });
    const otherTenantId = await createTenant({ type: "FRAMER", storefrontEnabled: true });
    createdTenantIds.push(targetTenantId, otherTenantId);

    const targetArtworkId = await createArtwork({ tenantId: targetTenantId, status: "RESERVED" });
    const otherArtworkId = await createArtwork({ tenantId: otherTenantId, status: "RESERVED" });
    createdArtworkIds.push(targetArtworkId, otherArtworkId);

    const rows = await runBrowseQuery({ seller: slug });

    const seededIds = new Set<string>([targetArtworkId, otherArtworkId]);
    const matched = rows.filter((r) => seededIds.has(r.artworkId));

    expect(matched).toHaveLength(1);
    expect(matched[0].artworkId).toBe(targetArtworkId);
  });

  it("returns all non-HIDDEN statuses (AVAILABLE, SOLD, RESERVED) for a slug in one query", async () => {
    const slug = `slug-multi-${uid()}`;
    const targetTenantId = await createTenantWithSlug({ type: "ARTIST", slug });
    createdTenantIds.push(targetTenantId);

    const availableId = await createArtwork({ tenantId: targetTenantId, status: "AVAILABLE" });
    const soldId = await createArtwork({ tenantId: targetTenantId, status: "SOLD" });
    const reservedId = await createArtwork({ tenantId: targetTenantId, status: "RESERVED" });
    const hiddenId = await createArtwork({ tenantId: targetTenantId, status: "HIDDEN" });
    createdArtworkIds.push(availableId, soldId, reservedId, hiddenId);

    const rows = await runBrowseQuery({ seller: slug });

    const seededIds = new Set<string>([availableId, soldId, reservedId, hiddenId]);
    const matched = rows.filter((r) => seededIds.has(r.artworkId));

    // HIDDEN is excluded; the other three statuses must all appear.
    expect(matched).toHaveLength(3);
    const matchedArtworkIds = new Set(matched.map((r) => r.artworkId));
    expect(matchedArtworkIds.has(availableId)).toBe(true);
    expect(matchedArtworkIds.has(soldId)).toBe(true);
    expect(matchedArtworkIds.has(reservedId)).toBe(true);
    expect(matchedArtworkIds.has(hiddenId)).toBe(false);
  });

  it("excludes HIDDEN artworks even when the slug matches", async () => {
    const slug = `slug-hidden-${uid()}`;
    const targetTenantId = await createTenantWithSlug({ type: "ARTIST", slug });
    createdTenantIds.push(targetTenantId);

    const hiddenArtworkId = await createArtwork({ tenantId: targetTenantId, status: "HIDDEN" });
    const visibleArtworkId = await createArtwork({ tenantId: targetTenantId, status: "AVAILABLE" });
    createdArtworkIds.push(hiddenArtworkId, visibleArtworkId);

    const rows = await runBrowseQuery({ seller: slug });

    const seededIds = new Set<string>([hiddenArtworkId, visibleArtworkId]);
    const matched = rows.filter((r) => seededIds.has(r.artworkId));

    // Only the AVAILABLE artwork should appear; HIDDEN must be excluded.
    expect(matched).toHaveLength(1);
    expect(matched[0].artworkId).toBe(visibleArtworkId);
  });

  it("returns no artworks for an unknown slug (no cross-tenant leakage)", async () => {
    const otherTenantId = await createTenant({ type: "ARTIST", storefrontEnabled: true });
    createdTenantIds.push(otherTenantId);

    const otherArtworkId = await createArtwork({ tenantId: otherTenantId, status: "AVAILABLE" });
    createdArtworkIds.push(otherArtworkId);

    const rows = await runBrowseQuery({ seller: `nonexistent-slug-${uid()}` });

    // The other tenant's artwork must not appear.
    expect(rows.some((r) => r.artworkId === otherArtworkId)).toBe(false);
  });
});

// ── Combined sellerType + category filter ─────────────────────────────────────

describeIntegration("browse query — sellerType combined with category filter", () => {
  it("returns only the ARTIST artwork when both sellerType=ARTIST and category are supplied", async () => {
    // Seed an ARTIST tenant and a FRAMER tenant; both have an artwork in the
    // same category name.  The combined filter must return only the ARTIST's.
    const artistTenantId = await createTenant({ type: "ARTIST", storefrontEnabled: true });
    const framerTenantId = await createTenant({ type: "FRAMER", storefrontEnabled: true });
    createdTenantIds.push(artistTenantId, framerTenantId);

    const artistArtworkId = await createArtwork({ tenantId: artistTenantId, status: "AVAILABLE" });
    const framerArtworkId = await createArtwork({ tenantId: framerTenantId, status: "AVAILABLE" });
    createdArtworkIds.push(artistArtworkId, framerArtworkId);

    // Each tenant owns a category with the same name — this is the realistic
    // scenario where the EXISTS subquery must not escape the tenant boundary.
    const artistCategoryId = await createCategory(artistTenantId, "Painting");
    const framerCategoryId = await createCategory(framerTenantId, "Painting");
    createdCategoryIds.push(artistCategoryId, framerCategoryId);

    await assignCategory(artistArtworkId, artistCategoryId);
    await assignCategory(framerArtworkId, framerCategoryId);

    const rows = await runBrowseQuery({ sellerType: "ARTIST", category: "Painting" });

    const seededIds = new Set<string>([artistArtworkId, framerArtworkId]);
    const matched = rows.filter((r) => seededIds.has(r.artworkId));

    expect(matched).toHaveLength(1);
    expect(matched[0].artworkId).toBe(artistArtworkId);
  });

  it("returns only the FRAMER artwork when both sellerType=FRAMER and category are supplied", async () => {
    const artistTenantId = await createTenant({ type: "ARTIST", storefrontEnabled: true });
    const framerTenantId = await createTenant({ type: "FRAMER", storefrontEnabled: true });
    createdTenantIds.push(artistTenantId, framerTenantId);

    const artistArtworkId = await createArtwork({ tenantId: artistTenantId, status: "AVAILABLE" });
    const framerArtworkId = await createArtwork({ tenantId: framerTenantId, status: "AVAILABLE" });
    createdArtworkIds.push(artistArtworkId, framerArtworkId);

    const artistCategoryId = await createCategory(artistTenantId, "Sculpture");
    const framerCategoryId = await createCategory(framerTenantId, "Sculpture");
    createdCategoryIds.push(artistCategoryId, framerCategoryId);

    await assignCategory(artistArtworkId, artistCategoryId);
    await assignCategory(framerArtworkId, framerCategoryId);

    const rows = await runBrowseQuery({ sellerType: "FRAMER", category: "Sculpture" });

    const seededIds = new Set<string>([artistArtworkId, framerArtworkId]);
    const matched = rows.filter((r) => seededIds.has(r.artworkId));

    expect(matched).toHaveLength(1);
    expect(matched[0].artworkId).toBe(framerArtworkId);
  });

  it("returns no artworks when the category exists but belongs to a different seller type", async () => {
    // ARTIST has an artwork in "Photography"; FRAMER has no artwork in that
    // category.  sellerType=FRAMER&category=Photography must return nothing.
    const artistTenantId = await createTenant({ type: "ARTIST", storefrontEnabled: true });
    const framerTenantId = await createTenant({ type: "FRAMER", storefrontEnabled: true });
    createdTenantIds.push(artistTenantId, framerTenantId);

    const artistArtworkId = await createArtwork({ tenantId: artistTenantId, status: "AVAILABLE" });
    const framerArtworkId = await createArtwork({ tenantId: framerTenantId, status: "AVAILABLE" });
    createdArtworkIds.push(artistArtworkId, framerArtworkId);

    // Only the ARTIST tenant has a "Photography" category assignment.
    const categoryId = await createCategory(artistTenantId, "Photography");
    createdCategoryIds.push(categoryId);
    await assignCategory(artistArtworkId, categoryId);

    // FRAMER has no artwork in Photography — the combined filter must return nothing.
    const rows = await runBrowseQuery({ sellerType: "FRAMER", category: "Photography" });

    const seededIds = new Set<string>([artistArtworkId, framerArtworkId]);
    const matched = rows.filter((r) => seededIds.has(r.artworkId));

    expect(matched).toHaveLength(0);
  });

  it("excludes HIDDEN artworks even when both sellerType and category match", async () => {
    const artistTenantId = await createTenant({ type: "ARTIST", storefrontEnabled: true });
    createdTenantIds.push(artistTenantId);

    const hiddenId = await createArtwork({ tenantId: artistTenantId, status: "HIDDEN" });
    const visibleId = await createArtwork({ tenantId: artistTenantId, status: "AVAILABLE" });
    createdArtworkIds.push(hiddenId, visibleId);

    const categoryId = await createCategory(artistTenantId, "Drawing");
    createdCategoryIds.push(categoryId);
    await assignCategory(hiddenId, categoryId);
    await assignCategory(visibleId, categoryId);

    const rows = await runBrowseQuery({ sellerType: "ARTIST", category: "Drawing" });

    const seededIds = new Set<string>([hiddenId, visibleId]);
    const matched = rows.filter((r) => seededIds.has(r.artworkId));

    // HIDDEN artwork must be excluded; only the AVAILABLE one appears.
    expect(matched).toHaveLength(1);
    expect(matched[0].artworkId).toBe(visibleId);
  });

  it("returns both ARTIST artworks in the category when sellerType=ARTIST but two artists exist", async () => {
    // Two ARTIST tenants both have artworks in the same category.
    // sellerType=ARTIST&category=Print must return both, not just one.
    const artist1Id = await createTenant({ type: "ARTIST", storefrontEnabled: true });
    const artist2Id = await createTenant({ type: "ARTIST", storefrontEnabled: true });
    const framerTenantId = await createTenant({ type: "FRAMER", storefrontEnabled: true });
    createdTenantIds.push(artist1Id, artist2Id, framerTenantId);

    const artwork1Id = await createArtwork({ tenantId: artist1Id, status: "AVAILABLE" });
    const artwork2Id = await createArtwork({ tenantId: artist2Id, status: "AVAILABLE" });
    const framerArtworkId = await createArtwork({ tenantId: framerTenantId, status: "AVAILABLE" });
    createdArtworkIds.push(artwork1Id, artwork2Id, framerArtworkId);

    const cat1Id = await createCategory(artist1Id, "Print");
    const cat2Id = await createCategory(artist2Id, "Print");
    const catFramerId = await createCategory(framerTenantId, "Print");
    createdCategoryIds.push(cat1Id, cat2Id, catFramerId);

    await assignCategory(artwork1Id, cat1Id);
    await assignCategory(artwork2Id, cat2Id);
    await assignCategory(framerArtworkId, catFramerId);

    const rows = await runBrowseQuery({ sellerType: "ARTIST", category: "Print" });

    const seededIds = new Set<string>([artwork1Id, artwork2Id, framerArtworkId]);
    const matched = rows.filter((r) => seededIds.has(r.artworkId));

    // Both ARTIST artworks appear; the FRAMER one must not.
    expect(matched).toHaveLength(2);
    const matchedArtworkIds = new Set(matched.map((r) => r.artworkId));
    expect(matchedArtworkIds.has(artwork1Id)).toBe(true);
    expect(matchedArtworkIds.has(artwork2Id)).toBe(true);
    expect(matchedArtworkIds.has(framerArtworkId)).toBe(false);
  });
});
