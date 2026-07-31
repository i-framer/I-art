/**
 * Integration tests: the /browse seller dropdown must hide galleries that have
 * no visible artworks.
 *
 * Design decision (confirmed here): sellerFilterWhere() uses an EXISTS subquery
 * that requires at least one artwork with showInGallery=true and a non-HIDDEN
 * status.  A tenant whose every artwork is hidden would produce an empty browse
 * grid when selected — a confusing UX — so it must be excluded from the
 * dropdown.  This mirrors the same guard used by artistTenantFilterWhere() and
 * categoryFilterWhere().
 *
 * These run against a real PostgreSQL instance so they catch type mismatches,
 * schema drift, and any gap between the Drizzle query shape and actual SQL that
 * mock-based tests cannot surface.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";

// ── Real DB (no mock) — that is the whole point of this integration test ──────
import {
  db,
  tenantsTable,
  artworksTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { sellerFilterWhere } from "@/lib/browse-filter-options";

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid() {
  return randomUUID();
}

/** Minimal tenant insert. */
async function createTenant(overrides: {
  storefrontEnabled?: boolean;
}) {
  const id = uid();
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

/** Run sellerFilterWhere() and return only the seeded tenant IDs that match. */
async function runSellerQuery(seededIds: string[]) {
  const rows = await db
    .select({ tenantId: tenantsTable.id })
    .from(tenantsTable)
    .where(sellerFilterWhere());
  const seededSet = new Set(seededIds);
  return rows.filter((r) => seededSet.has(r.tenantId)).map((r) => r.tenantId);
}

// Track created row IDs for cleanup.
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];

beforeEach(() => {
  createdTenantIds.length = 0;
  createdArtworkIds.length = 0;
});

afterEach(async () => {
  // FK: artworks reference tenants — delete artworks first.
  for (const id of createdArtworkIds) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("sellerFilterWhere — galleries with no visible artworks are hidden", () => {
  it("excludes a storefrontEnabled tenant whose only artwork is HIDDEN", async () => {
    const tenantId = await createTenant({ storefrontEnabled: true });
    createdTenantIds.push(tenantId);

    const artworkId = await createArtwork({
      tenantId,
      showInGallery: true,
      status: "HIDDEN",
    });
    createdArtworkIds.push(artworkId);

    const matched = await runSellerQuery([tenantId]);

    // The seller must not appear — it has no visible artworks.
    expect(matched).toHaveLength(0);
  });

  it("excludes a storefrontEnabled tenant whose only artwork has showInGallery=false", async () => {
    const tenantId = await createTenant({ storefrontEnabled: true });
    createdTenantIds.push(tenantId);

    const artworkId = await createArtwork({
      tenantId,
      showInGallery: false,
      status: "AVAILABLE",
    });
    createdArtworkIds.push(artworkId);

    const matched = await runSellerQuery([tenantId]);

    // showInGallery=false is treated as invisible — seller must be excluded.
    expect(matched).toHaveLength(0);
  });

  it("excludes a storefrontEnabled tenant with zero artworks", async () => {
    const tenantId = await createTenant({ storefrontEnabled: true });
    createdTenantIds.push(tenantId);
    // No artworks inserted.

    const matched = await runSellerQuery([tenantId]);

    expect(matched).toHaveLength(0);
  });

  it("includes a storefrontEnabled tenant that has at least one AVAILABLE artwork", async () => {
    const tenantId = await createTenant({ storefrontEnabled: true });
    createdTenantIds.push(tenantId);

    const artworkId = await createArtwork({ tenantId, status: "AVAILABLE" });
    createdArtworkIds.push(artworkId);

    const matched = await runSellerQuery([tenantId]);

    expect(matched).toHaveLength(1);
    expect(matched[0]).toBe(tenantId);
  });

  it("includes a storefrontEnabled tenant that has at least one SOLD artwork", async () => {
    const tenantId = await createTenant({ storefrontEnabled: true });
    createdTenantIds.push(tenantId);

    const artworkId = await createArtwork({ tenantId, status: "SOLD" });
    createdArtworkIds.push(artworkId);

    const matched = await runSellerQuery([tenantId]);

    expect(matched).toHaveLength(1);
  });

  it("includes a storefrontEnabled tenant that has at least one RESERVED artwork", async () => {
    const tenantId = await createTenant({ storefrontEnabled: true });
    createdTenantIds.push(tenantId);

    const artworkId = await createArtwork({ tenantId, status: "RESERVED" });
    createdArtworkIds.push(artworkId);

    const matched = await runSellerQuery([tenantId]);

    expect(matched).toHaveLength(1);
  });

  it("includes a tenant that has one hidden and one visible artwork (visible one satisfies the EXISTS)", async () => {
    const tenantId = await createTenant({ storefrontEnabled: true });
    createdTenantIds.push(tenantId);

    const hiddenId = await createArtwork({ tenantId, status: "HIDDEN" });
    const visibleId = await createArtwork({ tenantId, status: "AVAILABLE" });
    createdArtworkIds.push(hiddenId, visibleId);

    const matched = await runSellerQuery([tenantId]);

    // At least one visible artwork — the seller should appear.
    expect(matched).toHaveLength(1);
  });

  it("excludes a storefrontEnabled=false tenant even when it has visible artworks", async () => {
    const tenantId = await createTenant({ storefrontEnabled: false });
    createdTenantIds.push(tenantId);

    const artworkId = await createArtwork({ tenantId, status: "AVAILABLE" });
    createdArtworkIds.push(artworkId);

    const matched = await runSellerQuery([tenantId]);

    // Disabled storefront must always be excluded.
    expect(matched).toHaveLength(0);
  });

  it("returns only the seller with visible artworks when compared side-by-side with an all-hidden seller", async () => {
    const visibleSellerId = await createTenant({ storefrontEnabled: true });
    const hiddenSellerId = await createTenant({ storefrontEnabled: true });
    createdTenantIds.push(visibleSellerId, hiddenSellerId);

    const visibleArtwork = await createArtwork({ tenantId: visibleSellerId, status: "AVAILABLE" });
    const hiddenArtwork = await createArtwork({ tenantId: hiddenSellerId, status: "HIDDEN" });
    createdArtworkIds.push(visibleArtwork, hiddenArtwork);

    const matched = await runSellerQuery([visibleSellerId, hiddenSellerId]);

    expect(matched).toHaveLength(1);
    expect(matched[0]).toBe(visibleSellerId);
  });
});
