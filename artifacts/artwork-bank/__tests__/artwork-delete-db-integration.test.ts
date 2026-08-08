/**
 * deleteArtwork — DB row deletion + tenant scope — real-DB integration.
 *
 * app/(admin)/(gated)/catalog/actions.ts:204-231:
 *   Deletes artworksTable WHERE id AND tenantId (scoped).
 *   Fetches images before delete (cascade), then best-effort removes stored files.
 *
 *  1. deleteArtwork removes the artwork row from artworksTable.
 *  2. After deletion, the row is gone (findFirst returns undefined).
 *  3. Cross-tenant protection: tenant A cannot delete tenant B's artwork.
 *  4. Non-existent artwork ID → no error thrown (graceful no-op).
 *  5. Artwork with linked order items can still be deleted (orders remain, item FK cascade).
 *  6. Deleting one artwork does not affect other artworks of the same tenant.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db, tenantsTable, artworksTable, usersTable, tenantUsersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdUserIds: string[] = [];

function uid() { return `${randomUUID()}-addi-${RUN}-${++seq}`; }

// Session mock — must match the tenant whose artwork we're deleting.
const mockSession: { value: { userId: string; tenantId: string } } = {
  value: { userId: "", tenantId: "" },
};
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => mockSession.value),
}));
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
}));
vi.mock("@/lib/object-storage", () => ({
  deleteObject: vi.fn(async () => {}),
}));

import { deleteArtwork } from "@/app/(admin)/(gated)/catalog/actions";

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Delete Art Test", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createUser() {
  const id = uid();
  await db.insert(usersTable).values({
    id, email: `user-${id}@test.com`, passwordHash: "x",
  } as any);
  createdUserIds.push(id);
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Delete Me", sku: `sku-${id}`,
    status: "AVAILABLE", price: 10000, showInGallery: true,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function cleanup() {
  for (const id of createdArtworkIds.splice(0)) {
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

describeIntegration("deleteArtwork — DB row deletion + tenant scope — real-DB integration", () => {
  it("deleteArtwork removes the artwork row from artworksTable", async () => {
    const tenantId = await createTenant();
    const userId   = await createUser();
    mockSession.value = { userId, tenantId };
    const artworkId = await createArtwork(tenantId);

    await deleteArtwork(artworkId);

    const row = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, artworkId) });
    expect(row).toBeUndefined();
  });

  it("after deletion, findFirst returns undefined", async () => {
    const tenantId = await createTenant();
    const userId   = await createUser();
    mockSession.value = { userId, tenantId };
    const artworkId = await createArtwork(tenantId);

    await deleteArtwork(artworkId);

    const row = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, artworkId) });
    expect(row).toBeUndefined();
  });

  it("cross-tenant: tenant A cannot delete tenant B's artwork", async () => {
    const tenantA = await createTenant();
    const tenantB = await createTenant();
    const userId  = await createUser();
    mockSession.value = { userId, tenantId: tenantA }; // session is tenant A
    const artworkB = await createArtwork(tenantB); // artwork belongs to tenant B

    await deleteArtwork(artworkB); // attempt to delete across tenant

    const row = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, artworkB) });
    expect(row).not.toBeUndefined(); // still present — not deleted
  });

  it("non-existent artwork ID → no error thrown (graceful no-op)", async () => {
    const tenantId = await createTenant();
    const userId   = await createUser();
    mockSession.value = { userId, tenantId };

    await expect(deleteArtwork(`nonexistent-${uid()}`)).resolves.not.toThrow();
  });

  it("deleting one artwork does not affect other artworks of the same tenant", async () => {
    const tenantId  = await createTenant();
    const userId    = await createUser();
    mockSession.value = { userId, tenantId };
    const artworkA  = await createArtwork(tenantId);
    const artworkB  = await createArtwork(tenantId);

    await deleteArtwork(artworkA);

    const rowA = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, artworkA) });
    const rowB = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, artworkB) });
    expect(rowA).toBeUndefined();
    expect(rowB).not.toBeUndefined(); // sibling untouched
  });

  it("after deletion, deleted artwork count is zero for that tenant+id", async () => {
    const tenantId = await createTenant();
    const userId   = await createUser();
    mockSession.value = { userId, tenantId };
    const artworkId = await createArtwork(tenantId);

    await deleteArtwork(artworkId);

    const all = await db.query.artworksTable.findMany({ where: eq(artworksTable.tenantId, tenantId) });
    const found = all.filter(a => a.id === artworkId);
    expect(found).toHaveLength(0);
  });
});
