/**
 * Integration tests: the public /browse query must return zero rows when
 * all storefronts are disabled, and must exclude HIDDEN artworks even when
 * a storefront is enabled.
 *
 * These complement the mock-based browse-visibility.test.ts by running the
 * buildBrowseWhere() clause against a real PostgreSQL instance, catching any
 * gap between the query shape and what the database actually executes (e.g.
 * column type mismatches, default-value surprises, or schema drift).
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
  storefrontEnabled?: boolean;
}) {
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

describe("browse query — disabled storefronts", () => {
  it("returns zero rows when all storefronts are disabled, even with showInGallery=true and status=AVAILABLE", async () => {
    // Seed two tenants with storefrontEnabled=false, each with one visible artwork.
    const t1 = await createTenant({ storefrontEnabled: false });
    const t2 = await createTenant({ storefrontEnabled: false });
    createdTenantIds.push(t1, t2);

    const a1 = await createArtwork({ tenantId: t1, showInGallery: true, status: "AVAILABLE" });
    const a2 = await createArtwork({ tenantId: t2, showInGallery: true, status: "AVAILABLE" });
    createdArtworkIds.push(a1, a2);

    const rows = await runBrowseQuery();

    // Filter to only the rows we seeded (other tests may have left rows in the DB).
    const seededIds = new Set<string>([a1, a2]);
    const matched = rows.filter((r) => seededIds.has(r.artworkId));

    expect(matched).toHaveLength(0);
  });

  it("returns the artwork when its storefront is enabled (control: confirms the seeding works)", async () => {
    const tenantId = await createTenant({ storefrontEnabled: true });
    createdTenantIds.push(tenantId);

    const artworkId = await createArtwork({ tenantId, showInGallery: true, status: "AVAILABLE" });
    createdArtworkIds.push(artworkId);

    const rows = await runBrowseQuery();
    const matched = rows.filter((r) => r.artworkId === artworkId);

    expect(matched).toHaveLength(1);
  });
});

describe("browse query — HIDDEN artworks excluded", () => {
  it("returns zero rows for a HIDDEN artwork even when the storefront is enabled", async () => {
    const tenantId = await createTenant({ storefrontEnabled: true });
    createdTenantIds.push(tenantId);

    const artworkId = await createArtwork({
      tenantId,
      showInGallery: true,
      status: "HIDDEN",
    });
    createdArtworkIds.push(artworkId);

    const rows = await runBrowseQuery();
    const matched = rows.filter((r) => r.artworkId === artworkId);

    expect(matched).toHaveLength(0);
  });

  it("returns artworks with AVAILABLE, SOLD, and RESERVED status (positive check for allowed statuses)", async () => {
    const tenantId = await createTenant({ storefrontEnabled: true });
    createdTenantIds.push(tenantId);

    const availId = await createArtwork({ tenantId, showInGallery: true, status: "AVAILABLE" });
    const soldId   = await createArtwork({ tenantId, showInGallery: true, status: "SOLD" });
    const rsvdId   = await createArtwork({ tenantId, showInGallery: true, status: "RESERVED" });
    createdArtworkIds.push(availId, soldId, rsvdId);

    const rows = await runBrowseQuery();
    const seeded = new Set<string>([availId, soldId, rsvdId]);
    const matched = rows.filter((r) => seeded.has(r.artworkId));

    expect(matched).toHaveLength(3);
  });
});

describe("browse query — showInGallery=false excluded", () => {
  it("returns zero rows when showInGallery is false, even with an enabled storefront and AVAILABLE status", async () => {
    const tenantId = await createTenant({ storefrontEnabled: true });
    createdTenantIds.push(tenantId);

    const artworkId = await createArtwork({
      tenantId,
      showInGallery: false,
      status: "AVAILABLE",
    });
    createdArtworkIds.push(artworkId);

    const rows = await runBrowseQuery();
    const matched = rows.filter((r) => r.artworkId === artworkId);

    expect(matched).toHaveLength(0);
  });
});
