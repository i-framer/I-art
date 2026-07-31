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
