/**
 * Integration tests: the public /browse artist filter (artist=) must return
 * only artworks that match the named artist via either:
 *   1. A represented artist row whose `name` equals the filter value, OR
 *   2. An ARTIST-type tenant whose `businessName` equals the filter value.
 *
 * Artworks belonging to a different artist (represented or tenant) must be
 * excluded.  These complement the mock-based unit tests by running
 * buildBrowseWhere() against a real PostgreSQL instance.
 *
 * Follows the pattern in browse-keyword-search-integration.test.ts.
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
import { representedArtistFilterWhere } from "@/lib/browse-filter-options";

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid() {
  return randomUUID();
}

/** Minimal tenant insert; storefrontEnabled defaults to true per the schema. */
async function createTenant(overrides: {
  id?: string;
  type?: "ARTIST" | "FRAMER";
  businessName?: string;
  storefrontEnabled?: boolean;
}) {
  const id = overrides.id ?? uid();
  await db.insert(tenantsTable).values({
    id,
    type: overrides.type ?? "FRAMER",
    businessName: overrides.businessName ?? `Test Gallery ${id}`,
    slug: `test-slug-${id}`,
    storefrontEnabled: overrides.storefrontEnabled ?? true,
  } as any);
  return id;
}

/** Minimal represented artist insert linked to a tenant. */
async function createRepresentedArtist(overrides: {
  tenantId: string;
  name: string;
}) {
  const id = uid();
  await db.insert(representedArtistsTable).values({
    id,
    tenantId: overrides.tenantId,
    name: overrides.name,
  });
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

/**
 * Run the represented-artist dropdown query — the same query the browse page
 * uses to populate the artist filter dropdown.  Returns one row per artist
 * that passes representedArtistFilterWhere().
 */
async function runRepresentedArtistDropdownQuery() {
  return db
    .select({ artistId: representedArtistsTable.id, name: representedArtistsTable.name })
    .from(representedArtistsTable)
    .innerJoin(tenantsTable, eq(tenantsTable.id, representedArtistsTable.tenantId))
    .where(representedArtistFilterWhere());
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

describeIntegration("browse artist filter — represented artist path", () => {
  it("returns an artwork linked to a represented artist whose name matches the filter", async () => {
    const tenantId = await createTenant({ type: "FRAMER" });
    createdTenantIds.push(tenantId);

    const artistId = await createRepresentedArtist({
      tenantId,
      name: "Clara Voss",
    });
    createdArtistIds.push(artistId);

    const artworkId = await createArtwork({
      tenantId,
      title: "Evening Study",
      representedArtistId: artistId,
    });
    createdArtworkIds.push(artworkId);

    const rows = await runBrowseQuery({ artist: "Clara Voss" });
    const matched = rows.filter((r) => r.artworkId === artworkId);

    expect(matched).toHaveLength(1);
  });

  it("excludes an artwork linked to a different represented artist", async () => {
    const tenantId = await createTenant({ type: "FRAMER" });
    createdTenantIds.push(tenantId);

    const targetArtistId = await createRepresentedArtist({
      tenantId,
      name: "Clara Voss",
    });
    const otherArtistId = await createRepresentedArtist({
      tenantId,
      name: "Ben Nakamura",
    });
    createdArtistIds.push(targetArtistId, otherArtistId);

    const matchingArtworkId = await createArtwork({
      tenantId,
      title: "Evening Study",
      representedArtistId: targetArtistId,
    });
    const nonMatchingArtworkId = await createArtwork({
      tenantId,
      title: "Mountain Path",
      representedArtistId: otherArtistId,
    });
    createdArtworkIds.push(matchingArtworkId, nonMatchingArtworkId);

    const rows = await runBrowseQuery({ artist: "Clara Voss" });
    const matchedIds = rows.map((r) => r.artworkId);

    expect(matchedIds).toContain(matchingArtworkId);
    expect(matchedIds).not.toContain(nonMatchingArtworkId);
  });

  it("excludes an artwork with no represented artist when artist filter is set", async () => {
    const tenantId = await createTenant({ type: "FRAMER" });
    createdTenantIds.push(tenantId);

    // Artwork has no representedArtistId.
    const artworkId = await createArtwork({
      tenantId,
      title: "Unattributed Work",
    });
    createdArtworkIds.push(artworkId);

    const rows = await runBrowseQuery({ artist: "Clara Voss" });
    const matched = rows.filter((r) => r.artworkId === artworkId);

    expect(matched).toHaveLength(0);
  });

  it("is case-sensitive for represented artist name (eq, not ilike)", async () => {
    // The artist filter uses eq(), not ilike() — so case must match exactly.
    const tenantId = await createTenant({ type: "FRAMER" });
    createdTenantIds.push(tenantId);

    const artistId = await createRepresentedArtist({
      tenantId,
      name: "Clara Voss",
    });
    createdArtistIds.push(artistId);

    const artworkId = await createArtwork({
      tenantId,
      title: "Evening Study",
      representedArtistId: artistId,
    });
    createdArtworkIds.push(artworkId);

    // Exact match should work.
    const matchRows = await runBrowseQuery({ artist: "Clara Voss" });
    expect(matchRows.filter((r) => r.artworkId === artworkId)).toHaveLength(1);

    // Wrong case should not match (eq is case-sensitive in PostgreSQL).
    const noMatchRows = await runBrowseQuery({ artist: "clara voss" });
    expect(noMatchRows.filter((r) => r.artworkId === artworkId)).toHaveLength(0);
  });
});

describeIntegration("browse artist filter — ARTIST-type tenant path", () => {
  it("returns an artwork from an ARTIST-type tenant whose businessName matches the filter", async () => {
    const tenantId = await createTenant({
      type: "ARTIST",
      businessName: "Sophie Laurent",
    });
    createdTenantIds.push(tenantId);

    const artworkId = await createArtwork({
      tenantId,
      title: "Coastal Dawn",
    });
    createdArtworkIds.push(artworkId);

    const rows = await runBrowseQuery({ artist: "Sophie Laurent" });
    const matched = rows.filter((r) => r.artworkId === artworkId);

    expect(matched).toHaveLength(1);
  });

  it("excludes an artwork from a different ARTIST-type tenant", async () => {
    const targetTenantId = await createTenant({
      type: "ARTIST",
      businessName: "Sophie Laurent",
    });
    const otherTenantId = await createTenant({
      type: "ARTIST",
      businessName: "Marco Ricci",
    });
    createdTenantIds.push(targetTenantId, otherTenantId);

    const matchingArtworkId = await createArtwork({
      tenantId: targetTenantId,
      title: "Coastal Dawn",
    });
    const nonMatchingArtworkId = await createArtwork({
      tenantId: otherTenantId,
      title: "Roman Ruins",
    });
    createdArtworkIds.push(matchingArtworkId, nonMatchingArtworkId);

    const rows = await runBrowseQuery({ artist: "Sophie Laurent" });
    const matchedIds = rows.map((r) => r.artworkId);

    expect(matchedIds).toContain(matchingArtworkId);
    expect(matchedIds).not.toContain(nonMatchingArtworkId);
  });

  it("excludes an artwork from a FRAMER-type tenant even if the business name matches the filter", async () => {
    // The ARTIST path requires type = 'ARTIST'; a FRAMER with a matching
    // businessName must not be returned via this path.
    const tenantId = await createTenant({
      type: "FRAMER",
      businessName: "Sophie Laurent",
    });
    createdTenantIds.push(tenantId);

    const artworkId = await createArtwork({
      tenantId,
      title: "Framer Piece",
    });
    createdArtworkIds.push(artworkId);

    const rows = await runBrowseQuery({ artist: "Sophie Laurent" });
    const matched = rows.filter((r) => r.artworkId === artworkId);

    // Must not match via the ARTIST-type tenant path because type is FRAMER.
    expect(matched).toHaveLength(0);
  });
});

describeIntegration("browse artist filter — OR across both paths", () => {
  it("returns artworks matching via represented artist OR ARTIST-type tenant in a single query", async () => {
    // Path 1: FRAMER gallery with a represented artist named "Yuki Tanaka".
    const framerTenantId = await createTenant({ type: "FRAMER", businessName: "Framer Gallery" });
    createdTenantIds.push(framerTenantId);

    const artistId = await createRepresentedArtist({
      tenantId: framerTenantId,
      name: "Yuki Tanaka",
    });
    createdArtistIds.push(artistId);

    const representedArtworkId = await createArtwork({
      tenantId: framerTenantId,
      title: "Ink on Paper",
      representedArtistId: artistId,
    });
    createdArtworkIds.push(representedArtworkId);

    // Path 2: ARTIST-type tenant whose businessName is also "Yuki Tanaka".
    const artistTenantId = await createTenant({
      type: "ARTIST",
      businessName: "Yuki Tanaka",
    });
    createdTenantIds.push(artistTenantId);

    const tenantArtworkId = await createArtwork({
      tenantId: artistTenantId,
      title: "Brush & Wash",
    });
    createdArtworkIds.push(tenantArtworkId);

    // Decoy: artwork from an unrelated tenant — must be excluded.
    const decoyTenantId = await createTenant({ businessName: "Unrelated Studio" });
    createdTenantIds.push(decoyTenantId);

    const decoyArtworkId = await createArtwork({
      tenantId: decoyTenantId,
      title: "Decoy Piece",
    });
    createdArtworkIds.push(decoyArtworkId);

    const rows = await runBrowseQuery({ artist: "Yuki Tanaka" });
    const matchedIds = rows.map((r) => r.artworkId);

    expect(matchedIds).toContain(representedArtworkId);
    expect(matchedIds).toContain(tenantArtworkId);
    expect(matchedIds).not.toContain(decoyArtworkId);
  });
});

describeIntegration("browse artist filter — no-op when artist is absent", () => {
  it("returns all visible artworks when no artist filter is provided", async () => {
    const tenantId = await createTenant({});
    createdTenantIds.push(tenantId);

    const artworkId = await createArtwork({ tenantId, title: "Generic Piece" });
    createdArtworkIds.push(artworkId);

    // No artist param — buildBrowseWhere skips the artist condition entirely.
    const rows = await runBrowseQuery({});
    const matched = rows.filter((r) => r.artworkId === artworkId);

    expect(matched).toHaveLength(1);
  });
});

describeIntegration("browse artist + keyword filter — both must be satisfied (AND)", () => {
  it("returns only the artwork that matches both artist= and q=", async () => {
    const tenantId = await createTenant({ type: "FRAMER" });
    createdTenantIds.push(tenantId);

    const artistId = await createRepresentedArtist({
      tenantId,
      name: "Lena Hoffmann",
    });
    createdArtistIds.push(artistId);

    // Artwork A — matches artist= AND q= (title contains the keyword)
    const matchingArtworkId = await createArtwork({
      tenantId,
      title: "Winter Solstice",
      representedArtistId: artistId,
    });
    createdArtworkIds.push(matchingArtworkId);

    // Artwork B — matches artist= but NOT q= (different title, no keyword)
    const artistOnlyArtworkId = await createArtwork({
      tenantId,
      title: "Summer Fields",
      representedArtistId: artistId,
    });
    createdArtworkIds.push(artistOnlyArtworkId);

    // Query with both filters; keyword matches only Artwork A's title.
    const rows = await runBrowseQuery({ artist: "Lena Hoffmann", q: "Winter" });
    const matchedIds = rows.map((r) => r.artworkId);

    // Only the artwork satisfying both filters should be present.
    expect(matchedIds).toContain(matchingArtworkId);
    // Artwork B matches the artist filter but not the keyword — must be excluded.
    expect(matchedIds).not.toContain(artistOnlyArtworkId);
  });

  it("excludes an artwork that matches q= but whose artist does not match artist=", async () => {
    const tenantId = await createTenant({ type: "FRAMER" });
    createdTenantIds.push(tenantId);

    const targetArtistId = await createRepresentedArtist({
      tenantId,
      name: "Lena Hoffmann",
    });
    const otherArtistId = await createRepresentedArtist({
      tenantId,
      name: "Ryo Matsuda",
    });
    createdArtistIds.push(targetArtistId, otherArtistId);

    // Artwork A — matches artist= AND q=
    const matchingArtworkId = await createArtwork({
      tenantId,
      title: "Winter Solstice",
      representedArtistId: targetArtistId,
    });
    createdArtworkIds.push(matchingArtworkId);

    // Artwork C — matches q= (same keyword in title) but belongs to a different artist
    const keywordOnlyArtworkId = await createArtwork({
      tenantId,
      title: "Winter Sunrise",
      representedArtistId: otherArtistId,
    });
    createdArtworkIds.push(keywordOnlyArtworkId);

    const rows = await runBrowseQuery({ artist: "Lena Hoffmann", q: "Winter" });
    const matchedIds = rows.map((r) => r.artworkId);

    expect(matchedIds).toContain(matchingArtworkId);
    // Artwork C satisfies q= but not artist= — must be excluded.
    expect(matchedIds).not.toContain(keywordOnlyArtworkId);
  });
});

describeIntegration(
  "browse artist filter — base conditions interact correctly with artist OR clause",
  () => {
    it("excludes a HIDDEN artwork even when its represented artist matches the filter", async () => {
      const tenantId = await createTenant({ type: "FRAMER" });
      createdTenantIds.push(tenantId);

      const artistId = await createRepresentedArtist({
        tenantId,
        name: "Diana Marsh",
      });
      createdArtistIds.push(artistId);

      // Control: AVAILABLE + showInGallery=true — must appear.
      const visibleArtworkId = await createArtwork({
        tenantId,
        title: "Visible Work",
        representedArtistId: artistId,
        status: "AVAILABLE",
        showInGallery: true,
      });
      createdArtworkIds.push(visibleArtworkId);

      // Subject: HIDDEN — must be excluded even though the artist matches.
      const hiddenArtworkId = await createArtwork({
        tenantId,
        title: "Hidden Work",
        representedArtistId: artistId,
        status: "HIDDEN",
        showInGallery: true,
      });
      createdArtworkIds.push(hiddenArtworkId);

      const rows = await runBrowseQuery({ artist: "Diana Marsh" });
      const matchedIds = rows.map((r) => r.artworkId);

      expect(matchedIds).toContain(visibleArtworkId);
      expect(matchedIds).not.toContain(hiddenArtworkId);
    });

    it("excludes a showInGallery=false artwork even when its represented artist matches the filter", async () => {
      const tenantId = await createTenant({ type: "FRAMER" });
      createdTenantIds.push(tenantId);

      const artistId = await createRepresentedArtist({
        tenantId,
        name: "Diana Marsh",
      });
      createdArtistIds.push(artistId);

      // Control: AVAILABLE + showInGallery=true — must appear.
      const visibleArtworkId = await createArtwork({
        tenantId,
        title: "Visible Work",
        representedArtistId: artistId,
        status: "AVAILABLE",
        showInGallery: true,
      });
      createdArtworkIds.push(visibleArtworkId);

      // Subject: showInGallery=false — must be excluded even though the artist matches.
      const hiddenFromGalleryId = await createArtwork({
        tenantId,
        title: "Not In Gallery",
        representedArtistId: artistId,
        status: "AVAILABLE",
        showInGallery: false,
      });
      createdArtworkIds.push(hiddenFromGalleryId);

      const rows = await runBrowseQuery({ artist: "Diana Marsh" });
      const matchedIds = rows.map((r) => r.artworkId);

      expect(matchedIds).toContain(visibleArtworkId);
      expect(matchedIds).not.toContain(hiddenFromGalleryId);
    });
  },
);

describeIntegration(
  "represented-artist dropdown — SOLD and RESERVED artworks keep the artist visible",
  () => {
    it("includes a represented artist whose only artwork is SOLD", async () => {
      // SOLD is a visible status — the artist should still appear in the dropdown
      // so buyers can browse sold artworks by that artist.
      const tenantId = await createTenant({ type: "FRAMER" });
      createdTenantIds.push(tenantId);

      const artistId = await createRepresentedArtist({
        tenantId,
        name: "Naomi Keller",
      });
      createdArtistIds.push(artistId);

      const artworkId = await createArtwork({
        tenantId,
        representedArtistId: artistId,
        status: "SOLD",
      });
      createdArtworkIds.push(artworkId);

      const rows = await runRepresentedArtistDropdownQuery();
      const matched = rows.filter((r) => r.artistId === artistId);

      expect(matched).toHaveLength(1);
    });

    it("includes a represented artist whose only artwork is RESERVED", async () => {
      // RESERVED is a visible status — the artist should still appear in the
      // dropdown so buyers can see reserved artworks by that artist.
      const tenantId = await createTenant({ type: "FRAMER" });
      createdTenantIds.push(tenantId);

      const artistId = await createRepresentedArtist({
        tenantId,
        name: "Hiroshi Fujii",
      });
      createdArtistIds.push(artistId);

      const artworkId = await createArtwork({
        tenantId,
        representedArtistId: artistId,
        status: "RESERVED",
      });
      createdArtworkIds.push(artworkId);

      const rows = await runRepresentedArtistDropdownQuery();
      const matched = rows.filter((r) => r.artistId === artistId);

      expect(matched).toHaveLength(1);
    });

    it("excludes a represented artist whose only artwork is HIDDEN", async () => {
      // HIDDEN artworks are not visible — an artist with only hidden artworks
      // must not appear in the dropdown.
      const tenantId = await createTenant({ type: "FRAMER" });
      createdTenantIds.push(tenantId);

      const artistId = await createRepresentedArtist({
        tenantId,
        name: "Ghost Painter",
      });
      createdArtistIds.push(artistId);

      const artworkId = await createArtwork({
        tenantId,
        representedArtistId: artistId,
        status: "HIDDEN",
      });
      createdArtworkIds.push(artworkId);

      const rows = await runRepresentedArtistDropdownQuery();
      const matched = rows.filter((r) => r.artistId === artistId);

      expect(matched).toHaveLength(0);
    });
  },
);
