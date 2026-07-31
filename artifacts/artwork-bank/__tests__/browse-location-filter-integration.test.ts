/**
 * Integration tests: the public /browse location filter must return only
 * artworks whose tenant is in the requested location.
 *
 * These complement the mock-based browse-visibility.test.ts by running the
 * buildBrowseWhere() clause against a real PostgreSQL instance, catching any
 * gap between the query shape and what the database actually executes (e.g.
 * type or collation mismatches the mock cannot surface).
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
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { buildBrowseWhere } from "@/lib/browse-where";
import { locationFilterWhere } from "@/lib/browse-filter-options";

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid() {
  return randomUUID();
}

/** Minimal tenant insert with an optional location. */
async function createTenant(overrides: {
  id?: string;
  storefrontEnabled?: boolean;
  location?: string;
}) {
  const id = overrides.id ?? uid();
  await db.insert(tenantsTable).values({
    id,
    type: "ARTIST",
    businessName: `Test Gallery ${id}`,
    slug: `test-slug-${id}`,
    storefrontEnabled: overrides.storefrontEnabled ?? true,
    location: overrides.location,
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

// Track created row IDs for cleanup.
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];

beforeEach(() => {
  createdTenantIds.length = 0;
  createdArtworkIds.length = 0;
});

afterEach(async () => {
  // FK: artworks reference tenants, so delete artworks first.
  for (const id of createdArtworkIds) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describeIntegration("browse query — location filter", () => {
  it("returns only the Sydney artwork when filtering by location=Sydney", async () => {
    // Seed two tenants in different locations, both with enabled storefronts.
    const sydneyTenantId = await createTenant({ storefrontEnabled: true, location: "Sydney" });
    const melbourneTenantId = await createTenant({ storefrontEnabled: true, location: "Melbourne" });
    createdTenantIds.push(sydneyTenantId, melbourneTenantId);

    const sydneyArtworkId = await createArtwork({ tenantId: sydneyTenantId, status: "AVAILABLE" });
    const melbourneArtworkId = await createArtwork({ tenantId: melbourneTenantId, status: "AVAILABLE" });
    createdArtworkIds.push(sydneyArtworkId, melbourneArtworkId);

    const rows = await runBrowseQuery({ location: "Sydney" });

    // Filter to only the rows we seeded (other tests may have left rows in the DB).
    const seededIds = new Set<string>([sydneyArtworkId, melbourneArtworkId]);
    const matched = rows.filter((r) => seededIds.has(r.artworkId));

    expect(matched).toHaveLength(1);
    expect(matched[0].artworkId).toBe(sydneyArtworkId);
  });

  it("returns only the Melbourne artwork when filtering by location=Melbourne", async () => {
    // Seed two tenants in different locations, both with enabled storefronts.
    const sydneyTenantId = await createTenant({ storefrontEnabled: true, location: "Sydney" });
    const melbourneTenantId = await createTenant({ storefrontEnabled: true, location: "Melbourne" });
    createdTenantIds.push(sydneyTenantId, melbourneTenantId);

    const sydneyArtworkId = await createArtwork({ tenantId: sydneyTenantId, status: "AVAILABLE" });
    const melbourneArtworkId = await createArtwork({ tenantId: melbourneTenantId, status: "AVAILABLE" });
    createdArtworkIds.push(sydneyArtworkId, melbourneArtworkId);

    const rows = await runBrowseQuery({ location: "Melbourne" });

    const seededIds = new Set<string>([sydneyArtworkId, melbourneArtworkId]);
    const matched = rows.filter((r) => seededIds.has(r.artworkId));

    expect(matched).toHaveLength(1);
    expect(matched[0].artworkId).toBe(melbourneArtworkId);
  });

  it("returns artworks from both locations when no location filter is applied (control)", async () => {
    const sydneyTenantId = await createTenant({ storefrontEnabled: true, location: "Sydney" });
    const melbourneTenantId = await createTenant({ storefrontEnabled: true, location: "Melbourne" });
    createdTenantIds.push(sydneyTenantId, melbourneTenantId);

    const sydneyArtworkId = await createArtwork({ tenantId: sydneyTenantId, status: "AVAILABLE" });
    const melbourneArtworkId = await createArtwork({ tenantId: melbourneTenantId, status: "AVAILABLE" });
    createdArtworkIds.push(sydneyArtworkId, melbourneArtworkId);

    const rows = await runBrowseQuery(); // no location filter

    const seededIds = new Set<string>([sydneyArtworkId, melbourneArtworkId]);
    const matched = rows.filter((r) => seededIds.has(r.artworkId));

    expect(matched).toHaveLength(2);
  });

  it("excludes a location-matched artwork whose storefront is disabled", async () => {
    // Disabled storefront should still be excluded even if location matches.
    const disabledTenantId = await createTenant({ storefrontEnabled: false, location: "Sydney" });
    const enabledTenantId = await createTenant({ storefrontEnabled: true, location: "Sydney" });
    createdTenantIds.push(disabledTenantId, enabledTenantId);

    const disabledArtworkId = await createArtwork({ tenantId: disabledTenantId, status: "AVAILABLE" });
    const enabledArtworkId = await createArtwork({ tenantId: enabledTenantId, status: "AVAILABLE" });
    createdArtworkIds.push(disabledArtworkId, enabledArtworkId);

    const rows = await runBrowseQuery({ location: "Sydney" });

    const seededIds = new Set<string>([disabledArtworkId, enabledArtworkId]);
    const matched = rows.filter((r) => seededIds.has(r.artworkId));

    // Only the enabled-storefront artwork should appear.
    expect(matched).toHaveLength(1);
    expect(matched[0].artworkId).toBe(enabledArtworkId);
  });
});

// ── locationFilterWhere() dropdown tests ──────────────────────────────────────

/**
 * Run the same tenant query the location dropdown runs and return matching rows.
 * Uses locationFilterWhere() — the function under test.
 */
async function runLocationDropdownQuery() {
  const whereClause = locationFilterWhere();
  return db
    .select({ tenantId: tenantsTable.id, location: tenantsTable.location })
    .from(tenantsTable)
    .where(whereClause);
}

describeIntegration("locationFilterWhere — location dropdown", () => {
  it("excludes a tenant whose only artwork is HIDDEN", async () => {
    // A tenant in "Brisbane" with a single HIDDEN artwork should not appear in
    // the dropdown — selecting it would give the buyer an empty result grid.
    const tenantId = await createTenant({ storefrontEnabled: true, location: "Brisbane" });
    createdTenantIds.push(tenantId);

    const artworkId = await createArtwork({ tenantId, status: "HIDDEN" });
    createdArtworkIds.push(artworkId);

    const rows = await runLocationDropdownQuery();
    const matched = rows.filter((r) => r.tenantId === tenantId);

    expect(matched).toHaveLength(0);
  });

  it("excludes a tenant whose only artwork has showInGallery=false", async () => {
    const tenantId = await createTenant({ storefrontEnabled: true, location: "Adelaide" });
    createdTenantIds.push(tenantId);

    const artworkId = await createArtwork({ tenantId, showInGallery: false, status: "AVAILABLE" });
    createdArtworkIds.push(artworkId);

    const rows = await runLocationDropdownQuery();
    const matched = rows.filter((r) => r.tenantId === tenantId);

    expect(matched).toHaveLength(0);
  });

  it("includes a tenant that has at least one visible artwork", async () => {
    // A tenant in "Perth" with one AVAILABLE artwork must appear in the dropdown.
    const tenantId = await createTenant({ storefrontEnabled: true, location: "Perth" });
    createdTenantIds.push(tenantId);

    const artworkId = await createArtwork({ tenantId, status: "AVAILABLE" });
    createdArtworkIds.push(artworkId);

    const rows = await runLocationDropdownQuery();
    const matched = rows.filter((r) => r.tenantId === tenantId);

    expect(matched).toHaveLength(1);
    expect(matched[0].location).toBe("Perth");
  });

  it("includes a tenant with a mix of hidden and visible artworks", async () => {
    // At least one visible artwork is enough — the hidden one should not prevent inclusion.
    const tenantId = await createTenant({ storefrontEnabled: true, location: "Hobart" });
    createdTenantIds.push(tenantId);

    const hiddenId = await createArtwork({ tenantId, status: "HIDDEN" });
    const visibleId = await createArtwork({ tenantId, status: "AVAILABLE" });
    createdArtworkIds.push(hiddenId, visibleId);

    const rows = await runLocationDropdownQuery();
    const matched = rows.filter((r) => r.tenantId === tenantId);

    expect(matched).toHaveLength(1);
  });

  it("excludes a tenant with a null location even if it has visible artworks", async () => {
    const tenantId = await createTenant({ storefrontEnabled: true, location: undefined });
    createdTenantIds.push(tenantId);

    const artworkId = await createArtwork({ tenantId, status: "AVAILABLE" });
    createdArtworkIds.push(artworkId);

    const rows = await runLocationDropdownQuery();
    const matched = rows.filter((r) => r.tenantId === tenantId);

    expect(matched).toHaveLength(0);
  });
});
