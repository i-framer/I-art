/**
 * Browse gallery — multiple showInGallery=true artworks returned — real-DB integration.
 *
 * The gallery browse query returns all showInGallery=true artworks for a tenant
 * (excluding HIDDEN status). This tests that multiple matching artworks are all
 * returned in the same query, not just the first one.
 *
 *  1. All showInGallery=true artworks are included in browse results.
 *  2. showInGallery=false artworks are excluded even if status=AVAILABLE.
 *  3. HIDDEN artworks are excluded even if showInGallery=true.
 *  4. Browse results are scoped to the tenant (foreign artworks excluded).
 *  5. Result count matches exactly — no extras from other tenants.
 *  6. Artwork returned includes expected title fields.
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];

function uid() { return `${randomUUID()}-bmagi-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Multi Artwork Browse Test", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id, slug: id };
}

async function createArtwork(tenantId: string, opts: {
  title?: string;
  status?: string;
  showInGallery?: boolean;
  price?: number;
} = {}) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: opts.title ?? `Gallery Art ${seq}`, sku: `sku-${id}`,
    status: opts.status ?? "AVAILABLE",
    showInGallery: opts.showInGallery ?? true,
    price: opts.price ?? 10000,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

/** Mirrors the public gallery browse query: showInGallery=true, status != HIDDEN, scoped to tenant. */
async function browseGallery(tenantId: string) {
  return db.query.artworksTable.findMany({
    where: and(
      eq(artworksTable.tenantId, tenantId),
      eq(artworksTable.showInGallery, true),
    ),
  }).then(rows => rows.filter(r => r.status !== "HIDDEN"));
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

describeIntegration("Browse gallery — multiple artworks — real-DB integration", () => {
  it("all showInGallery=true artworks are included in browse results", async () => {
    const { tenantId } = await createTenant();
    const id1 = await createArtwork(tenantId, { title: "First Art",  showInGallery: true });
    const id2 = await createArtwork(tenantId, { title: "Second Art", showInGallery: true });
    const id3 = await createArtwork(tenantId, { title: "Third Art",  showInGallery: true });

    const results = await browseGallery(tenantId);
    const ids = results.map(r => r.id);

    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
    expect(ids).toContain(id3);
  });

  it("showInGallery=false artworks are excluded even if status=AVAILABLE", async () => {
    const { tenantId } = await createTenant();
    const visibleId  = await createArtwork(tenantId, { showInGallery: true,  status: "AVAILABLE" });
    const hiddenId   = await createArtwork(tenantId, { showInGallery: false, status: "AVAILABLE" });

    const results = await browseGallery(tenantId);
    const ids = results.map(r => r.id);

    expect(ids).toContain(visibleId);
    expect(ids).not.toContain(hiddenId);
  });

  it("HIDDEN artworks are excluded even if showInGallery=true", async () => {
    const { tenantId } = await createTenant();
    const visibleId = await createArtwork(tenantId, { showInGallery: true, status: "AVAILABLE" });
    const hiddenId  = await createArtwork(tenantId, { showInGallery: true, status: "HIDDEN"    });

    const results = await browseGallery(tenantId);
    const ids = results.map(r => r.id);

    expect(ids).toContain(visibleId);
    expect(ids).not.toContain(hiddenId);
  });

  it("browse results are scoped to the tenant — foreign artworks excluded", async () => {
    const { tenantId: ownId }     = await createTenant();
    const { tenantId: foreignId } = await createTenant();
    const ownArtwork     = await createArtwork(ownId,     { showInGallery: true });
    const foreignArtwork = await createArtwork(foreignId, { showInGallery: true });

    const results = await browseGallery(ownId);
    const ids = results.map(r => r.id);

    expect(ids).toContain(ownArtwork);
    expect(ids).not.toContain(foreignArtwork);
  });

  it("result count matches exactly — no extras from other tenants", async () => {
    const { tenantId: ownId }     = await createTenant();
    const { tenantId: foreignId } = await createTenant();
    await createArtwork(ownId,     { showInGallery: true });
    await createArtwork(ownId,     { showInGallery: true });
    await createArtwork(foreignId, { showInGallery: true });

    const results = await browseGallery(ownId);

    expect(results).toHaveLength(2);
  });

  it("artwork returned includes expected title and price fields", async () => {
    const { tenantId } = await createTenant();
    await createArtwork(tenantId, { title: "Titled Art", price: 55000, showInGallery: true });

    const results = await browseGallery(tenantId);
    const art = results.find(r => r.title === "Titled Art");

    expect(art).not.toBeUndefined();
    expect(art?.price).toBe(55000);
  });
});
