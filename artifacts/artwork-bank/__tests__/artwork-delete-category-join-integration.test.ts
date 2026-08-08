/**
 * deleteArtwork — category join row cleanup — real-DB integration.
 *
 * app/(admin)/(gated)/catalog/actions.ts:204-225 (deleteArtwork):
 *   Deletes the artwork row; comment says category rows cascade.
 *   This suite verifies DB-level cascade actually removes the join rows.
 *
 *  1. Delete artwork with one category → artworkCategoryOnArtworkTable row removed.
 *  2. Delete artwork with multiple categories → all join rows removed.
 *  3. Delete artwork with no categories → no-op on join table (0 join rows remain).
 *  4. Deleting artwork A leaves artwork B's category join rows intact.
 *  5. Category record itself is NOT deleted (only the join row is removed).
 *  6. Artwork row itself is gone after deletion.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db, tenantsTable, artworksTable, artworkCategoryOnArtworkTable, artworkCategoriesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdCategoryIds: string[] = [];

function uid() { return `${randomUUID()}-adcji-${RUN}-${++seq}`; }

const mockSession = { value: { userId: "u-del-cat", tenantId: "PLACEHOLDER", role: "owner" } };

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => mockSession.value),
}));
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
  hasActiveAccess: () => true,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

import { deleteArtwork } from "@/app/(admin)/(gated)/catalog/actions";

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Delete Category Test", type: "ARTIST",
  } as any);
  mockSession.value = { userId: `u-${id}`, tenantId: id, role: "owner" };
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Delete Cat Art", sku: `sku-${id}`,
    status: "AVAILABLE", price: 10000, showInGallery: true,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createCategory(tenantId: string) {
  const id = uid();
  await db.insert(artworkCategoriesTable).values({
    id, tenantId, name: `Cat ${id}`,
  } as any);
  createdCategoryIds.push(id);
  return id;
}

async function addCategory(artworkId: string, categoryId: string) {
  await db.insert(artworkCategoryOnArtworkTable).values({ artworkId, categoryId } as any);
}

async function joinRowCount(artworkId: string) {
  const rows = await db.select()
    .from(artworkCategoryOnArtworkTable)
    .where(eq(artworkCategoryOnArtworkTable.artworkId, artworkId));
  return rows.length;
}

async function cleanup() {
  // Join rows should be cascade-deleted with artwork; clean up any stragglers.
  for (const id of createdArtworkIds.splice(0)) {
    await db.delete(artworkCategoryOnArtworkTable)
      .where(eq(artworkCategoryOnArtworkTable.artworkId, id)).catch(() => {});
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdCategoryIds.splice(0)) {
    await db.delete(artworkCategoriesTable).where(eq(artworkCategoriesTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("deleteArtwork — category join row cleanup — real-DB integration", () => {
  it("delete artwork with one category → join row removed", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const catId     = await createCategory(tenantId);
    await addCategory(artworkId, catId);

    expect(await joinRowCount(artworkId)).toBe(1);
    await deleteArtwork(artworkId);
    expect(await joinRowCount(artworkId)).toBe(0);
  });

  it("delete artwork with multiple categories → all join rows removed", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const cat1      = await createCategory(tenantId);
    const cat2      = await createCategory(tenantId);
    const cat3      = await createCategory(tenantId);
    await addCategory(artworkId, cat1);
    await addCategory(artworkId, cat2);
    await addCategory(artworkId, cat3);

    expect(await joinRowCount(artworkId)).toBe(3);
    await deleteArtwork(artworkId);
    expect(await joinRowCount(artworkId)).toBe(0);
  });

  it("delete artwork with no categories → 0 join rows, no error", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);

    await deleteArtwork(artworkId);
    expect(await joinRowCount(artworkId)).toBe(0);
  });

  it("deleting artwork A leaves artwork B's category join rows intact", async () => {
    const tenantId  = await createTenant();
    const artworkA  = await createArtwork(tenantId);
    const artworkB  = await createArtwork(tenantId);
    const catId     = await createCategory(tenantId);
    await addCategory(artworkA, catId);
    await addCategory(artworkB, catId);

    await deleteArtwork(artworkA);

    expect(await joinRowCount(artworkA)).toBe(0);
    expect(await joinRowCount(artworkB)).toBe(1); // B's join row untouched
  });

  it("category record itself is NOT deleted when artwork is removed", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const catId     = await createCategory(tenantId);
    await addCategory(artworkId, catId);

    await deleteArtwork(artworkId);

    const cat = await db.query.artworkCategoriesTable.findFirst({ where: eq(artworkCategoriesTable.id, catId) });
    expect(cat).not.toBeUndefined(); // category still exists
  });

  it("artwork row itself is gone after deletion", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);

    await deleteArtwork(artworkId);

    const row = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, artworkId) });
    expect(row).toBeUndefined();
  });
});
