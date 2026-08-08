/**
 * Public browse createdAt ordering — real-DB integration.
 *
 * app/browse/page.tsx:114 orders results by desc(artworksTable.createdAt).
 * This suite verifies newest-first ordering at the DB layer (seller-scoped):
 *
 *  1. Artworks are returned newest-first (createdAt DESC).
 *  2. Oldest artwork appears last in results.
 *  3. Newly inserted artwork appears before older ones.
 *  4. Ordering is consistent with pagination page=1.
 *  5. Hidden artworks are excluded and don't disrupt ordering of visible ones.
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  representedArtistsTable,
} from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { buildBrowseWhere } from "@/lib/browse-where";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];

const PAGE_SIZE = 24;

function uid() { return `${randomUUID()}-bcao-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Browse Order Test Gallery", type: "ARTIST",
    storefrontEnabled: true,
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id, slug: id };
}

async function insertArtwork(tenantId: string, opts: {
  status?: "AVAILABLE" | "HIDDEN";
  showInGallery?: boolean;
} = {}) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId,
    title: "Browse Order Test Art",
    sku: `sku-${id}`,
    status: opts.status ?? "AVAILABLE",
    showInGallery: opts.showInGallery ?? true,
  } as any);
  createdArtworkIds.push(id);
  // Small delay to ensure distinct createdAt timestamps.
  await new Promise(r => setTimeout(r, 2));
  return id;
}

/** Mirror the browse page query — returns rows ordered by createdAt DESC. */
async function browseOrdered(slug: string) {
  const where = buildBrowseWhere({ seller: slug });
  return db
    .select({ id: artworksTable.id, createdAt: artworksTable.createdAt })
    .from(artworksTable)
    .leftJoin(tenantsTable, eq(artworksTable.tenantId, tenantsTable.id))
    .leftJoin(
      representedArtistsTable,
      eq(artworksTable.representedArtistId, representedArtistsTable.id),
    )
    .where(where as any)
    .orderBy(desc(artworksTable.createdAt))
    .limit(PAGE_SIZE);
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

describeIntegration("Public browse createdAt ordering — real-DB integration", () => {
  it("artworks are returned newest-first (createdAt DESC)", async () => {
    const { tenantId, slug } = await createTenant();
    const first  = await insertArtwork(tenantId);
    const second = await insertArtwork(tenantId);
    const third  = await insertArtwork(tenantId);

    const rows = await browseOrdered(slug);
    const ids = rows.map(r => r.id);

    // Newest (third) must appear before second and first.
    const idxFirst  = ids.indexOf(first);
    const idxSecond = ids.indexOf(second);
    const idxThird  = ids.indexOf(third);

    expect(idxThird).toBeLessThan(idxSecond);
    expect(idxSecond).toBeLessThan(idxFirst);
  });

  it("oldest artwork appears last among own artworks", async () => {
    const { tenantId, slug } = await createTenant();
    const oldest = await insertArtwork(tenantId);
    await insertArtwork(tenantId);
    await insertArtwork(tenantId);

    const rows = await browseOrdered(slug);
    const ids = rows.map(r => r.id);

    expect(ids[ids.length - 1]).toBe(oldest);
  });

  it("newly inserted artwork appears before older ones", async () => {
    const { tenantId, slug } = await createTenant();
    await insertArtwork(tenantId);
    await insertArtwork(tenantId);
    const newest = await insertArtwork(tenantId);

    const rows = await browseOrdered(slug);
    expect(rows[0]!.id).toBe(newest);
  });

  it("ordering is consistent: all visible artworks appear in DESC order", async () => {
    const { tenantId, slug } = await createTenant();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await insertArtwork(tenantId));

    const rows = await browseOrdered(slug);
    const returnedIds = rows.map(r => r.id);

    // Verify strict descending createdAt order.
    for (let i = 0; i < rows.length - 1; i++) {
      const curr = rows[i]!.createdAt!.getTime();
      const next = rows[i + 1]!.createdAt!.getTime();
      expect(curr).toBeGreaterThanOrEqual(next);
    }
    // All inserted artworks must be present.
    for (const id of ids) expect(returnedIds).toContain(id);
  });

  it("HIDDEN artworks are excluded and don't disrupt ordering of visible ones", async () => {
    const { tenantId, slug } = await createTenant();
    const visible1 = await insertArtwork(tenantId, { status: "AVAILABLE" });
    const hidden   = await insertArtwork(tenantId, { status: "HIDDEN" });
    const visible2 = await insertArtwork(tenantId, { status: "AVAILABLE" });

    const rows = await browseOrdered(slug);
    const ids = rows.map(r => r.id);

    // Hidden excluded.
    expect(ids).not.toContain(hidden);
    // visible2 (newer) before visible1 (older).
    expect(ids.indexOf(visible2)).toBeLessThan(ids.indexOf(visible1));
  });
});
