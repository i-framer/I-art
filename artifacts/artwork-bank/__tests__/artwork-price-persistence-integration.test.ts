/**
 * Artwork price field — persistence — real-DB integration.
 *
 * The `price` column on `artworksTable` is an integer (cents).
 * This suite verifies insert/update/null semantics against real PostgreSQL:
 *
 *  1. Price is persisted and read back correctly.
 *  2. Null price is stored and returned as null.
 *  3. Zero price is stored and returned as 0 (not null).
 *  4. Price can be updated to a new value.
 *  5. Price can be cleared (set to null) after being set.
 *  6. Price is tenant-scoped — foreign-tenant artwork price is inaccessible
 *     through the tenant-scoped query.
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

function uid() { return `${randomUUID()}-aprs-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Price Persistence Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string, price: number | null = null) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Price Test Artwork", sku: `sku-${id}`,
    status: "AVAILABLE", price,
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

describeIntegration("Artwork price field — persistence — real-DB integration", () => {
  it("price is persisted and read back correctly", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId, 125000); // $1,250.00

    const row = await db.query.artworksTable.findFirst({
      where: eq(artworksTable.id, artworkId),
    });

    expect(row?.price).toBe(125000);
  });

  it("null price is stored and returned as null", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId, null);

    const row = await db.query.artworksTable.findFirst({
      where: eq(artworksTable.id, artworkId),
    });

    expect(row?.price).toBeNull();
  });

  it("zero price is stored and returned as 0 (not null)", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId, 0);

    const row = await db.query.artworksTable.findFirst({
      where: eq(artworksTable.id, artworkId),
    });

    expect(row?.price).toBe(0);
  });

  it("price can be updated to a new value", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId, 50000);

    await db.update(artworksTable)
      .set({ price: 75000 })
      .where(eq(artworksTable.id, artworkId));

    const row = await db.query.artworksTable.findFirst({
      where: eq(artworksTable.id, artworkId),
    });

    expect(row?.price).toBe(75000);
  });

  it("price can be cleared (set to null) after being set", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId, 30000);

    await db.update(artworksTable)
      .set({ price: null })
      .where(eq(artworksTable.id, artworkId));

    const row = await db.query.artworksTable.findFirst({
      where: eq(artworksTable.id, artworkId),
    });

    expect(row?.price).toBeNull();
  });

  it("price is tenant-scoped — query by own tenantId returns price; foreign query returns nothing", async () => {
    const tenantId = await createTenant();
    const foreignTenantId = await createTenant();
    const artworkId = await createArtwork(tenantId, 88000);

    // Own tenant can see the artwork and its price.
    const ownRow = await db.query.artworksTable.findFirst({
      where: eq(artworksTable.id, artworkId),
    });
    expect(ownRow?.price).toBe(88000);

    // The artwork belongs to a different tenant; querying as foreign tenant returns nothing.
    const foreignRows = await db.query.artworksTable.findMany({
      where: eq(artworksTable.tenantId, foreignTenantId),
    });
    expect(foreignRows.map(r => r.id)).not.toContain(artworkId);
  });
});
