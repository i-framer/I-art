/**
 * Artwork edition fields — persistence — real-DB integration.
 *
 * The artworksTable has three edition-related columns:
 *   isEdition   BOOLEAN NOT NULL DEFAULT false
 *   editionNumber INTEGER nullable
 *   totalEditions INTEGER nullable
 *
 * This suite verifies insert/update/null semantics against real PostgreSQL:
 *
 *  1. isEdition defaults to false when not supplied.
 *  2. isEdition true + editionNumber + totalEditions are persisted correctly.
 *  3. Null editionNumber and totalEditions are stored and returned as null.
 *  4. Edition fields can be updated to new values.
 *  5. Edition fields can be cleared (set to null/false).
 *  6. isEdition=true with null edition number (open edition) is valid.
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

function uid() { return `${randomUUID()}-aef-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Edition Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function insertArtwork(tenantId: string, opts: {
  isEdition?: boolean;
  editionNumber?: number | null;
  totalEditions?: number | null;
} = {}) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId,
    title: "Edition Test Artwork",
    sku: `sku-${id}`,
    status: "AVAILABLE",
    isEdition: opts.isEdition ?? false,
    editionNumber: opts.editionNumber ?? null,
    totalEditions: opts.totalEditions ?? null,
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

describeIntegration("Artwork edition fields — persistence — real-DB integration", () => {
  it("isEdition defaults to false when not explicitly set", async () => {
    const tenantId = await createTenant();
    const id = await insertArtwork(tenantId);

    const row = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, id) });
    expect(row?.isEdition).toBe(false);
    expect(row?.editionNumber).toBeNull();
    expect(row?.totalEditions).toBeNull();
  });

  it("isEdition=true with editionNumber and totalEditions are persisted correctly", async () => {
    const tenantId = await createTenant();
    const id = await insertArtwork(tenantId, {
      isEdition: true,
      editionNumber: 3,
      totalEditions: 10,
    });

    const row = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, id) });
    expect(row?.isEdition).toBe(true);
    expect(row?.editionNumber).toBe(3);
    expect(row?.totalEditions).toBe(10);
  });

  it("null editionNumber and totalEditions are stored and returned as null", async () => {
    const tenantId = await createTenant();
    const id = await insertArtwork(tenantId, {
      isEdition: true,
      editionNumber: null,
      totalEditions: null,
    });

    const row = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, id) });
    expect(row?.isEdition).toBe(true);
    expect(row?.editionNumber).toBeNull();
    expect(row?.totalEditions).toBeNull();
  });

  it("edition fields can be updated to new values", async () => {
    const tenantId = await createTenant();
    const id = await insertArtwork(tenantId, {
      isEdition: true,
      editionNumber: 1,
      totalEditions: 5,
    });

    await db.update(artworksTable)
      .set({ editionNumber: 2, totalEditions: 20 })
      .where(eq(artworksTable.id, id));

    const row = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, id) });
    expect(row?.editionNumber).toBe(2);
    expect(row?.totalEditions).toBe(20);
  });

  it("edition fields can be cleared (isEdition false, nulls)", async () => {
    const tenantId = await createTenant();
    const id = await insertArtwork(tenantId, {
      isEdition: true,
      editionNumber: 4,
      totalEditions: 8,
    });

    await db.update(artworksTable)
      .set({ isEdition: false, editionNumber: null, totalEditions: null })
      .where(eq(artworksTable.id, id));

    const row = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, id) });
    expect(row?.isEdition).toBe(false);
    expect(row?.editionNumber).toBeNull();
    expect(row?.totalEditions).toBeNull();
  });

  it("isEdition=true with null edition number (open edition) is valid", async () => {
    const tenantId = await createTenant();
    const id = await insertArtwork(tenantId, {
      isEdition: true,
      editionNumber: null,  // open edition — no specific number
      totalEditions: null,
    });

    const row = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, id) });
    expect(row?.isEdition).toBe(true);
    expect(row?.editionNumber).toBeNull();
    expect(row?.totalEditions).toBeNull();
  });
});
