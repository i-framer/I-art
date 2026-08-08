/**
 * Artwork category assignment (updateArtwork action) — real-DB integration.
 *
 * app/(admin)/(gated)/catalog/actions.ts:182-200:
 *   updateArtwork syncs categories via delete-all then re-insert:
 *     DELETE FROM artwork_category_on_artwork WHERE artworkId = id
 *     INSERT INTO artwork_category_on_artwork VALUES (artworkId, categoryId, ...)
 *   Only categories belonging to session.tenantId are accepted.
 *
 *  1. Assigning a category to an artwork persists the junction row.
 *  2. Re-assigning replaces the old category set (delete-then-insert).
 *  3. Assigning zero categories clears all existing assignments.
 *  4. Foreign tenant category is silently filtered out (not assigned).
 *  5. Multiple categories are all assigned together.
 *  6. Foreign tenant artwork cannot be updated (category or otherwise).
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  artworkCategoriesTable,
  artworkCategoryOnArtworkTable,
  usersTable,
  tenantUsersTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdUserIds: string[] = [];

function uid() { return `${randomUUID()}-acai-${RUN}-${++seq}`; }

const mockSession = { value: { userId: "u-cat-assign", tenantId: "PLACEHOLDER", role: "owner" } };

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

import { updateArtwork } from "@/app/(admin)/(gated)/catalog/actions";

async function createTenant() {
  const id = uid();
  const userId = uid();
  await db.insert(usersTable).values({ id: userId, email: `u-${userId}@test.com`, passwordHash: "x" } as any);
  createdUserIds.push(userId);
  mockSession.value = { userId, tenantId: id, role: "owner" };
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Category Assignment Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  await db.insert(tenantUsersTable).values({ tenantId: id, userId, role: "owner" } as any);
  return { tenantId: id };
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Category Assignment Art", sku: `sku-${id}`, status: "AVAILABLE",
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createCategory(tenantId: string, name: string) {
  const id = uid();
  await db.insert(artworkCategoriesTable).values({ id, tenantId, name } as any);
  createdCategoryIds.push(id);
  return id;
}

async function assignedCategories(artworkId: string) {
  const rows = await db.query.artworkCategoryOnArtworkTable.findMany({
    where: eq(artworkCategoryOnArtworkTable.artworkId, artworkId),
  });
  return rows.map(r => r.categoryId);
}

function fd(artworkId: string, extras: Record<string, string> = {}) {
  const f = new FormData();
  f.set("title", "Category Assignment Art");
  f.set("sku", `sku-${artworkId}`);
  f.set("status", "AVAILABLE");
  f.set("price", "");
  for (const [k, v] of Object.entries(extras)) f.set(k, v);
  return f;
}

async function cleanup() {
  for (const id of createdCategoryIds.splice(0)) {
    await db.delete(artworkCategoryOnArtworkTable)
      .where(eq(artworkCategoryOnArtworkTable.categoryId, id)).catch(() => {});
    await db.delete(artworkCategoriesTable).where(eq(artworkCategoriesTable.id, id)).catch(() => {});
  }
  for (const id of createdArtworkIds.splice(0)) {
    await db.delete(artworkCategoryOnArtworkTable)
      .where(eq(artworkCategoryOnArtworkTable.artworkId, id)).catch(() => {});
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantUsersTable).where(eq(tenantUsersTable.tenantId, id)).catch(() => {});
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
  for (const id of createdUserIds.splice(0)) {
    await db.delete(usersTable).where(eq(usersTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Artwork category assignment (updateArtwork) — real-DB integration", () => {
  it("assigning a category persists the junction row", async () => {
    const { tenantId } = await createTenant();
    const artworkId   = await createArtwork(tenantId);
    const catId       = await createCategory(tenantId, "Paintings");

    const f = fd(artworkId);
    f.append("categoryIds", catId);
    await updateArtwork(artworkId, {}, f)
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    expect(await assignedCategories(artworkId)).toContain(catId);
  });

  it("re-assigning replaces the old category set (delete-then-insert)", async () => {
    const { tenantId } = await createTenant();
    const artworkId   = await createArtwork(tenantId);
    const oldCatId    = await createCategory(tenantId, "Old Category");
    const newCatId    = await createCategory(tenantId, "New Category");

    // First assign.
    const f1 = fd(artworkId);
    f1.append("categoryIds", oldCatId);
    await updateArtwork(artworkId, {}, f1)
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    // Reassign to new category.
    const f2 = fd(artworkId);
    f2.append("categoryIds", newCatId);
    await updateArtwork(artworkId, {}, f2)
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const cats = await assignedCategories(artworkId);
    expect(cats).toContain(newCatId);
    expect(cats).not.toContain(oldCatId);
  });

  it("submitting zero categories clears all existing assignments", async () => {
    const { tenantId } = await createTenant();
    const artworkId   = await createArtwork(tenantId);
    const catId       = await createCategory(tenantId, "Sculptures");

    // Assign.
    const f1 = fd(artworkId);
    f1.append("categoryIds", catId);
    await updateArtwork(artworkId, {}, f1)
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    // Clear.
    await updateArtwork(artworkId, {}, fd(artworkId))
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    expect(await assignedCategories(artworkId)).toHaveLength(0);
  });

  it("foreign tenant category is silently filtered out (not assigned)", async () => {
    const { tenantId: ownId } = await createTenant();
    const { tenantId: foreignId } = await createTenant();
    const artworkId   = await createArtwork(ownId);
    // Restore own session after second createTenant() changed it.
    const ownTenantUserId = mockSession.value.userId;
    mockSession.value = { ...mockSession.value, tenantId: ownId };

    const foreignCatId = await createCategory(foreignId, "Foreign Category");

    // Note: after creating the foreign tenant, mockSession was updated to foreignId.
    // Restore to ownId.
    mockSession.value = { ...mockSession.value, tenantId: ownId };

    const f = fd(artworkId);
    f.append("categoryIds", foreignCatId);
    await updateArtwork(artworkId, {}, f)
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    expect(await assignedCategories(artworkId)).not.toContain(foreignCatId);
  });

  it("multiple categories are all assigned together", async () => {
    const { tenantId } = await createTenant();
    const artworkId   = await createArtwork(tenantId);
    const cat1 = await createCategory(tenantId, "Paintings");
    const cat2 = await createCategory(tenantId, "Photography");
    const cat3 = await createCategory(tenantId, "Sculpture");

    const f = fd(artworkId);
    f.append("categoryIds", cat1);
    f.append("categoryIds", cat2);
    f.append("categoryIds", cat3);
    await updateArtwork(artworkId, {}, f)
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const cats = await assignedCategories(artworkId);
    expect(cats).toContain(cat1);
    expect(cats).toContain(cat2);
    expect(cats).toContain(cat3);
  });

  it("foreign tenant artwork cannot have categories updated via own session", async () => {
    const { tenantId: ownId } = await createTenant();

    const foreignTenantId = uid();
    await db.insert(tenantsTable).values({
      id: foreignTenantId, slug: foreignTenantId,
      businessName: "Foreign Cat Gallery", type: "ARTIST",
    } as any);
    createdTenantIds.push(foreignTenantId);
    const foreignArtworkId = uid();
    await db.insert(artworksTable).values({
      id: foreignArtworkId, tenantId: foreignTenantId,
      title: "Foreign Art", sku: `sku-${foreignArtworkId}`, status: "AVAILABLE",
    } as any);
    createdArtworkIds.push(foreignArtworkId);

    const cat = await createCategory(ownId, "Own Cat");
    const f = fd(foreignArtworkId);
    f.append("categoryIds", cat);

    const result = await updateArtwork(foreignArtworkId, {}, f);
    expect(result).toEqual({ error: "Artwork not found." });
  });
});
