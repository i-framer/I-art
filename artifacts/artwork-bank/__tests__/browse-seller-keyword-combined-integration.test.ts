/**
 * Task #287 — Confirm the seller-slug (seller=) and keyword (q=) filters
 * combine correctly when both are supplied.
 *
 * The key risk is an OR/AND precedence bug where the keyword OR across
 * title/artist name/businessName accidentally swallows the seller-slug AND,
 * returning artworks from any matching seller OR keyword — rather than the
 * intersection (seller AND keyword).
 *
 * These run against a real PostgreSQL instance, executing buildBrowseWhere()
 * via the same JOIN the browse page uses.
 *
 * Coverage:
 *   - seller= alone: returns only that seller's artworks.
 *   - q= alone: returns artworks from any seller whose title matches.
 *   - seller= AND q= combined: returns ONLY artworks from that seller AND
 *     matching the keyword (not artworks matching keyword from other sellers).
 *   - seller= AND q= with no matching artwork in the seller's inventory → empty.
 *   - Title keyword match on the correct seller is included; title match on a
 *     different seller is excluded when seller= is also supplied.
 */
import { it, expect, beforeEach, afterEach } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { randomUUID } from "node:crypto";

import {
  db,
  tenantsTable,
  artworksTable,
  representedArtistsTable,
  artworkImagesTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { buildBrowseWhere } from "@/lib/browse-where";

function uid() {
  return randomUUID();
}

/** Insert a minimal storefrontEnabled tenant with a known slug. */
async function createTenant(overrides: {
  businessName?: string;
  slug?: string;
}) {
  const id = uid();
  const slug = overrides.slug ?? `test-slug-287-${id}`;
  await db.insert(tenantsTable).values({
    id,
    type: "ARTIST",
    businessName: overrides.businessName ?? `Test Gallery 287 ${id}`,
    slug,
    storefrontEnabled: true,
  } as any);
  return { id, slug };
}

/** Insert a minimal artwork. */
async function createArtwork(overrides: {
  tenantId: string;
  title?: string;
  showInGallery?: boolean;
  status?: "AVAILABLE" | "SOLD" | "RESERVED" | "HIDDEN";
}) {
  const id = uid();
  await db.insert(artworksTable).values({
    id,
    tenantId: overrides.tenantId,
    title: overrides.title ?? `Test Artwork 287 ${id}`,
    sku: `SKU-287-${id}`,
    showInGallery: overrides.showInGallery ?? true,
    status: overrides.status ?? "AVAILABLE",
  } as any);
  return id;
}

/**
 * Execute the browse query with the same JOIN the browse page uses, returning
 * only rows whose artworkId is in the seeded set.
 */
async function runBrowseQuery(
  searchParams: Record<string, string>,
  seededArtworkIds: string[],
) {
  const whereClause = buildBrowseWhere(searchParams as any);
  const rows = await db
    .select({ artworkId: artworksTable.id })
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

  const seededSet = new Set(seededArtworkIds);
  return rows
    .filter((r) => seededSet.has(r.artworkId))
    .map((r) => r.artworkId);
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
  "buildBrowseWhere — seller-slug + keyword (q=) combine correctly (Task #287)",
  () => {
    it("seller= alone returns only that seller's artworks (positive control)", async () => {
      const { id: tenantA, slug: slugA } = await createTenant({});
      createdTenantIds.push(tenantA);
      const { id: tenantB } = await createTenant({});
      createdTenantIds.push(tenantB);

      const artA = await createArtwork({ tenantId: tenantA, title: "Blue Horizon" });
      createdArtworkIds.push(artA);
      const artB = await createArtwork({ tenantId: tenantB, title: "Blue Horizon" });
      createdArtworkIds.push(artB);

      const matched = await runBrowseQuery(
        { seller: slugA },
        [artA, artB],
      );

      // Only tenantA's artwork must appear.
      expect(matched).toContain(artA);
      expect(matched).not.toContain(artB);
    });

    it("q= alone returns artworks from ANY seller whose title matches", async () => {
      const { id: tenantA } = await createTenant({});
      createdTenantIds.push(tenantA);
      const { id: tenantB } = await createTenant({});
      createdTenantIds.push(tenantB);

      const uniqueKeyword = `UniqueKw287-${uid().slice(0, 8)}`;

      const artA = await createArtwork({ tenantId: tenantA, title: `${uniqueKeyword} piece` });
      createdArtworkIds.push(artA);
      const artB = await createArtwork({ tenantId: tenantB, title: `${uniqueKeyword} piece` });
      createdArtworkIds.push(artB);
      // Artwork that does NOT match the keyword.
      const artC = await createArtwork({ tenantId: tenantA, title: "Something Else" });
      createdArtworkIds.push(artC);

      const matched = await runBrowseQuery({ q: uniqueKeyword }, [artA, artB, artC]);

      expect(matched).toContain(artA);
      expect(matched).toContain(artB);
      expect(matched).not.toContain(artC);
    });

    it("seller= AND q= combined: returns only artworks from THAT seller AND matching keyword (not other sellers)", async () => {
      const { id: tenantA, slug: slugA } = await createTenant({});
      createdTenantIds.push(tenantA);
      const { id: tenantB } = await createTenant({});
      createdTenantIds.push(tenantB);

      const uniqueKeyword = `CombinedKw287-${uid().slice(0, 8)}`;

      // tenantA has a matching artwork.
      const artAMatch = await createArtwork({
        tenantId: tenantA,
        title: `${uniqueKeyword} landscape`,
      });
      createdArtworkIds.push(artAMatch);

      // tenantA has a non-matching artwork.
      const artANoMatch = await createArtwork({
        tenantId: tenantA,
        title: "Portrait Study",
      });
      createdArtworkIds.push(artANoMatch);

      // tenantB has a matching keyword but different seller — must be excluded.
      const artBMatch = await createArtwork({
        tenantId: tenantB,
        title: `${uniqueKeyword} seascape`,
      });
      createdArtworkIds.push(artBMatch);

      const matched = await runBrowseQuery(
        { seller: slugA, q: uniqueKeyword },
        [artAMatch, artANoMatch, artBMatch],
      );

      // Only artAMatch satisfies BOTH seller=tenantA AND title contains keyword.
      expect(matched).toContain(artAMatch);
      expect(matched).not.toContain(artANoMatch); // wrong title
      expect(matched).not.toContain(artBMatch);   // wrong seller
    });

    it("seller= AND q= returns empty when the seller has no artwork matching the keyword", async () => {
      const { id: tenantA, slug: slugA } = await createTenant({});
      createdTenantIds.push(tenantA);

      // Only artwork does NOT match the keyword.
      const artId = await createArtwork({
        tenantId: tenantA,
        title: "Autumn Still Life",
      });
      createdArtworkIds.push(artId);

      const matched = await runBrowseQuery(
        { seller: slugA, q: "NeverMatchKw287" },
        [artId],
      );

      expect(matched).toHaveLength(0);
    });

    it("seller= AND q= returns empty when the seller slug does not exist", async () => {
      const { id: tenantA } = await createTenant({});
      createdTenantIds.push(tenantA);

      const artId = await createArtwork({ tenantId: tenantA, title: "Misty Morning" });
      createdArtworkIds.push(artId);

      const matched = await runBrowseQuery(
        { seller: "nonexistent-slug-287", q: "Misty" },
        [artId],
      );

      expect(matched).toHaveLength(0);
    });

    it("keyword match on seller's businessName is included when seller= also matches", async () => {
      const uniqueKeyword = `BizKw287-${uid().slice(0, 8)}`;
      const { id: tenantA, slug: slugA } = await createTenant({
        businessName: `${uniqueKeyword} Gallery`,
      });
      createdTenantIds.push(tenantA);

      // tenantB also matches the keyword on businessName — must be excluded.
      const { id: tenantB } = await createTenant({
        businessName: `${uniqueKeyword} Studio`,
      });
      createdTenantIds.push(tenantB);

      const artA = await createArtwork({
        tenantId: tenantA,
        title: "Abstract in Red",
      });
      createdArtworkIds.push(artA);

      const artB = await createArtwork({
        tenantId: tenantB,
        title: "Abstract in Blue",
      });
      createdArtworkIds.push(artB);

      const matched = await runBrowseQuery(
        { seller: slugA, q: uniqueKeyword },
        [artA, artB],
      );

      // artA: seller=tenantA ✓  keyword matches businessName ✓ → included
      // artB: seller=tenantB ✗                                  → excluded
      expect(matched).toContain(artA);
      expect(matched).not.toContain(artB);
    });
  },
);
