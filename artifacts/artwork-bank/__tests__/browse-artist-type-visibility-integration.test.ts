/**
 * Task #285 — Confirm HIDDEN and showInGallery=false artworks are excluded
 * from the ARTIST-type tenant browse path on a real database.
 *
 * artistTenantFilterWhere() uses an EXISTS subquery that requires at least one
 * artwork with showInGallery=true AND a non-HIDDEN status.  The unit tests in
 * browse-filters.test.ts assert the WHERE shape, but do not execute SQL.
 * These integration tests run against a real PostgreSQL instance and confirm
 * the EXISTS subquery actually filters correctly — catching JOIN column
 * mismatches, schema drift, or any gap between the Drizzle query shape and
 * what the database executes.
 *
 * Coverage:
 *   - ARTIST tenant whose only artwork is HIDDEN → excluded from dropdown.
 *   - ARTIST tenant whose only artwork has showInGallery=false → excluded.
 *   - ARTIST tenant with zero artworks → excluded.
 *   - ARTIST tenant with one AVAILABLE artwork → included.
 *   - ARTIST tenant with one SOLD artwork → included (SOLD is visible).
 *   - ARTIST tenant with one RESERVED artwork → included (RESERVED is visible).
 *   - ARTIST tenant with a HIDDEN artwork AND a visible artwork → included.
 *   - FRAMER tenant (not ARTIST type) is excluded even with a visible artwork.
 *   - storefrontEnabled=false ARTIST → excluded even with a visible artwork.
 */
import { it, expect, beforeEach, afterEach } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { randomUUID } from "node:crypto";

import { db, tenantsTable, artworksTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { artistTenantFilterWhere } from "@/lib/browse-filter-options";

function uid() {
  return randomUUID();
}

/** Insert a minimal ARTIST-type tenant. */
async function createArtistTenant(overrides: {
  type?: "ARTIST" | "FRAMER";
  storefrontEnabled?: boolean;
} = {}) {
  const id = uid();
  await db.insert(tenantsTable).values({
    id,
    type: overrides.type ?? "ARTIST",
    businessName: `ARTIST Browse Test ${id}`,
    slug: `artist-browse-${id}`,
    storefrontEnabled: overrides.storefrontEnabled ?? true,
  } as any);
  return id;
}

/** Insert a minimal artwork linked to a tenant. */
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
    sku: `SKU-285-${id}`,
    showInGallery: overrides.showInGallery ?? true,
    status: overrides.status ?? "AVAILABLE",
  } as any);
  return id;
}

/**
 * Run artistTenantFilterWhere() and return which of the seeded tenant IDs
 * match — filtering out unrelated rows from other tests.
 */
async function runArtistTenantQuery(seededIds: string[]) {
  const rows = await db
    .select({ tenantId: tenantsTable.id })
    .from(tenantsTable)
    .where(artistTenantFilterWhere());
  const seededSet = new Set(seededIds);
  return rows
    .filter((r) => seededSet.has(r.tenantId))
    .map((r) => r.tenantId);
}

const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];

beforeEach(() => {
  createdTenantIds.length = 0;
  createdArtworkIds.length = 0;
});

afterEach(async () => {
  for (const id of createdArtworkIds) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
});

describeIntegration(
  "artistTenantFilterWhere — HIDDEN and showInGallery=false artworks excluded (Task #285)",
  () => {
    it("excludes an ARTIST tenant whose only artwork has status=HIDDEN", async () => {
      const tenantId = await createArtistTenant();
      createdTenantIds.push(tenantId);

      const artworkId = await createArtwork({
        tenantId,
        showInGallery: true,
        status: "HIDDEN",
      });
      createdArtworkIds.push(artworkId);

      const matched = await runArtistTenantQuery([tenantId]);
      expect(matched).toHaveLength(0);
    });

    it("excludes an ARTIST tenant whose only artwork has showInGallery=false", async () => {
      const tenantId = await createArtistTenant();
      createdTenantIds.push(tenantId);

      const artworkId = await createArtwork({
        tenantId,
        showInGallery: false,
        status: "AVAILABLE",
      });
      createdArtworkIds.push(artworkId);

      const matched = await runArtistTenantQuery([tenantId]);
      expect(matched).toHaveLength(0);
    });

    it("excludes an ARTIST tenant with zero artworks", async () => {
      const tenantId = await createArtistTenant();
      createdTenantIds.push(tenantId);

      const matched = await runArtistTenantQuery([tenantId]);
      expect(matched).toHaveLength(0);
    });

    it("includes an ARTIST tenant with at least one AVAILABLE artwork", async () => {
      const tenantId = await createArtistTenant();
      createdTenantIds.push(tenantId);

      const artworkId = await createArtwork({ tenantId, status: "AVAILABLE" });
      createdArtworkIds.push(artworkId);

      const matched = await runArtistTenantQuery([tenantId]);
      expect(matched).toHaveLength(1);
      expect(matched[0]).toBe(tenantId);
    });

    it("includes an ARTIST tenant with only a SOLD artwork (SOLD is visible)", async () => {
      const tenantId = await createArtistTenant();
      createdTenantIds.push(tenantId);

      const artworkId = await createArtwork({ tenantId, status: "SOLD" });
      createdArtworkIds.push(artworkId);

      const matched = await runArtistTenantQuery([tenantId]);
      expect(matched).toHaveLength(1);
    });

    it("includes an ARTIST tenant with only a RESERVED artwork (RESERVED is visible)", async () => {
      const tenantId = await createArtistTenant();
      createdTenantIds.push(tenantId);

      const artworkId = await createArtwork({ tenantId, status: "RESERVED" });
      createdArtworkIds.push(artworkId);

      const matched = await runArtistTenantQuery([tenantId]);
      expect(matched).toHaveLength(1);
    });

    it("includes an ARTIST tenant that has both a HIDDEN artwork and a visible AVAILABLE artwork", async () => {
      const tenantId = await createArtistTenant();
      createdTenantIds.push(tenantId);

      // Hidden one — not sufficient on its own.
      const hiddenId = await createArtwork({ tenantId, status: "HIDDEN" });
      createdArtworkIds.push(hiddenId);
      // Visible one — this is what makes the tenant qualify.
      const visibleId = await createArtwork({ tenantId, status: "AVAILABLE" });
      createdArtworkIds.push(visibleId);

      const matched = await runArtistTenantQuery([tenantId]);
      expect(matched).toHaveLength(1);
    });

    it("excludes a FRAMER-type tenant even if it has a visible artwork", async () => {
      const tenantId = await createArtistTenant({ type: "FRAMER" });
      createdTenantIds.push(tenantId);

      const artworkId = await createArtwork({ tenantId, status: "AVAILABLE" });
      createdArtworkIds.push(artworkId);

      const matched = await runArtistTenantQuery([tenantId]);
      // artistTenantFilterWhere() requires type=ARTIST.
      expect(matched).toHaveLength(0);
    });

    it("excludes an ARTIST tenant with storefrontEnabled=false even if it has a visible artwork", async () => {
      const tenantId = await createArtistTenant({ storefrontEnabled: false });
      createdTenantIds.push(tenantId);

      const artworkId = await createArtwork({ tenantId, status: "AVAILABLE" });
      createdArtworkIds.push(artworkId);

      const matched = await runArtistTenantQuery([tenantId]);
      expect(matched).toHaveLength(0);
    });
  },
);
