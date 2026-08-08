/**
 * Browse price-range — DB-level coverage — real-DB integration.
 *
 * NOTE: buildBrowseWhere (lib/browse-where.ts) does NOT yet implement priceMin/priceMax
 * query parameters. This suite verifies the DB-level price column filtering mechanics
 * (gte/lte on artworksTable.price) so that when the browse query adds price-range
 * support, the integration tests are ready to wire in.
 *
 * The tests query artworksTable directly with gte/lte rather than going through
 * buildBrowseWhere. They document the expected schema contract.
 *
 *  1. gte(price, min) excludes artworks below the minimum price.
 *  2. lte(price, max) excludes artworks above the maximum price.
 *  3. gte + lte combined returns only artworks within the range.
 *  4. Exact boundary values are included (inclusive gte/lte range).
 *  5. min > max with AND condition returns no results (empty range).
 *  6. No price condition returns all artworks (schema has no price constraint).
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable } from "@workspace/db";
import { eq, and, gte, lte } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];

function uid() { return `${randomUUID()}-bprf-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Price Range Test Gallery", type: "ARTIST",
    storefrontEnabled: true,
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id };
}

async function createArtwork(tenantId: string, price: number) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: `Price Art ${price}`, sku: `sku-${id}`,
    status: "AVAILABLE", price, showInGallery: true,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function queryByPrice(tenantId: string, opts: { priceMin?: number; priceMax?: number } = {}) {
  const conditions: any[] = [eq(artworksTable.tenantId, tenantId)];
  if (opts.priceMin != null) conditions.push(gte(artworksTable.price, opts.priceMin));
  if (opts.priceMax != null) conditions.push(lte(artworksTable.price, opts.priceMax));
  return db.query.artworksTable.findMany({ where: and(...conditions) });
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

describeIntegration("Browse price-range DB filter — real-DB integration", () => {
  it("gte(price, min) excludes artworks below the minimum price", async () => {
    const { tenantId } = await createTenant();
    const cheap  = await createArtwork(tenantId, 5000);
    const mid    = await createArtwork(tenantId, 15000);
    const pricey = await createArtwork(tenantId, 30000);

    const results = await queryByPrice(tenantId, { priceMin: 10000 });
    const ids = results.map(a => a.id);

    expect(ids).toContain(mid);
    expect(ids).toContain(pricey);
    expect(ids).not.toContain(cheap);
  });

  it("lte(price, max) excludes artworks above the maximum price", async () => {
    const { tenantId } = await createTenant();
    const cheap  = await createArtwork(tenantId, 5000);
    const mid    = await createArtwork(tenantId, 15000);
    const pricey = await createArtwork(tenantId, 30000);

    const results = await queryByPrice(tenantId, { priceMax: 20000 });
    const ids = results.map(a => a.id);

    expect(ids).toContain(cheap);
    expect(ids).toContain(mid);
    expect(ids).not.toContain(pricey);
  });

  it("gte + lte combined returns only artworks within the range", async () => {
    const { tenantId } = await createTenant();
    const low     = await createArtwork(tenantId, 4000);
    const inRange = await createArtwork(tenantId, 15000);
    const high    = await createArtwork(tenantId, 35000);

    const results = await queryByPrice(tenantId, { priceMin: 10000, priceMax: 25000 });
    const ids = results.map(a => a.id);

    expect(ids).toContain(inRange);
    expect(ids).not.toContain(low);
    expect(ids).not.toContain(high);
  });

  it("exact boundary values are included (inclusive gte/lte)", async () => {
    const { tenantId } = await createTenant();
    const atMin = await createArtwork(tenantId, 10000);
    const atMax = await createArtwork(tenantId, 20000);

    const results = await queryByPrice(tenantId, { priceMin: 10000, priceMax: 20000 });
    const ids = results.map(a => a.id);

    expect(ids).toContain(atMin);
    expect(ids).toContain(atMax);
  });

  it("min > max with AND returns no results (impossible range)", async () => {
    const { tenantId } = await createTenant();
    await createArtwork(tenantId, 15000);

    const results = await queryByPrice(tenantId, { priceMin: 30000, priceMax: 10000 });
    expect(results).toHaveLength(0);
  });

  it("no price condition returns all artworks", async () => {
    const { tenantId } = await createTenant();
    const a1 = await createArtwork(tenantId, 5000);
    const a2 = await createArtwork(tenantId, 50000);
    const a3 = await createArtwork(tenantId, 200000);

    const results = await queryByPrice(tenantId);
    const ids = results.map(a => a.id);

    expect(ids).toContain(a1);
    expect(ids).toContain(a2);
    expect(ids).toContain(a3);
  });
});
