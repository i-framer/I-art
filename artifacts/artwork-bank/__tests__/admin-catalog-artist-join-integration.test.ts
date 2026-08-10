/**
 * Admin catalog represented-artist left-join — real-DB integration.
 *
 * app/(admin)/(gated)/catalog/page.tsx:96-104 selects `artistName` via a
 * leftJoin on representedArtistsTable. This suite verifies:
 *
 *  1. Artwork with a representedArtistId returns the artist name in the row.
 *  2. Artwork with null representedArtistId returns null artistName.
 *  3. Artwork returns its own artist name, not a different artwork's artist.
 *  4. Artist name from a foreign tenant is not visible via the join.
 *  5. Multiple artworks with the same artist all return the correct name.
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  artworkImagesTable,
  representedArtistsTable,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdArtistIds: string[] = [];

function uid() { return `${randomUUID()}-acaj-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Catalog Artist Join Test", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtist(tenantId: string, name: string) {
  const id = uid();
  await db.insert(representedArtistsTable).values({ id, tenantId, name } as any);
  createdArtistIds.push(id);
  return id;
}

async function createArtwork(tenantId: string, artistId?: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Catalog Join Test Art", sku: `sku-${id}`,
    status: "AVAILABLE",
    representedArtistId: artistId ?? null,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

/** Mirror the admin catalog left-join query for a specific tenant. */
async function catalogQuery(tenantId: string) {
  return db
    .select({
      artwork: artworksTable,
      artistName: representedArtistsTable.name,
    })
    .from(artworksTable)
    .leftJoin(
      artworkImagesTable,
      and(
        eq(artworkImagesTable.artworkId, artworksTable.id),
        eq(artworkImagesTable.isPrimary, true),
      ),
    )
    .leftJoin(
      representedArtistsTable,
      eq(artworksTable.representedArtistId, representedArtistsTable.id),
    )
    .where(eq(artworksTable.tenantId, tenantId))
    .orderBy(desc(artworksTable.createdAt));
}

async function cleanup() {
  for (const id of createdArtworkIds.splice(0)) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdArtistIds.splice(0)) {
    await db.delete(representedArtistsTable).where(eq(representedArtistsTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Admin catalog represented-artist left-join — real-DB integration", () => {
  it("artwork with representedArtistId returns the artist name", async () => {
    const tenantId  = await createTenant();
    const artistId  = await createArtist(tenantId, "Maria Gonzalez");
    const artworkId = await createArtwork(tenantId, artistId);

    const rows = await catalogQuery(tenantId);
    const row = rows.find(r => r.artwork.id === artworkId);

    expect(row).toBeDefined();
    expect(row?.artistName).toBe("Maria Gonzalez");
  });

  it("artwork with null representedArtistId returns null artistName", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId); // no artist

    const rows = await catalogQuery(tenantId);
    const row = rows.find(r => r.artwork.id === artworkId);

    expect(row).toBeDefined();
    expect(row?.artistName).toBeNull();
  });

  it("artwork returns its own artist name, not a sibling artwork's artist", async () => {
    const tenantId  = await createTenant();
    const artist1   = await createArtist(tenantId, "Painter One");
    const artist2   = await createArtist(tenantId, "Sculptor Two");
    const artwork1  = await createArtwork(tenantId, artist1);
    const artwork2  = await createArtwork(tenantId, artist2);

    const rows = await catalogQuery(tenantId);
    const row1 = rows.find(r => r.artwork.id === artwork1);
    const row2 = rows.find(r => r.artwork.id === artwork2);

    expect(row1?.artistName).toBe("Painter One");
    expect(row2?.artistName).toBe("Sculptor Two");
  });

  it("foreign tenant's artist name is not returned for own artworks", async () => {
    const ownTenantId     = await createTenant();
    const foreignTenantId = await createTenant();
    const _foreignArtist   = await createArtist(foreignTenantId, "Foreign Artist");

    // Own artwork has no artist.
    const ownArtworkId = await createArtwork(ownTenantId);

    // Own-tenant query must not surface the foreign artist.
    const rows = await catalogQuery(ownTenantId);
    const row = rows.find(r => r.artwork.id === ownArtworkId);

    expect(row?.artistName).toBeNull();
    // Foreign artist should not appear anywhere in own-tenant results.
    expect(rows.map(r => r.artistName)).not.toContain("Foreign Artist");
  });

  it("multiple artworks linked to the same artist all return the correct name", async () => {
    const tenantId  = await createTenant();
    const artistId  = await createArtist(tenantId, "Shared Artist");
    const artwork1  = await createArtwork(tenantId, artistId);
    const artwork2  = await createArtwork(tenantId, artistId);
    const artwork3  = await createArtwork(tenantId, artistId);

    const rows = await catalogQuery(tenantId);
    const artworkIds = [artwork1, artwork2, artwork3];
    const matched = rows.filter(r => artworkIds.includes(r.artwork.id));

    expect(matched).toHaveLength(3);
    for (const r of matched) {
      expect(r.artistName).toBe("Shared Artist");
    }
  });
});
