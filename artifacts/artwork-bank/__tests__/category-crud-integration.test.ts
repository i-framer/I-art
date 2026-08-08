/**
 * Category CRUD actions — real-DB integration.
 *
 * createCategory / renameCategory / deleteCategory / getCategories.
 *
 * Verifies DB persistence and tenant-isolation invariants against real
 * PostgreSQL:
 *
 *  createCategory:
 *   1. Inserts a row and returns success.
 *   2. Rejects a blank name.
 *
 *  renameCategory:
 *   3. Persists the new name.
 *   4. Does NOT rename a foreign tenant's category.
 *
 *  deleteCategory:
 *   5. Deletes a category with no linked artworks.
 *   6. Returns an error when artworks are assigned.
 *
 *  getCategories:
 *   7. Returns tenant-scoped categories with artworkCount.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  artworkCategoriesTable,
  artworkCategoryOnArtworkTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Auth ──────────────────────────────────────────────────────────────────────
const mockTenantId = { value: "PLACEHOLDER" };
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ userId: "u-cat-crud", tenantId: mockTenantId.value })),
}));
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
  hasActiveAccess: () => true,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

import {
  createCategory,
  renameCategory,
  deleteCategory,
  getCategories,
} from "@/app/(admin)/(gated)/catalog/categories/actions";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdArtworkIds: string[] = [];

function uid() {
  return `${randomUUID()}-cat-${RUN}-${++seq}`;
}

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id,
    businessName: "Category CRUD Test Gallery",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: "active",
  } as any);
  createdTenantIds.push(id);
  mockTenantId.value = id;
  return id;
}

async function insertCategory(tenantId: string, name: string) {
  const id = uid();
  await db.insert(artworkCategoriesTable).values({ id, tenantId, name } as any);
  createdCategoryIds.push(id);
  return id;
}

async function insertArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Linked", sku: `sku-${id}`,
    status: "AVAILABLE", showInGallery: true,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function linkArtworkToCategory(artworkId: string, categoryId: string) {
  await db.insert(artworkCategoryOnArtworkTable).values({ artworkId, categoryId } as any);
}

async function cleanup() {
  for (const id of createdArtworkIds.splice(0)) {
    // Remove category links before deleting artwork.
    await db
      .delete(artworkCategoryOnArtworkTable)
      .where(eq(artworkCategoryOnArtworkTable.artworkId, id))
      .catch(() => {});
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdCategoryIds.splice(0)) {
    await db
      .delete(artworkCategoriesTable)
      .where(eq(artworkCategoriesTable.id, id))
      .catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Category CRUD — real-DB integration", () => {
  // ── createCategory ──────────────────────────────────────────────────────────

  it("createCategory: inserts a category row and returns success", async () => {
    const tenantId = await createTenant();

    const result = await createCategory(null, fd({ name: "Paintings" }));

    expect(result.error).toBe("");

    const row = await db.query.artworkCategoriesTable.findFirst({
      where: eq(artworkCategoriesTable.tenantId, tenantId),
    });
    expect(row?.name).toBe("Paintings");
    if (row?.id) createdCategoryIds.push(row.id);
  });

  it("createCategory: returns error for a blank name", async () => {
    await createTenant();

    const result = await createCategory(null, fd({ name: "" }));

    expect(result.error).toBeTruthy();
  });

  // ── renameCategory ──────────────────────────────────────────────────────────

  it("renameCategory: persists the new name", async () => {
    const tenantId = await createTenant();
    const categoryId = await insertCategory(tenantId, "Old Name");

    const result = await renameCategory(categoryId, null, fd({ name: "New Name" }));

    expect(result.error).toBe("");

    const row = await db.query.artworkCategoriesTable.findFirst({
      where: eq(artworkCategoriesTable.id, categoryId),
    });
    expect(row?.name).toBe("New Name");
  });

  it("renameCategory: does NOT rename a foreign tenant's category", async () => {
    const tenantA = await createTenant();
    const categoryId = await insertCategory(tenantA, "Tenant A Category");

    const tenantB = await createTenant();
    mockTenantId.value = tenantB;

    await renameCategory(categoryId, null, fd({ name: "Hijacked Name" }));

    const row = await db.query.artworkCategoriesTable.findFirst({
      where: eq(artworkCategoriesTable.id, categoryId),
    });
    expect(row?.name).toBe("Tenant A Category");
  });

  // ── deleteCategory ─────────────────────────────────────────────────────────

  it("deleteCategory: deletes a category with no linked artworks", async () => {
    const tenantId = await createTenant();
    const categoryId = await insertCategory(tenantId, "To Delete");

    const result = await deleteCategory(categoryId);

    expect(result.error).toBe("");

    const row = await db.query.artworkCategoriesTable.findFirst({
      where: eq(artworkCategoriesTable.id, categoryId),
    });
    expect(row).toBeUndefined();

    const idx = createdCategoryIds.indexOf(categoryId);
    if (idx !== -1) createdCategoryIds.splice(idx, 1);
  });

  it("deleteCategory: returns an error and does NOT delete when artworks are assigned", async () => {
    const tenantId = await createTenant();
    const categoryId = await insertCategory(tenantId, "In Use");
    const artworkId = await insertArtwork(tenantId);
    await linkArtworkToCategory(artworkId, categoryId);

    const result = await deleteCategory(categoryId);

    expect(result.error).toBeTruthy();

    const row = await db.query.artworkCategoriesTable.findFirst({
      where: eq(artworkCategoriesTable.id, categoryId),
    });
    expect(row).toBeDefined();
  });

  // ── getCategories ──────────────────────────────────────────────────────────

  it("getCategories: returns tenant-scoped categories with artworkCount", async () => {
    const tenantId = await createTenant();
    const catId = await insertCategory(tenantId, "Sculptures");
    const artworkId = await insertArtwork(tenantId);
    await linkArtworkToCategory(artworkId, catId);

    const categories = await getCategories();

    const entry = categories.find((c) => c.id === catId);
    expect(entry).toBeDefined();
    expect(entry?.name).toBe("Sculptures");
    expect(entry?.artworkCount).toBe(1);

    // Must not include categories from other tenants.
    const tenantB = await createTenant();
    const otherCatId = await insertCategory(tenantB, "Other Tenant Category");
    mockTenantId.value = tenantId; // switch back

    const filtered = await getCategories();
    expect(filtered.find((c) => c.id === otherCatId)).toBeUndefined();
  });
});
