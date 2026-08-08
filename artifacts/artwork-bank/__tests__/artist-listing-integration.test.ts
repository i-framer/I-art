/**
 * Admin artists listing — real-DB integration.
 *
 * app/(admin)/(gated)/catalog/artists/page.tsx queries:
 *  - representedArtistsTable WHERE tenantId = session.tenantId ORDER BY name ASC
 *  - artworksTable grouped by representedArtistId for per-artist artwork counts
 *
 * Verifies:
 *  1. All artists for the tenant appear, ordered by name ASC.
 *  2. Artists from a foreign tenant are excluded.
 *  3. Per-artist artwork count is correct (own artworks only, including zero).
 *  4. Foreign-tenant artworks do not inflate the own count.
 *  5. All artists are returned (no accidental pagination limit).
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  representedArtistsTable,
} from "@workspace/db";
import { asc, count, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtistIds: string[] = [];
const createdArtworkIds: string[] = [];

function uid() { return `${randomUUID()}-artlist-${RUN}-${++seq}`; }

async function createTenant(type = "FRAMER") {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Artist Listing Test Gallery",
    type, billingExempt: true,
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

async function createArtwork(tenantId: string, artistId: string | null) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId,
    title: "Artist List Artwork", sku: `sku-${id.slice(0, 8)}`,
    status: "AVAILABLE",
    representedArtistId: artistId,
  } as any);
  createdArtworkIds.push(id);
  return id;
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

// ── Inline query (mirrors page.tsx) ──────────────────────────────────────────

async function listArtists(tenantId: string, includeIds: string[]) {
  const artists = await db.query.representedArtistsTable.findMany({
    where: eq(representedArtistsTable.tenantId, tenantId),
    orderBy: [asc(representedArtistsTable.name)],
  });

  const artworkCounts = await db
    .select({ artistId: artworksTable.representedArtistId, count: count() })
    .from(artworksTable)
    .where(eq(artworksTable.tenantId, tenantId))
    .groupBy(artworksTable.representedArtistId);

  const countMap = new Map(artworkCounts.map(r => [r.artistId, r.count]));

  return artists
    .filter(a => includeIds.includes(a.id))
    .map(a => ({ ...a, artworkCount: countMap.get(a.id) ?? 0 }));
}

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Admin artists listing — real-DB integration", () => {
  it("all artists for tenant appear, ordered by name ASC", async () => {
    const tenantId = await createTenant();
    const zebId = await createArtist(tenantId, "Zebra Painter");
    const alphaId = await createArtist(tenantId, "Alpha Sculptor");
    const midId = await createArtist(tenantId, "Midpoint Artist");

    const rows = await listArtists(tenantId, [zebId, alphaId, midId]);

    expect(rows).toHaveLength(3);
    expect(rows[0].name).toBe("Alpha Sculptor");
    expect(rows[1].name).toBe("Midpoint Artist");
    expect(rows[2].name).toBe("Zebra Painter");
  });

  it("foreign tenant artists are excluded", async () => {
    const tenantId = await createTenant();
    const foreignTenantId = await createTenant();

    const ownArtistId = await createArtist(tenantId, "Own Artist");
    const foreignArtistId = await createArtist(foreignTenantId, "Foreign Artist");

    const rows = await listArtists(tenantId, [ownArtistId, foreignArtistId]);

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(ownArtistId);
  });

  it("per-artist artwork count is correct (non-zero)", async () => {
    const tenantId = await createTenant();
    const artistId = await createArtist(tenantId, "Counted Artist");

    await createArtwork(tenantId, artistId);
    await createArtwork(tenantId, artistId);
    await createArtwork(tenantId, artistId);

    const rows = await listArtists(tenantId, [artistId]);

    expect(rows[0].artworkCount).toBe(3);
  });

  it("artist with no artworks has count = 0", async () => {
    const tenantId = await createTenant();
    const artistId = await createArtist(tenantId, "Empty Artist");

    const rows = await listArtists(tenantId, [artistId]);

    expect(rows[0].artworkCount).toBe(0);
  });

  it("foreign-tenant artworks do not inflate the own artist count", async () => {
    const tenantId = await createTenant();
    const foreignTenantId = await createTenant();

    const ownArtistId = await createArtist(tenantId, "Own Count Artist");
    const foreignArtistId = await createArtist(foreignTenantId, "Foreign Artist");

    // 2 artworks linked to own artist.
    await createArtwork(tenantId, ownArtistId);
    await createArtwork(tenantId, ownArtistId);
    // 5 foreign artworks — should NOT appear in own count.
    for (let i = 0; i < 5; i++) await createArtwork(foreignTenantId, foreignArtistId);

    const rows = await listArtists(tenantId, [ownArtistId]);

    expect(rows[0].artworkCount).toBe(2);
  });

  it("all artists returned regardless of count (no accidental limit)", async () => {
    const tenantId = await createTenant();
    const ids: string[] = [];

    for (let i = 0; i < 30; i++) {
      ids.push(await createArtist(tenantId, `Artist ${String(i).padStart(2, "0")}`));
    }

    const rows = await listArtists(tenantId, ids);

    expect(rows).toHaveLength(30);
    // Verify ordering is intact.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].name <= rows[i].name).toBe(true);
    }
  });
});
