/**
 * Artwork SKU uniqueness — real-DB integration.
 *
 * lib/db/src/schema/artwork.ts:68 defines:
 *   uniqueIndex("artwork_sku_tenant_idx").on(t.tenantId, t.sku)
 *
 * This means duplicate SKU within one tenant is rejected by the DB, but the
 * same SKU is allowed across different tenants.
 *
 *  1. Duplicate SKU within the same tenant is rejected (DB unique violation).
 *  2. Same SKU across different tenants is allowed.
 *  3. Updating artwork SKU to a unique value succeeds.
 *  4. Updating artwork SKU to a duplicate (same tenant) is rejected.
 *  5. SKU uniqueness is case-sensitive (upper/lower are distinct).
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];

function uid() { return `${randomUUID()}-skuq-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "SKU Uniqueness Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id };
}

async function insertArtwork(tenantId: string, sku: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "SKU Uniqueness Art", sku, status: "AVAILABLE",
  } as any);
  createdArtworkIds.push(id);
  return id;
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

describeIntegration("Artwork SKU uniqueness — real-DB integration", () => {
  it("duplicate SKU within the same tenant is rejected by the DB", async () => {
    const { tenantId } = await createTenant();
    await insertArtwork(tenantId, "ART-001");

    const dupId = uid();
    const error = await db.insert(artworksTable).values({
      id: dupId, tenantId, title: "Duplicate SKU Art", sku: "ART-001", status: "AVAILABLE",
    } as any).catch(e => e);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/unique|duplicate|violates/i);
  });

  it("same SKU across different tenants is allowed", async () => {
    const { tenantId: t1 } = await createTenant();
    const { tenantId: t2 } = await createTenant();

    const id1 = await insertArtwork(t1, "SHARED-SKU");
    const id2 = await insertArtwork(t2, "SHARED-SKU");

    const row1 = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, id1) });
    const row2 = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, id2) });

    expect(row1?.sku).toBe("SHARED-SKU");
    expect(row2?.sku).toBe("SHARED-SKU");
  });

  it("updating artwork SKU to a unique value succeeds", async () => {
    const { tenantId } = await createTenant();
    const id = await insertArtwork(tenantId, "ORIGINAL-SKU");

    await db.update(artworksTable).set({ sku: "NEW-UNIQUE-SKU" }).where(eq(artworksTable.id, id));

    const row = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, id) });
    expect(row?.sku).toBe("NEW-UNIQUE-SKU");
  });

  it("updating artwork SKU to a duplicate same-tenant SKU is rejected", async () => {
    const { tenantId } = await createTenant();
    const id1 = await insertArtwork(tenantId, "FIRST-SKU");
    const id2 = await insertArtwork(tenantId, "SECOND-SKU");

    const error = await db.update(artworksTable)
      .set({ sku: "FIRST-SKU" })
      .where(eq(artworksTable.id, id2))
      .catch(e => e);

    expect(error).toBeInstanceOf(Error);
    // Drizzle wraps the error; the original pg message or the wrapper text signals the failure.
    expect(String(error)).toMatch(/unique|duplicate|violates|Failed query/i);
  });

  it("SKU uniqueness is case-sensitive (ART-001 and art-001 are distinct)", async () => {
    const { tenantId } = await createTenant();
    const id1 = await insertArtwork(tenantId, "ART-CASE");
    const id2 = await insertArtwork(tenantId, "art-case"); // different case

    const row1 = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, id1) });
    const row2 = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, id2) });

    expect(row1?.sku).toBe("ART-CASE");
    expect(row2?.sku).toBe("art-case");
  });
});
