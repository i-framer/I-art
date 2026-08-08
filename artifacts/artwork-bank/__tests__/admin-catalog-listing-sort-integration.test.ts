/**
 * Admin catalog listing sort order — real-DB integration.
 *
 * The admin catalog page (app/(admin)/(gated)/catalog/page.tsx:107) queries
 * artworks with `.orderBy(desc(artworksTable.createdAt))`.
 * This suite verifies:
 *
 *  1. Artworks are returned newest-first (createdAt DESC).
 *  2. A search query (title/SKU ilike) filters results correctly.
 *  3. Hidden artworks (status=HIDDEN) are still returned in admin listing.
 *  4. Foreign-tenant artworks are excluded.
 *  5. The listing returns all visible statuses for the own tenant.
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable } from "@workspace/db";
import { and, desc, eq, ilike, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];

function uid() { return `${randomUUID()}-acls-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Catalog Listing Sort Test", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function insertArtwork(tenantId: string, opts: {
  title?: string;
  sku?: string;
  status?: "AVAILABLE" | "SOLD" | "RESERVED" | "HIDDEN";
  createdAt?: Date;
} = {}) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId,
    title: opts.title ?? "Catalog Test Artwork",
    sku: opts.sku ?? `sku-${id}`,
    status: opts.status ?? "AVAILABLE",
    createdAt: opts.createdAt,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

/** Mirror the admin catalog page query. */
async function adminCatalog(tenantId: string, q?: string) {
  const conditions: ReturnType<typeof eq>[] = [eq(artworksTable.tenantId, tenantId)];
  if (q) {
    conditions.push(or(
      ilike(artworksTable.title, `%${q}%`),
      ilike(artworksTable.sku, `%${q}%`),
    )!);
  }
  return db.query.artworksTable.findMany({
    where: and(...conditions),
    orderBy: [desc(artworksTable.createdAt)],
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

describeIntegration("Admin catalog listing sort order — real-DB integration", () => {
  it("artworks are returned newest-first (createdAt DESC)", async () => {
    const tenantId = await createTenant();
    const oldTime = new Date("2024-01-01T00:00:00Z");
    const midTime = new Date("2024-06-01T00:00:00Z");
    const newTime = new Date("2024-12-01T00:00:00Z");

    const oldId = await insertArtwork(tenantId, { title: "Old Artwork", createdAt: oldTime });
    const midId = await insertArtwork(tenantId, { title: "Mid Artwork", createdAt: midTime });
    const newId = await insertArtwork(tenantId, { title: "New Artwork", createdAt: newTime });

    const rows = await adminCatalog(tenantId);
    const ids = rows.map(r => r.id);

    const oldIdx = ids.indexOf(oldId);
    const midIdx = ids.indexOf(midId);
    const newIdx = ids.indexOf(newId);

    // Newest first: newId < midId < oldId in index position.
    expect(newIdx).toBeLessThan(midIdx);
    expect(midIdx).toBeLessThan(oldIdx);
  });

  it("search query filters by title (ilike)", async () => {
    const tenantId = await createTenant();
    const matchId = await insertArtwork(tenantId, { title: "Coastal Sunrise" });
    const noMatchId = await insertArtwork(tenantId, { title: "Abstract Blue" });

    const rows = await adminCatalog(tenantId, "coastal");
    const ids = rows.map(r => r.id);

    expect(ids).toContain(matchId);
    expect(ids).not.toContain(noMatchId);
  });

  it("search query filters by SKU (ilike)", async () => {
    const tenantId = await createTenant();
    const matchId = await insertArtwork(tenantId, { sku: `CS-001-${uid()}` });
    const noMatchId = await insertArtwork(tenantId, { sku: `AB-002-${uid()}` });

    // Search for the CS prefix portion.
    const rows = await adminCatalog(tenantId, "CS-001");
    const ids = rows.map(r => r.id);

    expect(ids).toContain(matchId);
    expect(ids).not.toContain(noMatchId);
  });

  it("hidden artworks (status=HIDDEN) are included in the admin catalog listing", async () => {
    const tenantId = await createTenant();
    const hiddenId    = await insertArtwork(tenantId, { status: "HIDDEN" });
    const availableId = await insertArtwork(tenantId, { status: "AVAILABLE" });

    const rows = await adminCatalog(tenantId);
    const ids = rows.map(r => r.id);

    expect(ids).toContain(hiddenId);
    expect(ids).toContain(availableId);
  });

  it("foreign-tenant artworks are excluded from the listing", async () => {
    const ownTenantId     = await createTenant();
    const foreignTenantId = await createTenant();
    const ownId           = await insertArtwork(ownTenantId);
    const foreignId       = await insertArtwork(foreignTenantId);

    const rows = await adminCatalog(ownTenantId);
    const ids = rows.map(r => r.id);

    expect(ids).toContain(ownId);
    expect(ids).not.toContain(foreignId);
  });
});
