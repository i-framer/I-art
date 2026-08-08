/**
 * Artwork SKU tenant-scoped uniqueness — real-DB integration.
 *
 * lib/db/src/schema/artwork.ts: unique index artwork_sku_tenant_idx (tenantId, sku).
 * Duplicate SKU within the same tenant must be rejected.
 * Same SKU in different tenants must be allowed.
 *
 *  1. Inserting two artworks with the same SKU in the same tenant throws.
 *  2. Same SKU in different tenants is allowed (no conflict).
 *  3. After an SKU conflict, the second artwork row does NOT exist.
 *  4. First artwork with the SKU is unchanged after a failed duplicate insert.
 *  5. Updating an artwork's SKU to an already-used SKU in the same tenant throws.
 *  6. Updating an artwork's SKU to match a SKU from a different tenant succeeds.
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

function uid() { return `${randomUUID()}-asui-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "SKU Unique Test", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function insertArtwork(tenantId: string, sku: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: `SKU Art ${seq}`, sku, status: "AVAILABLE",
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function artworkBySku(tenantId: string, sku: string) {
  return db.query.artworksTable.findFirst({
    where: and(eq(artworksTable.tenantId, tenantId), eq(artworksTable.sku, sku)),
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

describeIntegration("Artwork SKU tenant-scoped uniqueness — real-DB integration", () => {
  it("inserting two artworks with the same SKU in the same tenant throws", async () => {
    const tenantId = await createTenant();
    const sku = `sku-dup-${uid()}`;
    await insertArtwork(tenantId, sku);

    await expect(insertArtwork(tenantId, sku)).rejects.toThrow();
    // Remove the id we pushed since the insert failed.
    createdArtworkIds.pop();
  });

  it("same SKU in different tenants is allowed (no conflict)", async () => {
    const tenant1 = await createTenant();
    const tenant2 = await createTenant();
    const sharedSku = `sku-shared-${uid()}`;

    await expect(insertArtwork(tenant1, sharedSku)).resolves.toBeDefined();
    await expect(insertArtwork(tenant2, sharedSku)).resolves.toBeDefined();
  });

  it("after an SKU conflict, the second artwork row does NOT exist", async () => {
    const tenantId = await createTenant();
    const sku = `sku-norow-${uid()}`;
    await insertArtwork(tenantId, sku);

    const dupId = uid();
    await db.insert(artworksTable).values({
      id: dupId, tenantId, title: "Dup SKU Art", sku, status: "AVAILABLE",
    } as any).catch(() => {});

    const rows = await db.query.artworksTable.findMany({
      where: and(eq(artworksTable.tenantId, tenantId), eq(artworksTable.sku, sku)),
    });
    expect(rows).toHaveLength(1);
  });

  it("first artwork with the SKU is unchanged after a failed duplicate insert", async () => {
    const tenantId = await createTenant();
    const sku = `sku-first-${uid()}`;
    const firstId = await insertArtwork(tenantId, sku);

    await db.insert(artworksTable).values({
      id: uid(), tenantId, title: "Duplicate", sku, status: "HIDDEN",
    } as any).catch(() => {});

    const first = await artworkBySku(tenantId, sku);
    expect(first?.id).toBe(firstId);
    expect(first?.title).not.toBe("Duplicate");
  });

  it("updating an artwork's SKU to an already-used SKU in the same tenant throws", async () => {
    const tenantId = await createTenant();
    const sku1 = `sku-orig-${uid()}`;
    const sku2 = `sku-taken-${uid()}`;
    await insertArtwork(tenantId, sku1);
    const id2 = await insertArtwork(tenantId, sku2);

    await expect(
      db.update(artworksTable).set({ sku: sku1 }).where(eq(artworksTable.id, id2)),
    ).rejects.toThrow();
  });

  it("updating an artwork's SKU to match a SKU from a different tenant succeeds", async () => {
    const tenant1 = await createTenant();
    const tenant2 = await createTenant();
    const sharedSku = `sku-cross-${uid()}`;
    const startSku  = `sku-start-${uid()}`;
    await insertArtwork(tenant1, sharedSku);
    const id2 = await insertArtwork(tenant2, startSku);

    await expect(
      db.update(artworksTable).set({ sku: sharedSku }).where(eq(artworksTable.id, id2)),
    ).resolves.toBeDefined();
  });
});
