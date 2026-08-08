/**
 * Artwork condition persistence + per-tenant SKU uniqueness — real-DB integration.
 *
 * Two closely related DB constraints:
 *
 * CONDITION (nullable enum: EXCELLENT/GOOD/FAIR/POOR):
 *  1. Condition EXCELLENT is persisted and read back.
 *  2. Condition FAIR is persisted and read back.
 *  3. Null condition is stored and returned as null.
 *  4. Condition can be changed and cleared.
 *
 * SKU uniqueness (uniqueIndex on tenantId+sku):
 *  5. Duplicate SKU within the same tenant throws.
 *  6. Same SKU in a different tenant succeeds (cross-tenant isolation).
 *  7. Updating to a taken SKU within the same tenant throws.
 *  8. Updating to a free SKU within the same tenant succeeds.
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

function uid() { return `${randomUUID()}-acsu-${RUN}-${++seq}`; }
function makeSkuFor(suffix: string) { return `sku-${suffix}-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Condition SKU Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function insertArtwork(tenantId: string, sku: string, condition: string | null = null) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Test Artwork", sku, status: "AVAILABLE", condition,
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

describeIntegration("Artwork condition persistence — real-DB integration", () => {
  it("condition EXCELLENT is persisted and read back correctly", async () => {
    const tenantId = await createTenant();
    const id = await insertArtwork(tenantId, makeSkuFor("exc"), "EXCELLENT");

    const row = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, id) });
    expect(row?.condition).toBe("EXCELLENT");
  });

  it("condition FAIR is persisted and read back correctly", async () => {
    const tenantId = await createTenant();
    const id = await insertArtwork(tenantId, makeSkuFor("fair"), "FAIR");

    const row = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, id) });
    expect(row?.condition).toBe("FAIR");
  });

  it("null condition is stored and returned as null", async () => {
    const tenantId = await createTenant();
    const id = await insertArtwork(tenantId, makeSkuFor("null-cond"), null);

    const row = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, id) });
    expect(row?.condition).toBeNull();
  });

  it("condition can be updated and then cleared to null", async () => {
    const tenantId = await createTenant();
    const id = await insertArtwork(tenantId, makeSkuFor("upd-cond"), "GOOD");

    // Update to POOR.
    await db.update(artworksTable).set({ condition: "POOR" }).where(eq(artworksTable.id, id));
    const updated = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, id) });
    expect(updated?.condition).toBe("POOR");

    // Clear to null.
    await db.update(artworksTable).set({ condition: null }).where(eq(artworksTable.id, id));
    const cleared = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, id) });
    expect(cleared?.condition).toBeNull();
  });
});

describeIntegration("Per-tenant artwork SKU uniqueness — real-DB integration", () => {
  it("duplicate SKU within the same tenant throws a unique-constraint violation", async () => {
    const tenantId = await createTenant();
    const sku = makeSkuFor("dup");
    await insertArtwork(tenantId, sku);

    await expect(insertArtwork(tenantId, sku)).rejects.toThrow();
  });

  it("same SKU in a different tenant succeeds (cross-tenant isolation)", async () => {
    const tenant1 = await createTenant();
    const tenant2 = await createTenant();
    const sku = makeSkuFor("cross");

    await insertArtwork(tenant1, sku);
    const id2 = await insertArtwork(tenant2, sku); // must not throw

    const row = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, id2) });
    expect(row?.sku).toBe(sku);
  });

  it("updating to a taken SKU within the same tenant throws", async () => {
    const tenantId = await createTenant();
    const sku1 = makeSkuFor("taken");
    const sku2 = makeSkuFor("free");
    await insertArtwork(tenantId, sku1);
    const id2 = await insertArtwork(tenantId, sku2);

    await expect(
      db.update(artworksTable).set({ sku: sku1 }).where(eq(artworksTable.id, id2)),
    ).rejects.toThrow();
  });

  it("updating to a free SKU within the same tenant succeeds", async () => {
    const tenantId = await createTenant();
    const oldSku = makeSkuFor("old");
    const newSku = makeSkuFor("new");
    const id = await insertArtwork(tenantId, oldSku);

    await db.update(artworksTable).set({ sku: newSku }).where(eq(artworksTable.id, id));

    const row = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, id) });
    expect(row?.sku).toBe(newSku);
  });
});
