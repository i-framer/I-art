/**
 * Platform admin — artwork count aggregation per gallery — real-DB integration.
 *
 * The platform admin tenant list may include an artwork count per gallery.
 * This tests the aggregation query correctness using real DB rows.
 *
 *  1. Tenant with no artworks shows count = 0.
 *  2. Tenant with 3 artworks shows count = 3.
 *  3. Artwork count is scoped per tenant (cross-tenant artworks don't pollute).
 *  4. HIDDEN artworks are included in the count (admin visibility).
 *  5. Artwork count updates correctly after a new artwork is added.
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable } from "@workspace/db";
import { count, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];

function uid() { return `${randomUUID()}-paaci-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Artwork Count Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id };
}

async function createArtwork(tenantId: string, status = "AVAILABLE") {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Count Art", sku: `sku-${id}`, status,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

/** Mirrors what a platform-admin artwork count query would do. */
async function artworkCountForTenant(tenantId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(artworksTable)
    .where(eq(artworksTable.tenantId, tenantId));
  return row?.value ?? 0;
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

describeIntegration("Platform admin artwork count aggregation — real-DB integration", () => {
  it("tenant with no artworks shows count = 0", async () => {
    const { tenantId } = await createTenant();
    expect(await artworkCountForTenant(tenantId)).toBe(0);
  });

  it("tenant with 3 artworks shows count = 3", async () => {
    const { tenantId } = await createTenant();
    await createArtwork(tenantId);
    await createArtwork(tenantId);
    await createArtwork(tenantId);

    expect(await artworkCountForTenant(tenantId)).toBe(3);
  });

  it("artwork count is scoped per tenant — cross-tenant artworks don't pollute", async () => {
    const { tenantId: ownId }     = await createTenant();
    const { tenantId: foreignId } = await createTenant();
    await createArtwork(ownId);
    await createArtwork(foreignId);
    await createArtwork(foreignId);

    expect(await artworkCountForTenant(ownId)).toBe(1);
    expect(await artworkCountForTenant(foreignId)).toBe(2);
  });

  it("HIDDEN artworks are included in the count (admin visibility)", async () => {
    const { tenantId } = await createTenant();
    await createArtwork(tenantId, "AVAILABLE");
    await createArtwork(tenantId, "HIDDEN");

    expect(await artworkCountForTenant(tenantId)).toBe(2);
  });

  it("artwork count updates correctly after a new artwork is added", async () => {
    const { tenantId } = await createTenant();
    expect(await artworkCountForTenant(tenantId)).toBe(0);

    await createArtwork(tenantId);
    expect(await artworkCountForTenant(tenantId)).toBe(1);

    await createArtwork(tenantId);
    expect(await artworkCountForTenant(tenantId)).toBe(2);
  });
});
