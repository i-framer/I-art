/**
 * Artwork creation with multiple categoryIds — real-DB integration.
 *
 * app/(admin)/(gated)/catalog/actions.ts:123-139:
 *   After artwork insert, validates categories belong to tenant, then inserts
 *   artworkCategoryOnArtworkTable rows for each valid category.
 *
 *  1. Create artwork with two categoryIds → both join rows inserted.
 *  2. Create artwork with no categoryIds → no join rows inserted.
 *  3. CategoryId from another tenant is rejected → not linked.
 *  4. Create artwork with one valid + one foreign categoryId → only valid one linked.
 *  5. Update artwork swaps categories (old removed, new added).
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db, tenantsTable, artworksTable,
  artworkCategoriesTable, artworkCategoryOnArtworkTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdCategoryIds: string[] = [];

function uid() { return `${randomUUID()}-acmci-${RUN}-${++seq}`; }

const mockSession: { value: { userId: string; tenantId: string; role: string } } = {
  value: { userId: "u-cat", tenantId: "PLACEHOLDER", role: "owner" },
};
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => mockSession.value),
}));
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

import { createArtwork, updateArtwork } from "@/app/(admin)/(gated)/catalog/actions";

function makeForm(fields: Record<string, string | string[]>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) { for (const item of v) fd.append(k, item); }
    else fd.set(k, v);
  }
  return fd;
}

const INITIAL_STATE = { error: "" };

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Category Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  mockSession.value = { userId: `u-${id}`, tenantId: id, role: "owner" };
  return id;
}

async function createCategory(tenantId: string) {
  const [row] = await db.insert(artworkCategoriesTable).values({
    tenantId, name: `Category ${uid()}`,
  } as any).returning({ id: artworkCategoriesTable.id });
  const id = row!.id;
  createdCategoryIds.push(id);
  return id;
}

async function linkedCategoryIds(artworkId: string) {
  const rows = await db.query.artworkCategoryOnArtworkTable.findMany({
    where: eq(artworkCategoryOnArtworkTable.artworkId, artworkId),
  });
  return rows.map(r => r.categoryId);
}

async function callCreate(formFields: Record<string, string | string[]>) {
  const form = makeForm({ title: `Cat Art ${uid()}`, sku: `sku-${uid()}`, price: "100", status: "AVAILABLE", ...formFields });
  let artworkId: string | undefined;
  try {
    await createArtwork(INITIAL_STATE, form);
  } catch (err: any) {
    // Extract artworkId from redirect URL "/catalog/{id}?created=1"
    const match = err?.message?.match(/REDIRECT:\/catalog\/([^?]+)/);
    if (match) artworkId = match[1];
  }
  if (artworkId) createdArtworkIds.push(artworkId);
  return artworkId;
}

async function cleanup() {
  for (const id of createdArtworkIds.splice(0)) {
    await db.delete(artworkCategoryOnArtworkTable).where(eq(artworkCategoryOnArtworkTable.artworkId, id)).catch(() => {});
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdCategoryIds.splice(0)) {
    await db.delete(artworkCategoryOnArtworkTable).where(eq(artworkCategoryOnArtworkTable.categoryId, id)).catch(() => {});
    await db.delete(artworkCategoriesTable).where(eq(artworkCategoriesTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Artwork creation with multiple categoryIds — real-DB integration", () => {
  it("create artwork with two categoryIds → both join rows inserted", async () => {
    const tenantId = await createTenant();
    const cat1 = await createCategory(tenantId);
    const cat2 = await createCategory(tenantId);

    const artworkId = await callCreate({ categoryIds: [cat1, cat2] });

    expect(artworkId).not.toBeUndefined();
    const linked = await linkedCategoryIds(artworkId!);
    expect(linked).toContain(cat1);
    expect(linked).toContain(cat2);
    expect(linked).toHaveLength(2);
  });

  it("create artwork with no categoryIds → no join rows inserted", async () => {
    await createTenant();

    const artworkId = await callCreate({}); // no categoryIds

    expect(artworkId).not.toBeUndefined();
    const linked = await linkedCategoryIds(artworkId!);
    expect(linked).toHaveLength(0);
  });

  it("categoryId from another tenant → not linked (tenant scope guard)", async () => {
    const tenantA = await createTenant();
    const foreignCat = await createCategory(tenantA);

    // Switch to tenant B
    const tenantB = await createTenant();
    mockSession.value = { userId: `u-${tenantB}`, tenantId: tenantB, role: "owner" };

    const artworkId = await callCreate({ categoryIds: [foreignCat] });

    expect(artworkId).not.toBeUndefined();
    const linked = await linkedCategoryIds(artworkId!);
    // Foreign category should NOT be linked.
    expect(linked).not.toContain(foreignCat);
  });

  it("one valid + one foreign categoryId → only valid one linked", async () => {
    const tenantA = await createTenant();
    const foreignCat = await createCategory(tenantA);

    const tenantB = await createTenant();
    const ownCat = await createCategory(tenantB);
    mockSession.value = { userId: `u-${tenantB}`, tenantId: tenantB, role: "owner" };

    const artworkId = await callCreate({ categoryIds: [ownCat, foreignCat] });

    expect(artworkId).not.toBeUndefined();
    const linked = await linkedCategoryIds(artworkId!);
    expect(linked).toContain(ownCat);
    expect(linked).not.toContain(foreignCat);
  });

  it("update artwork swaps categories — old removed, new added", async () => {
    const tenantId = await createTenant();
    const cat1 = await createCategory(tenantId);
    const cat2 = await createCategory(tenantId);

    const artworkId = await callCreate({ categoryIds: [cat1] });
    expect(artworkId).not.toBeUndefined();

    // Update: swap to cat2 only.
    const form = makeForm({ title: "Updated Cat Art", sku: `sku-${uid()}`, price: "100", status: "AVAILABLE", categoryIds: [cat2] });
    await updateArtwork(artworkId!, INITIAL_STATE, form).catch(() => {});

    const linked = await linkedCategoryIds(artworkId!);
    expect(linked).toContain(cat2);
    expect(linked).not.toContain(cat1);
  });
});
