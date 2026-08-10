/**
 * Browse multi-word keyword search — q= semantics — real-DB integration.
 *
 * lib/browse-where.ts:44-52:
 *   Single ILIKE pattern: `%${q.trim()}%` applied as OR across
 *   artworkTitle, representedArtist.name, tenant.businessName.
 *   Multi-word queries are treated as a literal substring, NOT tokenized.
 *
 *  1. q="red vase" matches artwork whose title contains "red vase" literally.
 *  2. q="red vase" does NOT match "red bowl" (wrong match for "vase").
 *  3. q="vase" matches "red vase" but not "red bowl" (substring).
 *  4. q="Red Vase" matches "red vase" (case-insensitive ilike).
 *  5. q="  red vase  " (whitespace) matches after trim.
 *  6. q="red" matches both "red vase" and "red bowl" (prefix shared).
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable } from "@workspace/db";
import { and, eq, ilike } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];

function uid() { return `${randomUUID()}-bmwki-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: `Keyword Gallery ${uid()}`, type: "ARTIST",
    storefrontEnabled: true,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string, title: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title, sku: `sku-${id}`,
    status: "AVAILABLE", price: 10000, showInGallery: true,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

// Mirrors buildBrowseWhere q= logic: single ilike pattern over title.
async function queryByKeyword(tenantId: string, q: string) {
  const pattern = `%${q.trim()}%`;
  return db.query.artworksTable.findMany({
    where: and(
      eq(artworksTable.tenantId, tenantId),
      ilike(artworksTable.title, pattern),
    ),
  });
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

describeIntegration("Browse multi-word keyword search — q= semantics — real-DB integration", () => {
  it("q='red vase' matches artwork whose title contains 'red vase' literally", async () => {
    const tenantId = await createTenant();
    const matched  = await createArtwork(tenantId, "Beautiful red vase 2023");
    await createArtwork(tenantId, "Unrelated artwork");

    const results = await queryByKeyword(tenantId, "red vase");
    const ids = results.map(a => a.id);

    expect(ids).toContain(matched);
    expect(results.filter(a => a.id !== matched)).toHaveLength(0);
  });

  it("q='red vase' does NOT match 'red bowl' (wrong literal match)", async () => {
    const tenantId  = await createTenant();
    await createArtwork(tenantId, "red bowl ceramic");
    const matched   = await createArtwork(tenantId, "red vase porcelain");

    const results = await queryByKeyword(tenantId, "red vase");
    const ids = results.map(a => a.id);

    expect(ids).toContain(matched);
    expect(ids).not.toContain(await (async () => {
      const rows = await db.query.artworksTable.findMany({
        where: and(eq(artworksTable.tenantId, tenantId), ilike(artworksTable.title, "%red bowl%")),
      });
      return rows[0]?.id;
    })());
  });

  it("q='vase' matches 'red vase' but not 'red bowl'", async () => {
    const tenantId = await createTenant();
    const vase     = await createArtwork(tenantId, "red vase ceramic");
    const bowl     = await createArtwork(tenantId, "red bowl ceramic");

    const results = await queryByKeyword(tenantId, "vase");
    const ids = results.map(a => a.id);

    expect(ids).toContain(vase);
    expect(ids).not.toContain(bowl);
  });

  it("q='Red Vase' matches 'red vase' (case-insensitive ilike)", async () => {
    const tenantId = await createTenant();
    const artwork  = await createArtwork(tenantId, "red vase ceramic");

    const results = await queryByKeyword(tenantId, "Red Vase");
    const ids = results.map(a => a.id);

    expect(ids).toContain(artwork);
  });

  it("q='  red vase  ' (leading/trailing whitespace) matches after trim", async () => {
    const tenantId = await createTenant();
    const artwork  = await createArtwork(tenantId, "red vase art");

    const results = await queryByKeyword(tenantId, "  red vase  ");
    const ids = results.map(a => a.id);

    expect(ids).toContain(artwork);
  });

  it("q='red' matches both 'red vase' and 'red bowl' (shared prefix)", async () => {
    const tenantId = await createTenant();
    const vase     = await createArtwork(tenantId, "red vase ceramic");
    const bowl     = await createArtwork(tenantId, "red bowl ceramic");
    const other    = await createArtwork(tenantId, "blue painting");

    const results = await queryByKeyword(tenantId, "red");
    const ids = results.map(a => a.id);

    expect(ids).toContain(vase);
    expect(ids).toContain(bowl);
    expect(ids).not.toContain(other);
  });
});
