/**
 * Integration tests: the public /browse location + keyword (q=) filters must
 * both be satisfied simultaneously — an artwork must match the location AND the
 * keyword to appear in results.
 *
 * The key risk is an OR/AND precedence bug in buildBrowseWhere() where the
 * keyword OR across title/artist/businessName accidentally swallows the
 * location AND, returning artworks from the wrong location.
 *
 * Follows the pattern in browse-location-filter-integration.test.ts and
 * browse-keyword-search-integration.test.ts.
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

/** Minimal tenant insert with optional location and businessName. */
async function createTenant(overrides: {
  id?: string;
  type?: "ARTIST" | "FRAMER";
  businessName?: string;
  storefrontEnabled?: boolean;
  location?: string;
}) {
  const id = overrides.id ?? uid();
  await db.insert(tenantsTable).values({
    id,
    type: overrides.type ?? "ARTIST",
    businessName: overrides.businessName ?? `Test Gallery ${id}`,
    slug: `test-slug-${id}`,
    storefrontEnabled: overrides.storefrontEnabled ?? true,
    location: overrides.location,
  } as any);
  return id;
}

/** Minimal artwork insert — showInGallery=true, status=AVAILABLE by default. */
async function createArtwork(overrides: {
  tenantId: string;
  title?: string;
  representedArtistId?: string;
  showInGallery?: boolean;
  status?: "AVAILABLE" | "SOLD" | "RESERVED" | "HIDDEN";
}) {
  const id = uid();
  await db.insert(artworksTable).values({
    id,
    tenantId: overrides.tenantId,
    title: overrides.title ?? `Test Artwork ${id}`,
    sku: `SKU-${id}`,
    representedArtistId: overrides.representedArtistId ?? null,
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
const createdArtistIds: string[] = [];

beforeEach(() => {
  createdTenantIds.length = 0;
  createdArtworkIds.length = 0;
  createdArtistIds.length = 0;
});

afterEach(async () => {
  // FK order: artworks reference tenants and represented_artists; delete them first.
  for (const id of createdArtworkIds) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describeIntegration("browse query — combined location + keyword filter", () => {
  it("returns only the artwork that satisfies both location and keyword", async () => {
    // Tenant A: the target location ("Sydney")
    const sydneyTenantId = await createTenant({
      storefrontEnabled: true,
      location: "Sydney",
    });
    // Tenant B: a different location ("Melbourne")
    const melbourneTenantId = await createTenant({
      storefrontEnabled: true,
      location: "Melbourne",
    });
    createdTenantIds.push(sydneyTenantId, melbourneTenantId);

    // Artwork A: at Sydney AND title matches keyword — should appear.
    const matchBothId = await createArtwork({
      tenantId: sydneyTenantId,
      title: "Vivid Harbour Lights",
    });

    // Artwork B: at Sydney but title does NOT match keyword — should not appear.
    const locationOnlyId = await createArtwork({
      tenantId: sydneyTenantId,
      title: "Quiet Bush Track",
    });

    // Artwork C: title matches keyword but is at Melbourne — should not appear.
    const keywordOnlyId = await createArtwork({
      tenantId: melbourneTenantId,
      title: "Vivid Harbour Lights Replica",
    });

    createdArtworkIds.push(matchBothId, locationOnlyId, keywordOnlyId);

    const rows = await runBrowseQuery({ q: "Vivid Harbour", location: "Sydney" });
    const seeded = new Set<string>([matchBothId, locationOnlyId, keywordOnlyId]);
    const matched = rows.filter((r) => seeded.has(r.artworkId));

    // Only the artwork that satisfies both conditions should appear.
    expect(matched).toHaveLength(1);
    expect(matched[0].artworkId).toBe(matchBothId);
  });

  it("excludes the keyword-matched artwork at the wrong location", async () => {
    // Focus: the keyword-matching artwork at the wrong location must be absent.
    const sydneyTenantId = await createTenant({
      storefrontEnabled: true,
      location: "Sydney",
    });
    const melbourneTenantId = await createTenant({
      storefrontEnabled: true,
      location: "Melbourne",
    });
    createdTenantIds.push(sydneyTenantId, melbourneTenantId);

    // Sydney artwork — matches keyword, correct location.
    const sydneyMatchId = await createArtwork({
      tenantId: sydneyTenantId,
      title: "Golden Ochre Landscape",
    });

    // Melbourne artwork — matches same keyword, wrong location.
    const melbourneMatchId = await createArtwork({
      tenantId: melbourneTenantId,
      title: "Golden Ochre Abstract",
    });

    createdArtworkIds.push(sydneyMatchId, melbourneMatchId);

    const rows = await runBrowseQuery({ q: "Golden Ochre", location: "Sydney" });
    const matchedIds = rows.map((r) => r.artworkId);

    expect(matchedIds).toContain(sydneyMatchId);
    expect(matchedIds).not.toContain(melbourneMatchId);
  });

  it("excludes the location-matched artwork that does not satisfy the keyword", async () => {
    // Focus: the artwork at the right location but wrong title must be absent.
    const sydneyTenantId = await createTenant({
      storefrontEnabled: true,
      location: "Sydney",
    });
    createdTenantIds.push(sydneyTenantId);

    // Artwork A: correct location + keyword matches — should appear.
    const matchBothId = await createArtwork({
      tenantId: sydneyTenantId,
      title: "Morning Mist Series",
    });

    // Artwork B: correct location but keyword does not match — should not appear.
    const locationOnlyId = await createArtwork({
      tenantId: sydneyTenantId,
      title: "Evening Shadows",
    });

    createdArtworkIds.push(matchBothId, locationOnlyId);

    const rows = await runBrowseQuery({ q: "Morning Mist", location: "Sydney" });
    const matchedIds = rows.map((r) => r.artworkId);

    expect(matchedIds).toContain(matchBothId);
    expect(matchedIds).not.toContain(locationOnlyId);
  });

  it("returns nothing when the keyword matches no artwork at the specified location", async () => {
    // Artwork at Sydney whose title does not match the keyword at all.
    const sydneyTenantId = await createTenant({
      storefrontEnabled: true,
      location: "Sydney",
    });
    createdTenantIds.push(sydneyTenantId);

    const artworkId = await createArtwork({
      tenantId: sydneyTenantId,
      title: "Coastal Serenity",
    });
    createdArtworkIds.push(artworkId);

    const rows = await runBrowseQuery({ q: "zzznomatch_xqz", location: "Sydney" });
    const matched = rows.filter((r) => r.artworkId === artworkId);

    expect(matched).toHaveLength(0);
  });

  it("keyword matching via business name still respects the location filter", async () => {
    // The OR in the keyword clause covers businessName — this test confirms the
    // AND with location is not broken when the keyword match comes from that branch.
    const sydneyTenantId = await createTenant({
      storefrontEnabled: true,
      location: "Sydney",
      businessName: "Vivid Arts Sydney",
    });
    const melbourneTenantId = await createTenant({
      storefrontEnabled: true,
      location: "Melbourne",
      businessName: "Vivid Arts Melbourne",
    });
    createdTenantIds.push(sydneyTenantId, melbourneTenantId);

    // One artwork per gallery — neither title matches "Vivid Arts", so the match
    // comes through the businessName branch of the keyword OR.
    const sydneyArtworkId = await createArtwork({
      tenantId: sydneyTenantId,
      title: "Untitled Work A",
    });
    const melbourneArtworkId = await createArtwork({
      tenantId: melbourneTenantId,
      title: "Untitled Work B",
    });
    createdArtworkIds.push(sydneyArtworkId, melbourneArtworkId);

    const rows = await runBrowseQuery({ q: "Vivid Arts", location: "Sydney" });
    const matchedIds = rows.map((r) => r.artworkId);

    // Only the Sydney artwork should appear even though both galleries' names match
    // the keyword — the location filter must AND correctly with the keyword OR.
    expect(matchedIds).toContain(sydneyArtworkId);
    expect(matchedIds).not.toContain(melbourneArtworkId);
  });

  it("returns all location-matched artworks when no keyword is supplied (control)", async () => {
    const sydneyTenantId = await createTenant({
      storefrontEnabled: true,
      location: "Sydney",
    });
    const melbourneTenantId = await createTenant({
      storefrontEnabled: true,
      location: "Melbourne",
    });
    createdTenantIds.push(sydneyTenantId, melbourneTenantId);

    const sydneyArtworkId = await createArtwork({
      tenantId: sydneyTenantId,
      title: "Work X",
    });
    const melbourneArtworkId = await createArtwork({
      tenantId: melbourneTenantId,
      title: "Work Y",
    });
    createdArtworkIds.push(sydneyArtworkId, melbourneArtworkId);

    // Location only — no keyword — should return only the Sydney artwork.
    const rows = await runBrowseQuery({ location: "Sydney" });
    const matchedIds = rows.map((r) => r.artworkId);

    expect(matchedIds).toContain(sydneyArtworkId);
    expect(matchedIds).not.toContain(melbourneArtworkId);
  });
});
