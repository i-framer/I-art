/**
 * Task #283 — Confirm the artist filter still works when artworks are SOLD or
 * RESERVED on a real database.
 *
 * buildBrowseWhere({ artist: "Name" }) filters browse results to artworks by a
 * named represented artist (or ARTIST-type tenant).  SOLD and RESERVED are
 * visible statuses — they must appear in results so buyers can browse a
 * gallery's full portfolio, including already-sold pieces.
 *
 * The existing browse-artist-filter-integration.test.ts tests AVAILABLE
 * artworks and HIDDEN/showInGallery=false exclusions, but never exercises SOLD
 * or RESERVED status.  These integration tests confirm that gap explicitly.
 *
 * Coverage:
 *   Represented-artist path (FRAMER tenant with represented artists):
 *     - SOLD artwork from a matching represented artist → included in results
 *     - RESERVED artwork from a matching represented artist → included
 *     - SOLD + RESERVED mixed with AVAILABLE → all returned
 *   ARTIST-type tenant path (businessName filter):
 *     - SOLD artwork from a matching ARTIST tenant → included
 *     - RESERVED artwork from a matching ARTIST tenant → included
 *   Negative: HIDDEN still excluded even when artist matches and other works are SOLD/RESERVED
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

async function createTenant(overrides: {
  type?: "ARTIST" | "FRAMER";
  businessName?: string;
}) {
  const id = uid();
  await db.insert(tenantsTable).values({
    id,
    type: overrides.type ?? "FRAMER",
    businessName: overrides.businessName ?? `Test Gallery 283 ${id}`,
    slug: `test-slug-283-${id}`,
    storefrontEnabled: true,
  } as any);
  return id;
}

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

async function createArtwork(overrides: {
  tenantId: string;
  title?: string;
  representedArtistId?: string | null;
  showInGallery?: boolean;
  status?: "AVAILABLE" | "SOLD" | "RESERVED" | "HIDDEN";
}) {
  const id = uid();
  await db.insert(artworksTable).values({
    id,
    tenantId: overrides.tenantId,
    title: overrides.title ?? `Test Artwork 283 ${id}`,
    sku: `SKU-283-${id}`,
    representedArtistId: overrides.representedArtistId ?? null,
    showInGallery: overrides.showInGallery ?? true,
    status: overrides.status ?? "AVAILABLE",
  } as any);
  return id;
}

/** Execute the browse join and return matched artwork IDs from the seeded set. */
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
const createdArtistIds: string[] = [];

beforeEach(() => {
  createdTenantIds.length = 0;
  createdArtworkIds.length = 0;
  createdArtistIds.length = 0;
});

afterEach(async () => {
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

// ── Represented-artist path ───────────────────────────────────────────────────

describeIntegration(
  "browse artist filter — SOLD and RESERVED artworks included (represented-artist path, Task #283)",
  () => {
    it("includes a SOLD artwork when the represented artist matches the filter", async () => {
      const tenantId = await createTenant({ type: "FRAMER" });
      createdTenantIds.push(tenantId);

      const artistId = await createRepresentedArtist({
        tenantId,
        name: "Elena Voss",
      });
      createdArtistIds.push(artistId);

      const artworkId = await createArtwork({
        tenantId,
        representedArtistId: artistId,
        status: "SOLD",
      });
      createdArtworkIds.push(artworkId);

      const matched = await runBrowseQuery({ artist: "Elena Voss" }, [artworkId]);

      expect(matched).toContain(artworkId);
    });

    it("includes a RESERVED artwork when the represented artist matches the filter", async () => {
      const tenantId = await createTenant({ type: "FRAMER" });
      createdTenantIds.push(tenantId);

      const artistId = await createRepresentedArtist({
        tenantId,
        name: "Elena Voss",
      });
      createdArtistIds.push(artistId);

      const artworkId = await createArtwork({
        tenantId,
        representedArtistId: artistId,
        status: "RESERVED",
      });
      createdArtworkIds.push(artworkId);

      const matched = await runBrowseQuery({ artist: "Elena Voss" }, [artworkId]);

      expect(matched).toContain(artworkId);
    });

    it("returns AVAILABLE, SOLD, and RESERVED together when all belong to the matching artist", async () => {
      const tenantId = await createTenant({ type: "FRAMER" });
      createdTenantIds.push(tenantId);

      const artistId = await createRepresentedArtist({
        tenantId,
        name: "Marcus Bell",
      });
      createdArtistIds.push(artistId);

      const availableId = await createArtwork({
        tenantId, representedArtistId: artistId, status: "AVAILABLE",
      });
      const soldId = await createArtwork({
        tenantId, representedArtistId: artistId, status: "SOLD",
      });
      const reservedId = await createArtwork({
        tenantId, representedArtistId: artistId, status: "RESERVED",
      });
      createdArtworkIds.push(availableId, soldId, reservedId);

      const matched = await runBrowseQuery(
        { artist: "Marcus Bell" },
        [availableId, soldId, reservedId],
      );

      expect(matched).toContain(availableId);
      expect(matched).toContain(soldId);
      expect(matched).toContain(reservedId);
    });

    it("excludes a HIDDEN artwork from the same artist even when SOLD/RESERVED artworks are present", async () => {
      const tenantId = await createTenant({ type: "FRAMER" });
      createdTenantIds.push(tenantId);

      const artistId = await createRepresentedArtist({
        tenantId,
        name: "Priya Nair",
      });
      createdArtistIds.push(artistId);

      const soldId = await createArtwork({
        tenantId, representedArtistId: artistId, status: "SOLD",
      });
      const hiddenId = await createArtwork({
        tenantId, representedArtistId: artistId, status: "HIDDEN",
      });
      createdArtworkIds.push(soldId, hiddenId);

      const matched = await runBrowseQuery(
        { artist: "Priya Nair" },
        [soldId, hiddenId],
      );

      expect(matched).toContain(soldId);
      expect(matched).not.toContain(hiddenId);
    });
  },
);

// ── ARTIST-type tenant path ───────────────────────────────────────────────────

describeIntegration(
  "browse artist filter — SOLD and RESERVED artworks included (ARTIST-type tenant path, Task #283)",
  () => {
    it("includes a SOLD artwork from an ARTIST-type tenant when businessName matches", async () => {
      const artistName = `Artist283-${uid().slice(0, 8)}`;
      const tenantId = await createTenant({
        type: "ARTIST",
        businessName: artistName,
      });
      createdTenantIds.push(tenantId);

      const artworkId = await createArtwork({
        tenantId,
        status: "SOLD",
      });
      createdArtworkIds.push(artworkId);

      const matched = await runBrowseQuery({ artist: artistName }, [artworkId]);

      expect(matched).toContain(artworkId);
    });

    it("includes a RESERVED artwork from an ARTIST-type tenant when businessName matches", async () => {
      const artistName = `Artist283-${uid().slice(0, 8)}`;
      const tenantId = await createTenant({
        type: "ARTIST",
        businessName: artistName,
      });
      createdTenantIds.push(tenantId);

      const artworkId = await createArtwork({
        tenantId,
        status: "RESERVED",
      });
      createdArtworkIds.push(artworkId);

      const matched = await runBrowseQuery({ artist: artistName }, [artworkId]);

      expect(matched).toContain(artworkId);
    });

    it("returns all AVAILABLE, SOLD, and RESERVED artworks from a matching ARTIST-type tenant", async () => {
      const artistName = `Artist283Multi-${uid().slice(0, 8)}`;
      const tenantId = await createTenant({
        type: "ARTIST",
        businessName: artistName,
      });
      createdTenantIds.push(tenantId);

      const availableId = await createArtwork({ tenantId, status: "AVAILABLE" });
      const soldId      = await createArtwork({ tenantId, status: "SOLD" });
      const reservedId  = await createArtwork({ tenantId, status: "RESERVED" });
      createdArtworkIds.push(availableId, soldId, reservedId);

      const matched = await runBrowseQuery(
        { artist: artistName },
        [availableId, soldId, reservedId],
      );

      expect(matched).toContain(availableId);
      expect(matched).toContain(soldId);
      expect(matched).toContain(reservedId);
    });
  },
);
