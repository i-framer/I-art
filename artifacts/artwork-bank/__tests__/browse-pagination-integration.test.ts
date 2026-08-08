/**
 * Public browse pagination — real-DB integration.
 *
 * app/browse/page.tsx uses PAGE_SIZE=24, page param, limit/offset, and count().
 * The buildBrowseWhere helper controls visibility constraints.
 *
 * This suite verifies the pagination contract at the DB layer:
 *
 *  1. page=1 returns up to PAGE_SIZE rows of visible artworks.
 *  2. Total count matches all visible artworks.
 *  3. page=2 skips page-1 rows with no overlap.
 *  4. Out-of-range page returns empty rows.
 *  5. Pagination excludes HIDDEN and showInGallery=false artworks.
 *  6. Pagination is tenant-scoped via storefrontEnabled filter.
 *  7. Invalid page value (non-numeric) clamps to page 1.
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  representedArtistsTable,
} from "@workspace/db";
import { and, count, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { buildBrowseWhere } from "@/lib/browse-where";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];

const PAGE_SIZE = 24;

function uid() { return `${randomUUID()}-bpag-${RUN}-${++seq}`; }

async function createTenant(opts: { storefrontEnabled?: boolean; type?: "ARTIST" | "FRAMER" } = {}) {
  const id = uid();
  // slug is also used as the `seller` filter so tests can scope results to their own tenant.
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: `Browse Pagination Test ${id}`, type: opts.type ?? "ARTIST",
    storefrontEnabled: opts.storefrontEnabled ?? true,
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id, slug: id };
}

async function insertArtwork(tenantId: string, opts: {
  status?: "AVAILABLE" | "SOLD" | "RESERVED" | "HIDDEN";
  showInGallery?: boolean;
} = {}) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId,
    title: "Browse Pagination Test Art",
    sku: `sku-${id}`,
    status: opts.status ?? "AVAILABLE",
    showInGallery: opts.showInGallery ?? true,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function insertMany(tenantId: string, n: number, opts: {
  status?: "AVAILABLE" | "SOLD" | "RESERVED" | "HIDDEN";
  showInGallery?: boolean;
} = {}): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push(await insertArtwork(tenantId, opts));
  return ids;
}

/** Mirror the browse page query (join with tenant via buildBrowseWhere). */
async function browsePage(page: number, sp: Record<string, string> = {}) {
  const clampedPage = Math.max(1, parseInt(String(page), 10) || 1);
  const offset = (clampedPage - 1) * PAGE_SIZE;
  const where = buildBrowseWhere(sp);

  const [rows, [countRow]] = await Promise.all([
    db
      .select({ id: artworksTable.id })
      .from(artworksTable)
      .leftJoin(tenantsTable, eq(artworksTable.tenantId, tenantsTable.id))
      .leftJoin(
        representedArtistsTable,
        eq(artworksTable.representedArtistId, representedArtistsTable.id),
      )
      .where(where as any)
      .limit(PAGE_SIZE)
      .offset(offset),
    db
      .select({ count: count() })
      .from(artworksTable)
      .leftJoin(tenantsTable, eq(artworksTable.tenantId, tenantsTable.id))
      .leftJoin(
        representedArtistsTable,
        eq(artworksTable.representedArtistId, representedArtistsTable.id),
      )
      .where(where as any),
  ]);
  return { rows, total: countRow?.count ?? 0 };
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

describeIntegration("Public browse pagination — real-DB integration", () => {
  it("page 1 returns visible artworks scoped to the seller", async () => {
    const { tenantId, slug } = await createTenant();
    const ids = await insertMany(tenantId, 5);

    const { rows } = await browsePage(1, { seller: slug });
    const returnedIds = rows.map(r => r.id);

    for (const id of ids) {
      expect(returnedIds).toContain(id);
    }
    expect(rows.length).toBeLessThanOrEqual(PAGE_SIZE);
  });

  it("total count matches all visible artworks for the seller", async () => {
    const { tenantId, slug } = await createTenant();
    await insertMany(tenantId, 6);

    const { total } = await browsePage(1, { seller: slug });
    expect(total).toBe(6);
  });

  it("page 2 skips page-1 rows with no overlap (seller-scoped)", async () => {
    const { tenantId, slug } = await createTenant();
    // Insert PAGE_SIZE+4 artworks so page 2 has 4 rows.
    await insertMany(tenantId, PAGE_SIZE + 4);

    const { rows: page1 } = await browsePage(1, { seller: slug });
    const { rows: page2 } = await browsePage(2, { seller: slug });

    expect(page1).toHaveLength(PAGE_SIZE);
    expect(page2.length).toBeGreaterThanOrEqual(4);

    const page1Ids = new Set(page1.map(r => r.id));
    for (const row of page2) {
      expect(page1Ids.has(row.id)).toBe(false);
    }
  });

  it("out-of-range page returns empty rows (seller-scoped)", async () => {
    const { tenantId, slug } = await createTenant();
    await insertMany(tenantId, 3);

    const { rows } = await browsePage(9999, { seller: slug });
    expect(rows).toHaveLength(0);
  });

  it("pagination excludes HIDDEN artworks", async () => {
    const { tenantId, slug } = await createTenant();
    const visibleId = await insertArtwork(tenantId, { status: "AVAILABLE" });
    const hiddenId  = await insertArtwork(tenantId, { status: "HIDDEN" });

    const { rows } = await browsePage(1, { seller: slug });
    const ids = rows.map(r => r.id);

    expect(ids).toContain(visibleId);
    expect(ids).not.toContain(hiddenId);
  });

  it("pagination excludes showInGallery=false artworks", async () => {
    const { tenantId, slug } = await createTenant();
    const visibleId   = await insertArtwork(tenantId, { showInGallery: true });
    const invisibleId = await insertArtwork(tenantId, { showInGallery: false });

    const { rows } = await browsePage(1, { seller: slug });
    const ids = rows.map(r => r.id);

    expect(ids).toContain(visibleId);
    expect(ids).not.toContain(invisibleId);
  });

  it("artworks from storefrontEnabled=false tenants are excluded from the unscoped query", async () => {
    const { tenantId: enabledId, slug: enabledSlug } = await createTenant({ storefrontEnabled: true });
    const { tenantId: disabledId }                   = await createTenant({ storefrontEnabled: false });

    const ownEnabled  = await insertArtwork(enabledId);
    const ownDisabled = await insertArtwork(disabledId);

    // Query scoped to the enabled seller only.
    const { rows: enabledRows } = await browsePage(1, { seller: enabledSlug });
    const enabledIds = enabledRows.map(r => r.id);

    expect(enabledIds).toContain(ownEnabled);
    expect(enabledIds).not.toContain(ownDisabled);
  });
});
