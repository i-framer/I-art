/**
 * Browse combined seller= + q= filter — real-DB integration.
 *
 * lib/browse-where.ts:44-62:
 *   q=   → ILIKE on title / represented artist name / tenant businessName.
 *   seller= → exact tenant slug match.
 *   Both combined: artwork must satisfy BOTH predicates (AND semantics).
 *
 *  1. seller= + q= → only artworks matching BOTH conditions returned.
 *  2. seller= alone → all artworks from that seller returned.
 *  3. q= alone → artworks across tenants matching title.
 *  4. Artwork matching q= but from wrong seller → excluded.
 *  5. Artwork from correct seller but title mismatch → excluded.
 *  6. Combined filter returns zero when no artwork satisfies both.
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { buildBrowseWhere } from "@/lib/browse-where";
import { representedArtistsTable } from "@workspace/db";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];

function uid() { return `${randomUUID()}-bcski-${RUN}-${++seq}`; }

async function createTenant(name = `Browse Seller ${uid()}`) {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: name, type: "ARTIST",
    storefrontEnabled: true,
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id, slug: id };
}

async function createArtwork(tenantId: string, title: string, visible = true) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title, sku: `sku-${id}`,
    status: "AVAILABLE", price: 10000,
    showInGallery: visible,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

// Mirrors browse page query: buildBrowseWhere with real DB.
async function query(sp: { q?: string; seller?: string }) {
  const where = buildBrowseWhere(sp);
  return db
    .select({ artworkId: artworksTable.id })
    .from(artworksTable)
    .innerJoin(tenantsTable, eq(tenantsTable.id, artworksTable.tenantId))
    .leftJoin(
      representedArtistsTable,
      eq(representedArtistsTable.id, artworksTable.representedArtistId),
    )
    .where(where);
}

async function cleanup() {
  for (const id of createdArtworkIds.splice(0)) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Browse combined seller= + q= filter — real-DB integration", () => {
  it("seller= + q= → only artworks matching BOTH conditions returned", async () => {
    const { tenantId: tenantA, slug: slugA } = await createTenant();
    const { tenantId: tenantB }              = await createTenant();
    const matchBoth  = await createArtwork(tenantA, "Red Ceramic Vase");
    const wrongTitle = await createArtwork(tenantA, "Blue Painting");
    const wrongSeller= await createArtwork(tenantB, "Red Ceramic Vase");

    const results = await query({ seller: slugA, q: "Red Ceramic" });
    const ids = results.map(r => r.artworkId);

    expect(ids).toContain(matchBoth);
    expect(ids).not.toContain(wrongTitle);  // right seller, wrong title
    expect(ids).not.toContain(wrongSeller); // right title, wrong seller
  });

  it("seller= alone → all visible artworks from that seller returned", async () => {
    const { tenantId: tenantA, slug: slugA } = await createTenant();
    const { tenantId: tenantB }              = await createTenant();
    const artA1 = await createArtwork(tenantA, "Artwork One");
    const artA2 = await createArtwork(tenantA, "Artwork Two");
    const artB  = await createArtwork(tenantB, "Other Artwork");

    const results = await query({ seller: slugA });
    const ids = results.map(r => r.artworkId);

    expect(ids).toContain(artA1);
    expect(ids).toContain(artA2);
    expect(ids).not.toContain(artB);
  });

  it("q= alone → artworks matching title across all tenants", async () => {
    const { tenantId: tenantA } = await createTenant();
    const { tenantId: tenantB } = await createTenant();
    const artA = await createArtwork(tenantA, "Purple Abstract");
    const artB = await createArtwork(tenantB, "Purple Landscape");
    const miss = await createArtwork(tenantA, "Yellow Sunrise");

    const results = await query({ q: "Purple" });
    const ids = results.map(r => r.artworkId);

    expect(ids).toContain(artA);
    expect(ids).toContain(artB);
    expect(ids).not.toContain(miss);
  });

  it("artwork matching q= but from wrong seller → excluded when seller= set", async () => {
    const { tenantId: tenantA, slug: slugA } = await createTenant();
    const { tenantId: tenantB }              = await createTenant();
    const artA = await createArtwork(tenantA, "Sculpture");
    const artB = await createArtwork(tenantB, "Sculpture");

    const results = await query({ seller: slugA, q: "Sculpture" });
    const ids = results.map(r => r.artworkId);

    expect(ids).toContain(artA);
    expect(ids).not.toContain(artB); // same title but wrong seller
  });

  it("artwork from correct seller but title mismatch → excluded when q= set", async () => {
    const { tenantId, slug } = await createTenant();
    const match   = await createArtwork(tenantId, "Watercolor Sunrise");
    const nomatch = await createArtwork(tenantId, "Oil Cityscape");

    const results = await query({ seller: slug, q: "Watercolor" });
    const ids = results.map(r => r.artworkId);

    expect(ids).toContain(match);
    expect(ids).not.toContain(nomatch);
  });

  it("combined filter returns zero when no artwork satisfies both", async () => {
    const { tenantId: tenantA, slug: slugA } = await createTenant();
    const { tenantId: tenantB }              = await createTenant();
    await createArtwork(tenantA, "Marble Bust"); // right seller, wrong keyword
    await createArtwork(tenantB, "Ocean Wave");  // right keyword match? no — different seller

    const results = await query({ seller: slugA, q: "Ocean" });
    const ids = results.map(r => r.artworkId);

    // No artwork in tenantA has "Ocean" in title.
    expect(ids).toHaveLength(0);
  });
});
