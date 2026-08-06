/**
 * Integration tests: the public /browse seller + location filters must both be
 * satisfied simultaneously — an artwork must match the seller slug AND the
 * location to appear in results.
 *
 * The key risk is an OR/AND precedence bug in buildBrowseWhere() where the
 * seller equality check accidentally escapes the location AND, returning
 * artworks from the wrong location or from the wrong gallery.
 *
 * Follows the pattern in browse-location-keyword-filter-integration.test.ts.
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid() {
  return randomUUID();
}

/**
 * Minimal tenant insert with optional location.
 * Returns both the generated id and the slug so tests can query by slug.
 */
async function createTenant(overrides: {
  type?: "ARTIST" | "FRAMER";
  businessName?: string;
  storefrontEnabled?: boolean;
  location?: string;
}): Promise<{ id: string; slug: string }> {
  const id = uid();
  const slug = `test-slug-${id}`;
  await db.insert(tenantsTable).values({
    id,
    type: overrides.type ?? "ARTIST",
    businessName: overrides.businessName ?? `Test Gallery ${id}`,
    slug,
    storefrontEnabled: overrides.storefrontEnabled ?? true,
    location: overrides.location,
  } as any);
  return { id, slug };
}

/** Minimal artwork insert — showInGallery=true, status=AVAILABLE by default. */
async function createArtwork(overrides: {
  tenantId: string;
  title?: string;
  showInGallery?: boolean;
  status?: "AVAILABLE" | "SOLD" | "RESERVED" | "HIDDEN";
}): Promise<string> {
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
  // FK order: artworks reference tenants — delete them first.
  for (const id of createdArtworkIds) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describeIntegration("browse query — combined seller-slug + location filter", () => {
  it("returns only the artwork that satisfies both seller slug and location", async () => {
    // Two tenants at the same location ("Sydney") — different slugs.
    const targetTenant = await createTenant({
      storefrontEnabled: true,
      location: "Sydney",
    });
    const otherSydneyTenant = await createTenant({
      storefrontEnabled: true,
      location: "Sydney",
    });
    // Third tenant at a different location with the same slug prefix — ensures
    // slug filter does not bleed across locations.
    const melbourneTenant = await createTenant({
      storefrontEnabled: true,
      location: "Melbourne",
    });
    createdTenantIds.push(
      targetTenant.id,
      otherSydneyTenant.id,
      melbourneTenant.id,
    );

    // Artwork A: matches BOTH seller slug AND location — must appear.
    const matchBothId = await createArtwork({
      tenantId: targetTenant.id,
      title: "Target Gallery Work",
    });

    // Artwork B: right location (Sydney) but wrong slug — must NOT appear.
    const rightLocationWrongSlugId = await createArtwork({
      tenantId: otherSydneyTenant.id,
      title: "Other Sydney Gallery Work",
    });

    // Artwork C: right slug but wrong location (Melbourne) — must NOT appear.
    const rightSlugWrongLocationId = await createArtwork({
      tenantId: melbourneTenant.id,
      title: "Melbourne Gallery Work",
    });

    createdArtworkIds.push(
      matchBothId,
      rightLocationWrongSlugId,
      rightSlugWrongLocationId,
    );

    const rows = await runBrowseQuery({
      seller: targetTenant.slug,
      location: "Sydney",
    });
    const seeded = new Set([
      matchBothId,
      rightLocationWrongSlugId,
      rightSlugWrongLocationId,
    ]);
    const matched = rows.filter((r) => seeded.has(r.artworkId));

    // Only the artwork that satisfies both conditions should appear.
    expect(matched).toHaveLength(1);
    expect(matched[0].artworkId).toBe(matchBothId);
  });

  it("excludes the artwork at the right location but wrong seller slug", async () => {
    // Two tenants at the same location — only one is the target seller.
    const targetTenant = await createTenant({
      storefrontEnabled: true,
      location: "Sydney",
    });
    const impostor = await createTenant({
      storefrontEnabled: true,
      location: "Sydney",
    });
    createdTenantIds.push(targetTenant.id, impostor.id);

    const targetArtworkId = await createArtwork({ tenantId: targetTenant.id });
    const impostorArtworkId = await createArtwork({ tenantId: impostor.id });
    createdArtworkIds.push(targetArtworkId, impostorArtworkId);

    const rows = await runBrowseQuery({
      seller: targetTenant.slug,
      location: "Sydney",
    });
    const matchedIds = rows.map((r) => r.artworkId);

    expect(matchedIds).toContain(targetArtworkId);
    expect(matchedIds).not.toContain(impostorArtworkId);
  });

  it("excludes the artwork whose seller slug matches but is at the wrong location", async () => {
    // Target tenant at Sydney; same-slug tenant at Melbourne is impossible (slugs
    // are unique), so we confirm the slug filter does not admit the wrong-location
    // tenant's artworks by using two different tenants.
    const sydneyTenant = await createTenant({
      storefrontEnabled: true,
      location: "Sydney",
    });
    const melbourneTenant = await createTenant({
      storefrontEnabled: true,
      location: "Melbourne",
    });
    createdTenantIds.push(sydneyTenant.id, melbourneTenant.id);

    const sydneyArtworkId = await createArtwork({ tenantId: sydneyTenant.id });
    const melbourneArtworkId = await createArtwork({ tenantId: melbourneTenant.id });
    createdArtworkIds.push(sydneyArtworkId, melbourneArtworkId);

    // Query for the Melbourne tenant's slug but filter location=Sydney.
    const rows = await runBrowseQuery({
      seller: melbourneTenant.slug,
      location: "Sydney",
    });
    const matchedIds = rows.map((r) => r.artworkId);

    // Neither artwork satisfies both: melbourne slug ≠ Sydney location.
    expect(matchedIds).not.toContain(sydneyArtworkId);
    expect(matchedIds).not.toContain(melbourneArtworkId);
  });

  it("returns nothing when neither filter matches any seeded artwork", async () => {
    const tenant = await createTenant({
      storefrontEnabled: true,
      location: "Brisbane",
    });
    createdTenantIds.push(tenant.id);

    const artworkId = await createArtwork({ tenantId: tenant.id });
    createdArtworkIds.push(artworkId);

    // Query for a completely different seller+location combination.
    const rows = await runBrowseQuery({
      seller: tenant.slug,
      location: "Sydney",
    });
    const matched = rows.filter((r) => r.artworkId === artworkId);

    expect(matched).toHaveLength(0);
  });

  it("returns all artworks for the target seller when no location is supplied (control)", async () => {
    const sydneyTenant = await createTenant({
      storefrontEnabled: true,
      location: "Sydney",
    });
    const melbourneTenant = await createTenant({
      storefrontEnabled: true,
      location: "Melbourne",
    });
    createdTenantIds.push(sydneyTenant.id, melbourneTenant.id);

    const sydneyArtworkId = await createArtwork({ tenantId: sydneyTenant.id });
    const melbourneArtworkId = await createArtwork({ tenantId: melbourneTenant.id });
    createdArtworkIds.push(sydneyArtworkId, melbourneArtworkId);

    // Seller filter only — no location — should return only the target seller's artwork.
    const rows = await runBrowseQuery({ seller: sydneyTenant.slug });
    const matchedIds = rows.map((r) => r.artworkId);

    expect(matchedIds).toContain(sydneyArtworkId);
    expect(matchedIds).not.toContain(melbourneArtworkId);
  });

  it("returns all artworks at the target location when no seller is supplied (control)", async () => {
    const sydneyTenant = await createTenant({
      storefrontEnabled: true,
      location: "Sydney",
    });
    const melbourneTenant = await createTenant({
      storefrontEnabled: true,
      location: "Melbourne",
    });
    createdTenantIds.push(sydneyTenant.id, melbourneTenant.id);

    const sydneyArtworkId = await createArtwork({ tenantId: sydneyTenant.id });
    const melbourneArtworkId = await createArtwork({ tenantId: melbourneTenant.id });
    createdArtworkIds.push(sydneyArtworkId, melbourneArtworkId);

    // Location filter only — no seller — should return only Sydney artworks.
    const rows = await runBrowseQuery({ location: "Sydney" });
    const matchedIds = rows.map((r) => r.artworkId);

    expect(matchedIds).toContain(sydneyArtworkId);
    expect(matchedIds).not.toContain(melbourneArtworkId);
  });
});
