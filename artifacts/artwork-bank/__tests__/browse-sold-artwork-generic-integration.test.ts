/**
 * Browse — SOLD/RESERVED artworks visible on generic gallery path — real-DB integration.
 *
 * lib/browse-where.ts:26-40:
 *   BROWSE_VISIBLE_STATUSES = ["AVAILABLE", "SOLD", "RESERVED"]
 *   showInGallery=true AND status IN (AVAILABLE, SOLD, RESERVED)
 *   HIDDEN artworks are excluded.
 *
 * This tests the generic tenant browse (no artist= filter), which differs from
 * the represented-artist browse path already covered in browse-artist-filter.
 *
 *  1. SOLD artwork with showInGallery=true → appears in browse results.
 *  2. RESERVED artwork with showInGallery=true → appears in browse results.
 *  3. HIDDEN artwork → excluded from browse (regardless of showInGallery).
 *  4. AVAILABLE artwork with showInGallery=false → excluded from browse.
 *  5. All three visible statuses in one query → all three returned.
 *  6. Another tenant's SOLD artwork → not in this tenant's browse results.
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db, tenantsTable, artworksTable, representedArtistsTable,
} from "@workspace/db";
import { eq, inArray, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];

function uid() { return `${randomUUID()}-bsagi-${RUN}-${++seq}`; }

const BROWSE_VISIBLE_STATUSES = ["AVAILABLE", "SOLD", "RESERVED"] as const;

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Browse Sold Test", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(
  tenantId: string,
  opts: { status?: string; showInGallery?: boolean } = {},
) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: `Art ${id}`, sku: `sku-${id}`,
    status: opts.status ?? "AVAILABLE",
    showInGallery: opts.showInGallery ?? true,
    price: 10000,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

// Mirrors the core browse WHERE clause from lib/browse-where.ts.
async function browseArtworks(tenantId: string) {
  return db
    .select({ id: artworksTable.id, status: artworksTable.status })
    .from(artworksTable)
    .leftJoin(representedArtistsTable, eq(representedArtistsTable.id, artworksTable.representedArtistId))
    .where(and(
      eq(artworksTable.tenantId, tenantId),
      eq(artworksTable.showInGallery, true),
      inArray(artworksTable.status, [...BROWSE_VISIBLE_STATUSES] as any[]),
    ));
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

describeIntegration("Browse — SOLD/RESERVED visible on generic gallery — real-DB integration", () => {
  it("SOLD artwork with showInGallery=true → appears in browse results", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId, { status: "SOLD" });

    const rows = await browseArtworks(tenantId);

    expect(rows.map(r => r.id)).toContain(artworkId);
  });

  it("RESERVED artwork with showInGallery=true → appears in browse results", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId, { status: "RESERVED" });

    const rows = await browseArtworks(tenantId);

    expect(rows.map(r => r.id)).toContain(artworkId);
  });

  it("HIDDEN artwork → excluded from browse (regardless of showInGallery)", async () => {
    const tenantId  = await createTenant();
    const hiddenId  = await createArtwork(tenantId, { status: "HIDDEN", showInGallery: true });

    const rows = await browseArtworks(tenantId);

    expect(rows.map(r => r.id)).not.toContain(hiddenId);
  });

  it("AVAILABLE artwork with showInGallery=false → excluded from browse", async () => {
    const tenantId   = await createTenant();
    const privateId  = await createArtwork(tenantId, { status: "AVAILABLE", showInGallery: false });

    const rows = await browseArtworks(tenantId);

    expect(rows.map(r => r.id)).not.toContain(privateId);
  });

  it("all three visible statuses → all three returned in one query", async () => {
    const tenantId    = await createTenant();
    const availableId = await createArtwork(tenantId, { status: "AVAILABLE" });
    const soldId      = await createArtwork(tenantId, { status: "SOLD" });
    const reservedId  = await createArtwork(tenantId, { status: "RESERVED" });

    const rows   = await browseArtworks(tenantId);
    const rowIds = rows.map(r => r.id);

    expect(rowIds).toContain(availableId);
    expect(rowIds).toContain(soldId);
    expect(rowIds).toContain(reservedId);
  });

  it("another tenant's SOLD artwork → not in this tenant's browse results", async () => {
    const tenantA   = await createTenant();
    const tenantB   = await createTenant();
    const bArtwork  = await createArtwork(tenantB, { status: "SOLD" });

    const rows = await browseArtworks(tenantA);

    expect(rows.map(r => r.id)).not.toContain(bArtwork);
  });
});
