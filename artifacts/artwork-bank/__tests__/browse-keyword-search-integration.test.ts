/**
 * Integration tests: the public /browse keyword search (q=) must return only
 * artworks whose title, represented artist name, or seller business name
 * matches the query via ilike (case-insensitive substring).
 *
 * These complement the mock-based unit tests by running the buildBrowseWhere()
 * clause against a real PostgreSQL instance, catching any gap between the
 * Drizzle query shape and what the database actually executes — e.g. collation
 * quirks, column type mismatches, or unexpected NULL handling.
 *
 * Follows the pattern in browse-storefront-disabled-integration.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
    type: overrides.type ?? "ARTIST",
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

describe("browse keyword search — title matching", () => {
  it("returns an artwork whose title contains the exact keyword", async () => {
    const tenantId = await createTenant({});
    createdTenantIds.push(tenantId);

    const artworkId = await createArtwork({
      tenantId,
      title: "Sunset Over the Harbour",
    });
    createdArtworkIds.push(artworkId);

    const rows = await runBrowseQuery({ q: "Sunset Over the Harbour" });
    const matched = rows.filter((r) => r.artworkId === artworkId);

    expect(matched).toHaveLength(1);
  });

  it("returns an artwork whose title contains a partial keyword (substring match)", async () => {
    const tenantId = await createTenant({});
    createdTenantIds.push(tenantId);

    const artworkId = await createArtwork({
      tenantId,
      title: "Sunset Over the Harbour",
    });
    createdArtworkIds.push(artworkId);

    const rows = await runBrowseQuery({ q: "Harbour" });
    const matched = rows.filter((r) => r.artworkId === artworkId);

    expect(matched).toHaveLength(1);
  });

  it("matches the title case-insensitively (ilike)", async () => {
    const tenantId = await createTenant({});
    createdTenantIds.push(tenantId);

    const artworkId = await createArtwork({
      tenantId,
      title: "Sunset Over the Harbour",
    });
    createdArtworkIds.push(artworkId);

    // Query in all-lowercase — ilike should still match.
    const rows = await runBrowseQuery({ q: "sunset over the harbour" });
    const matched = rows.filter((r) => r.artworkId === artworkId);

    expect(matched).toHaveLength(1);
  });

  it("excludes an artwork whose title does not contain the keyword", async () => {
    const tenantId = await createTenant({});
    createdTenantIds.push(tenantId);

    const matchingId = await createArtwork({ tenantId, title: "Blue Mountains" });
    const nonMatchingId = await createArtwork({ tenantId, title: "Forest Path" });
    createdArtworkIds.push(matchingId, nonMatchingId);

    const rows = await runBrowseQuery({ q: "Mountains" });
    const matchedIds = rows.map((r) => r.artworkId);

    expect(matchedIds).toContain(matchingId);
    expect(matchedIds).not.toContain(nonMatchingId);
  });

  it("returns nothing when the keyword matches no title in the seeded set", async () => {
    const tenantId = await createTenant({});
    createdTenantIds.push(tenantId);

    const artworkId = await createArtwork({ tenantId, title: "Ocean Breeze" });
    createdArtworkIds.push(artworkId);

    const rows = await runBrowseQuery({ q: "zzznomatch_xqz" });
    const matched = rows.filter((r) => r.artworkId === artworkId);

    expect(matched).toHaveLength(0);
  });
});

describe("browse keyword search — represented artist name matching", () => {
  it("returns an artwork linked to a represented artist whose name contains the keyword", async () => {
    const tenantId = await createTenant({ type: "FRAMER" });
    createdTenantIds.push(tenantId);

    const artistId = await createRepresentedArtist({
      tenantId,
      name: "Maria Fernandez",
    });
    createdArtistIds.push(artistId);

    const artworkId = await createArtwork({
      tenantId,
      title: "Untitled Work",
      representedArtistId: artistId,
    });
    createdArtworkIds.push(artworkId);

    const rows = await runBrowseQuery({ q: "Maria Fernandez" });
    const matched = rows.filter((r) => r.artworkId === artworkId);

    expect(matched).toHaveLength(1);
  });

  it("matches the represented artist name by partial keyword", async () => {
    const tenantId = await createTenant({ type: "FRAMER" });
    createdTenantIds.push(tenantId);

    const artistId = await createRepresentedArtist({
      tenantId,
      name: "Maria Fernandez",
    });
    createdArtistIds.push(artistId);

    const artworkId = await createArtwork({
      tenantId,
      title: "Untitled Work",
      representedArtistId: artistId,
    });
    createdArtworkIds.push(artworkId);

    const rows = await runBrowseQuery({ q: "Fernandez" });
    const matched = rows.filter((r) => r.artworkId === artworkId);

    expect(matched).toHaveLength(1);
  });

  it("matches the represented artist name case-insensitively", async () => {
    const tenantId = await createTenant({ type: "FRAMER" });
    createdTenantIds.push(tenantId);

    const artistId = await createRepresentedArtist({
      tenantId,
      name: "Maria Fernandez",
    });
    createdArtistIds.push(artistId);

    const artworkId = await createArtwork({
      tenantId,
      title: "Untitled Work",
      representedArtistId: artistId,
    });
    createdArtworkIds.push(artworkId);

    const rows = await runBrowseQuery({ q: "maria fernandez" });
    const matched = rows.filter((r) => r.artworkId === artworkId);

    expect(matched).toHaveLength(1);
  });

  it("excludes an artwork whose represented artist name does not match the keyword", async () => {
    const tenantId = await createTenant({ type: "FRAMER" });
    createdTenantIds.push(tenantId);

    const matchingArtistId = await createRepresentedArtist({
      tenantId,
      name: "John Smith",
    });
    const nonMatchingArtistId = await createRepresentedArtist({
      tenantId,
      name: "Alice Wong",
    });
    createdArtistIds.push(matchingArtistId, nonMatchingArtistId);

    const matchingArtworkId = await createArtwork({
      tenantId,
      title: "Artwork A",
      representedArtistId: matchingArtistId,
    });
    const nonMatchingArtworkId = await createArtwork({
      tenantId,
      title: "Artwork B",
      representedArtistId: nonMatchingArtistId,
    });
    createdArtworkIds.push(matchingArtworkId, nonMatchingArtworkId);

    const rows = await runBrowseQuery({ q: "John Smith" });
    const matchedIds = rows.map((r) => r.artworkId);

    expect(matchedIds).toContain(matchingArtworkId);
    expect(matchedIds).not.toContain(nonMatchingArtworkId);
  });

  it("excludes an artwork with no represented artist when the keyword matches no title or business name", async () => {
    const tenantId = await createTenant({ businessName: "Unrelated Gallery" });
    createdTenantIds.push(tenantId);

    // Artwork has no representedArtistId and the title/business don't match.
    const artworkId = await createArtwork({
      tenantId,
      title: "Ocean View",
    });
    createdArtworkIds.push(artworkId);

    const rows = await runBrowseQuery({ q: "Maria Fernandez" });
    const matched = rows.filter((r) => r.artworkId === artworkId);

    expect(matched).toHaveLength(0);
  });
});

describe("browse keyword search — business name matching", () => {
  it("returns an artwork from a gallery whose business name contains the keyword", async () => {
    const tenantId = await createTenant({ businessName: "Harbour Bridge Gallery" });
    createdTenantIds.push(tenantId);

    const artworkId = await createArtwork({ tenantId, title: "Work A" });
    createdArtworkIds.push(artworkId);

    const rows = await runBrowseQuery({ q: "Harbour Bridge Gallery" });
    const matched = rows.filter((r) => r.artworkId === artworkId);

    expect(matched).toHaveLength(1);
  });

  it("matches the business name by partial keyword", async () => {
    const tenantId = await createTenant({ businessName: "Harbour Bridge Gallery" });
    createdTenantIds.push(tenantId);

    const artworkId = await createArtwork({ tenantId, title: "Work A" });
    createdArtworkIds.push(artworkId);

    const rows = await runBrowseQuery({ q: "Bridge" });
    const matched = rows.filter((r) => r.artworkId === artworkId);

    expect(matched).toHaveLength(1);
  });

  it("matches the business name case-insensitively", async () => {
    const tenantId = await createTenant({ businessName: "Harbour Bridge Gallery" });
    createdTenantIds.push(tenantId);

    const artworkId = await createArtwork({ tenantId, title: "Work A" });
    createdArtworkIds.push(artworkId);

    const rows = await runBrowseQuery({ q: "harbour bridge gallery" });
    const matched = rows.filter((r) => r.artworkId === artworkId);

    expect(matched).toHaveLength(1);
  });

  it("excludes artworks from a gallery whose business name does not match the keyword", async () => {
    const matchingTenantId = await createTenant({ businessName: "Lakeside Studio" });
    const nonMatchingTenantId = await createTenant({ businessName: "Mountain Arts" });
    createdTenantIds.push(matchingTenantId, nonMatchingTenantId);

    const matchingArtworkId = await createArtwork({ tenantId: matchingTenantId, title: "Piece 1" });
    const nonMatchingArtworkId = await createArtwork({ tenantId: nonMatchingTenantId, title: "Piece 2" });
    createdArtworkIds.push(matchingArtworkId, nonMatchingArtworkId);

    const rows = await runBrowseQuery({ q: "Lakeside" });
    const matchedIds = rows.map((r) => r.artworkId);

    expect(matchedIds).toContain(matchingArtworkId);
    expect(matchedIds).not.toContain(nonMatchingArtworkId);
  });
});

describe("browse keyword search — OR across all three fields", () => {
  it("returns artworks matching by title OR artist name OR business name in a single query", async () => {
    // One tenant matching by business name only.
    const bizTenantId = await createTenant({ businessName: "UniqueKeywordGallery" });
    createdTenantIds.push(bizTenantId);
    const bizArtworkId = await createArtwork({ tenantId: bizTenantId, title: "No keyword here" });
    createdArtworkIds.push(bizArtworkId);

    // One artwork matching by title only.
    const titleTenantId = await createTenant({ businessName: "Some Other Gallery" });
    createdTenantIds.push(titleTenantId);
    const titleArtworkId = await createArtwork({
      tenantId: titleTenantId,
      title: "UniqueKeywordGallery Title",
    });
    createdArtworkIds.push(titleArtworkId);

    // One artwork matching by represented artist name only.
    const artistTenantId = await createTenant({ type: "FRAMER", businessName: "Framer Co" });
    createdTenantIds.push(artistTenantId);
    const artistId = await createRepresentedArtist({
      tenantId: artistTenantId,
      name: "UniqueKeywordGallery Artist",
    });
    createdArtistIds.push(artistId);
    const artistArtworkId = await createArtwork({
      tenantId: artistTenantId,
      title: "Some Unrelated Title",
      representedArtistId: artistId,
    });
    createdArtworkIds.push(artistArtworkId);

    // One artwork that matches nothing.
    const noMatchTenantId = await createTenant({ businessName: "Completely Different" });
    createdTenantIds.push(noMatchTenantId);
    const noMatchArtworkId = await createArtwork({
      tenantId: noMatchTenantId,
      title: "Nothing relevant",
    });
    createdArtworkIds.push(noMatchArtworkId);

    const rows = await runBrowseQuery({ q: "UniqueKeywordGallery" });
    const matchedIds = rows.map((r) => r.artworkId);

    expect(matchedIds).toContain(bizArtworkId);
    expect(matchedIds).toContain(titleArtworkId);
    expect(matchedIds).toContain(artistArtworkId);
    expect(matchedIds).not.toContain(noMatchArtworkId);
  });
});

describe("browse keyword search — no-op when q is blank", () => {
  it("returns all visible artworks when q is an empty string (no keyword filter)", async () => {
    const tenantId = await createTenant({});
    createdTenantIds.push(tenantId);

    const artworkId = await createArtwork({ tenantId, title: "Any Artwork" });
    createdArtworkIds.push(artworkId);

    // Empty string — buildBrowseWhere skips the keyword condition entirely.
    const rows = await runBrowseQuery({ q: "" });
    const matched = rows.filter((r) => r.artworkId === artworkId);

    expect(matched).toHaveLength(1);
  });

  it("returns all visible artworks when q is whitespace-only (trimmed to empty)", async () => {
    const tenantId = await createTenant({});
    createdTenantIds.push(tenantId);

    const artworkId = await createArtwork({ tenantId, title: "Any Artwork" });
    createdArtworkIds.push(artworkId);

    const rows = await runBrowseQuery({ q: "   " });
    const matched = rows.filter((r) => r.artworkId === artworkId);

    expect(matched).toHaveLength(1);
  });
});
