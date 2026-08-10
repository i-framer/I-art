/**
 * artworkCategoryOnArtwork — link, sync, and unlink — real-DB integration.
 *
 * app/(admin)/(gated)/catalog/actions.ts: createArtwork/updateArtwork sync
 * the artworkCategoryOnArtworkTable rows (delete old + insert new).
 *
 *  1. createArtwork with a categoryId links the artwork to the category.
 *  2. updateArtwork replaces existing category link with a new one.
 *  3. updateArtwork with no categoryId removes all category links.
 *  4. Category links are tenant-scoped — another tenant's category cannot be linked.
 *  5. Artwork can have at most one category (the sync is replace-all, not append).
 *  6. Category link persists through unrelated field updates.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  artworkCategoryOnArtworkTable,
  artworkCategoriesTable,
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

function uid() { return `${randomUUID()}-acli-${RUN}-${++seq}`; }

const mockSession = { value: { userId: "u-cat-link", tenantId: "PLACEHOLDER", role: "owner" } };

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

import { createArtwork, updateArtwork } from "@/app/(admin)/(gated)/catalog/actions";

async function createTenant() {
  const id = uid();
  const userId = uid();
  await db.insert(usersTable).values({ id: userId, email: `u-${userId}@test.com`, passwordHash: "x" } as any);
  createdUserIds.push(userId);
  mockSession.value = { userId, tenantId: id, role: "owner" };
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Cat Link Test", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  await db.insert(tenantUsersTable).values({ tenantId: id, userId, role: "owner" } as any);
  return { tenantId: id };
}

async function createCategory(tenantId: string) {
  const id = uid();
  await db.insert(artworkCategoriesTable).values({ id, tenantId, name: `Cat ${seq}` } as any);
  createdCategoryIds.push(id);
  return id;
}

async function latestArtworkId(tenantId: string) {
  const rows = await db.query.artworksTable.findMany({ where: eq(artworksTable.tenantId, tenantId) });
  rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const row = rows[0];
  if (row) createdArtworkIds.push(row.id);
  return row?.id ?? null;
}

async function categoriesForArtwork(artworkId: string) {
  return db.query.artworkCategoryOnArtworkTable.findMany({
    where: eq(artworkCategoryOnArtworkTable.artworkId, artworkId),
  });
}

function fd(sku: string, categoryId?: string, title = "Cat Link Art") {
  const f = new FormData();
  f.set("title", title);
  f.set("sku", sku);
  f.set("status", "AVAILABLE");
  if (categoryId) f.append("categoryIds", categoryId);
  return f;
}

async function safeCall(fn: () => Promise<any>) {
  return fn().catch((e: Error) => { if (!e.message.startsWith("REDIRECT:")) throw e; });
}

async function cleanup() {
  for (const id of createdArtworkIds.splice(0)) {
    await db.delete(artworkCategoryOnArtworkTable)
      .where(eq(artworkCategoryOnArtworkTable.artworkId, id)).catch(() => {});
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdCategoryIds.splice(0)) {
    await db.delete(artworkCategoryOnArtworkTable)
      .where(eq(artworkCategoryOnArtworkTable.categoryId, id)).catch(() => {});
    await db.delete(artworkCategoriesTable).where(eq(artworkCategoriesTable.id, id)).catch(() => {});
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

describeIntegration("artworkCategoryOnArtwork link/sync — real-DB integration", () => {
  it("createArtwork with a categoryId links the artwork to the category", async () => {
    const { tenantId } = await createTenant();
    const catId = await createCategory(tenantId);

    await safeCall(() => createArtwork({ error: "" }, fd(`sku-${uid()}`, catId)));

    const artworkId = await latestArtworkId(tenantId);
    const links = await categoriesForArtwork(artworkId!);
    expect(links.map(l => l.categoryId)).toContain(catId);
  });

  it("updateArtwork replaces existing category link with a new one", async () => {
    const { tenantId } = await createTenant();
    const catA = await createCategory(tenantId);
    const catB = await createCategory(tenantId);
    const sku = `sku-${uid()}`;

    await safeCall(() => createArtwork({ error: "" }, fd(sku, catA)));
    const artworkId = await latestArtworkId(tenantId);

    await safeCall(() => updateArtwork(artworkId!, { error: "" }, fd(sku, catB)));

    const links = await categoriesForArtwork(artworkId!);
    expect(links).toHaveLength(1);
    expect(links[0]!.categoryId).toBe(catB);
  });

  it("updateArtwork with no categoryId removes all category links", async () => {
    const { tenantId } = await createTenant();
    const catA = await createCategory(tenantId);
    const sku = `sku-${uid()}`;

    await safeCall(() => createArtwork({ error: "" }, fd(sku, catA)));
    const artworkId = await latestArtworkId(tenantId);

    // Update without any categoryId.
    await safeCall(() => updateArtwork(artworkId!, { error: "" }, fd(sku)));

    const links = await categoriesForArtwork(artworkId!);
    expect(links).toHaveLength(0);
  });

  it("category link persists through an unrelated field update (price change)", async () => {
    const { tenantId } = await createTenant();
    const catA = await createCategory(tenantId);
    const sku = `sku-${uid()}`;

    await safeCall(() => createArtwork({ error: "" }, fd(sku, catA)));
    const artworkId = await latestArtworkId(tenantId);

    // Update price but keep same category.
    const f = new FormData();
    f.set("title", "Cat Link Art"); f.set("sku", sku);
    f.set("status", "AVAILABLE"); f.set("price", "200");
    f.append("categoryIds", catA);
    await safeCall(() => updateArtwork(artworkId!, { error: "" }, f));

    const links = await categoriesForArtwork(artworkId!);
    expect(links.map(l => l.categoryId)).toContain(catA);
  });

  it("artwork can have at most one active category after sync (replace-all semantics)", async () => {
    const { tenantId } = await createTenant();
    const catA = await createCategory(tenantId);
    const catB = await createCategory(tenantId);
    const sku = `sku-${uid()}`;

    await safeCall(() => createArtwork({ error: "" }, fd(sku, catA)));
    const artworkId = await latestArtworkId(tenantId);
    await safeCall(() => updateArtwork(artworkId!, { error: "" }, fd(sku, catB)));
    await safeCall(() => updateArtwork(artworkId!, { error: "" }, fd(sku, catA)));

    const links = await categoriesForArtwork(artworkId!);
    expect(links).toHaveLength(1);
  });

  it("cross-tenant category link is rejected or creates no link row", async () => {
    const { tenantId: tenantA } = await createTenant();
    const { tenantId: tenantB } = await createTenant();
    // catB belongs to tenantB; tenantA session tries to use it.
    const catB = await createCategory(tenantB);

    mockSession.value = { ...mockSession.value, tenantId: tenantA };
    const skuA = `sku-${uid()}`;
    await safeCall(() => createArtwork({ error: "" }, fd(skuA, catB))).catch(() => {});

    const artworkId = await latestArtworkId(tenantA);
    if (artworkId) {
      const links = await categoriesForArtwork(artworkId);
      // Either no link was created, or only tenant-scoped categories appear.
      for (const link of links) {
        const cat = await db.query.artworkCategoriesTable.findFirst({
          where: eq(artworkCategoriesTable.id, link.categoryId),
        });
        expect(cat?.tenantId).toBe(tenantA);
      }
    }
  });
});
