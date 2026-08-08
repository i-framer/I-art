/**
 * createArtwork with categoryIds — real-DB integration.
 *
 * app/(admin)/(gated)/catalog/actions.ts:95-140:
 *   createArtwork inserts artworksTable row, then:
 *     queries artworkCategoriesTable WHERE tenantId = session.tenantId AND id IN categoryIds
 *     inserts junction rows into artworkCategoryOnArtworkTable for valid categories only.
 *
 *  1. createArtwork with valid category IDs persists the junction rows.
 *  2. createArtwork with multiple categories persists all junction rows.
 *  3. createArtwork with invalid/foreign category IDs: those are silently filtered out.
 *  4. createArtwork with no categoryIds creates no junction rows.
 *  5. showInGallery=on sets showInGallery=true in the created artwork.
 *  6. showInGallery omitted sets showInGallery=false.
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
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdUserIds: string[] = [];

function uid() { return `${randomUUID()}-acwc-${RUN}-${++seq}`; }

const mockSession = { value: { userId: "u-create-cat", tenantId: "PLACEHOLDER", role: "owner" } };

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

import { createArtwork } from "@/app/(admin)/(gated)/catalog/actions";

async function setupTenant() {
  const id = uid();
  const userId = uid();
  await db.insert(usersTable).values({ id: userId, email: `u-${userId}@test.com`, passwordHash: "x" } as any);
  createdUserIds.push(userId);
  mockSession.value = { userId, tenantId: id, role: "owner" };
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Create Cat Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  await db.insert(tenantUsersTable).values({ tenantId: id, userId, role: "owner" } as any);
  return { tenantId: id };
}

async function createCategory(tenantId: string, name: string) {
  const id = uid();
  await db.insert(artworkCategoriesTable).values({ id, tenantId, name } as any);
  createdCategoryIds.push(id);
  return id;
}

function fd(extras: Record<string, string | string[]> = {}) {
  const f = new FormData();
  f.set("title", "Create Cat Art");
  f.set("sku", `sku-${uid()}`);
  f.set("status", "AVAILABLE");
  f.set("price", "");
  for (const [k, v] of Object.entries(extras)) {
    if (Array.isArray(v)) for (const val of v) f.append(k, val);
    else f.set(k, v);
  }
  return f;
}

async function junctionCats(artworkId: string) {
  const rows = await db.query.artworkCategoryOnArtworkTable.findMany({
    where: eq(artworkCategoryOnArtworkTable.artworkId, artworkId),
  });
  return rows.map(r => r.categoryId);
}

/** Find the most recently created artwork for a tenant (after redirect). */
async function latestArtwork(tenantId: string) {
  const rows = await db.query.artworksTable.findMany({
    where: eq(artworksTable.tenantId, tenantId),
  });
  if (!rows.length) return null;
  const sorted = rows.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
  if (sorted[0]) createdArtworkIds.push(sorted[0].id);
  return sorted[0];
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

describeIntegration("createArtwork with categoryIds — real-DB integration", () => {
  it("createArtwork with valid category ID persists the junction row", async () => {
    const { tenantId } = await setupTenant();
    const catId = await createCategory(tenantId, "Paintings");

    await createArtwork({}, fd({ categoryIds: catId }))
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const art = await latestArtwork(tenantId);
    expect(art).not.toBeNull();
    expect(await junctionCats(art!.id)).toContain(catId);
  });

  it("createArtwork with multiple categories persists all junction rows", async () => {
    const { tenantId } = await setupTenant();
    const cat1 = await createCategory(tenantId, "Photography");
    const cat2 = await createCategory(tenantId, "Sculpture");
    const cat3 = await createCategory(tenantId, "Digital");

    await createArtwork({}, fd({ categoryIds: [cat1, cat2, cat3] }))
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const art = await latestArtwork(tenantId);
    const cats = await junctionCats(art!.id);
    expect(cats).toContain(cat1);
    expect(cats).toContain(cat2);
    expect(cats).toContain(cat3);
  });

  it("foreign category ID is silently filtered out — no junction row created", async () => {
    const { tenantId: ownId } = await setupTenant();
    const { tenantId: foreignId } = await setupTenant();
    const foreignCatId = await createCategory(foreignId, "Foreign Cat");

    // Restore own session after second setup.
    mockSession.value = { ...mockSession.value, tenantId: ownId };

    await createArtwork({}, fd({ categoryIds: foreignCatId }))
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const art = await latestArtwork(ownId);
    expect(art).not.toBeNull();
    expect(await junctionCats(art!.id)).not.toContain(foreignCatId);
  });

  it("createArtwork with no categoryIds creates no junction rows", async () => {
    const { tenantId } = await setupTenant();

    await createArtwork({}, fd())
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const art = await latestArtwork(tenantId);
    expect(art).not.toBeNull();
    expect(await junctionCats(art!.id)).toHaveLength(0);
  });

  it("showInGallery=on sets showInGallery=true in the created artwork", async () => {
    const { tenantId } = await setupTenant();

    await createArtwork({}, fd({ showInGallery: "on" }))
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const art = await latestArtwork(tenantId);
    expect(art?.showInGallery).toBe(true);
  });

  it("showInGallery omitted sets showInGallery=false", async () => {
    const { tenantId } = await setupTenant();

    await createArtwork({}, fd())
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const art = await latestArtwork(tenantId);
    expect(art?.showInGallery).toBe(false);
  });
});
