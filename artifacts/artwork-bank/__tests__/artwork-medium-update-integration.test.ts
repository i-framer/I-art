/**
 * Artwork medium field update — real-DB integration.
 *
 * app/(admin)/(gated)/catalog/actions.ts: updateArtwork(id, prevState, formData).
 * The medium field is optional; absent or empty → null.
 * createArtwork nullable medium is covered in artwork-crud-integration.test.ts.
 * This test covers UPDATE scenarios.
 *
 *  1. updateArtwork sets medium from null to a value.
 *  2. updateArtwork changes medium from one value to another.
 *  3. updateArtwork clears medium to null when field is absent.
 *  4. medium is independent between two artworks in the same tenant.
 *  5. medium update is tenant-isolated (foreign artwork blocked).
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  usersTable,
  tenantUsersTable,
  artworkCategoryOnArtworkTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdUserIds: string[] = [];

function uid() { return `${randomUUID()}-amui-${RUN}-${++seq}`; }

const mockSession = { value: { userId: "u-medium", tenantId: "PLACEHOLDER", role: "owner" } };

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
    id, slug: id, businessName: "Medium Update Test", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  await db.insert(tenantUsersTable).values({ tenantId: id, userId, role: "owner" } as any);
  return { tenantId: id };
}

async function createArtworkInDb(tenantId: string, medium: string | null = null) {
  const id = uid();
  const sku = `sku-${id}`;
  await db.insert(artworksTable).values({
    id, tenantId, title: "Medium Art", sku, status: "AVAILABLE",
    medium,
  } as any);
  createdArtworkIds.push(id);
  return { artworkId: id, sku };
}

function fd(sku: string, medium?: string) {
  const f = new FormData();
  f.set("title", "Medium Art");
  f.set("sku", sku);
  f.set("status", "AVAILABLE");
  f.set("price", "100");
  if (medium) f.set("medium", medium);
  return f;
}

async function callUpdate(artworkId: string, sku: string, medium?: string) {
  await updateArtwork(artworkId, { error: "" }, fd(sku, medium)).catch((err: Error) => {
    if (!err.message.startsWith("REDIRECT:")) throw err;
  });
}

async function artworkMedium(artworkId: string) {
  const row = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, artworkId) });
  return row?.medium ?? null;
}

async function cleanup() {
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

describeIntegration("Artwork medium field update — real-DB integration", () => {
  it("updateArtwork sets medium from null to a value", async () => {
    const { tenantId } = await createTenant();
    const { artworkId, sku } = await createArtworkInDb(tenantId, null);

    await callUpdate(artworkId, sku, "Oil on canvas");

    expect(await artworkMedium(artworkId)).toBe("Oil on canvas");
  });

  it("updateArtwork changes medium from one value to another", async () => {
    const { tenantId } = await createTenant();
    const { artworkId, sku } = await createArtworkInDb(tenantId, "Watercolor");

    await callUpdate(artworkId, sku, "Acrylic on board");

    expect(await artworkMedium(artworkId)).toBe("Acrylic on board");
  });

  it("updateArtwork clears medium to null when field is absent", async () => {
    const { tenantId } = await createTenant();
    const { artworkId, sku } = await createArtworkInDb(tenantId, "Charcoal");

    await callUpdate(artworkId, sku); // no medium

    expect(await artworkMedium(artworkId)).toBeNull();
  });

  it("medium is independent between two artworks in the same tenant", async () => {
    const { tenantId } = await createTenant();
    const { artworkId: art1, sku: sku1 } = await createArtworkInDb(tenantId, null);
    const { artworkId: art2, sku: _sku2 } = await createArtworkInDb(tenantId, null);

    await callUpdate(art1, sku1, "Sculpture");

    expect(await artworkMedium(art1)).toBe("Sculpture");
    expect(await artworkMedium(art2)).toBeNull(); // unchanged
  });

  it("medium update is tenant-isolated (foreign artwork not updated)", async () => {
    const { tenantId: ownId }     = await createTenant();
    const { tenantId: foreignId } = await createTenant();
    const { artworkId: foreignArt, sku: foreignSku } = await createArtworkInDb(foreignId, null);

    mockSession.value = { ...mockSession.value, tenantId: ownId };
    await callUpdate(foreignArt, foreignSku, "Photography");

    expect(await artworkMedium(foreignArt)).toBeNull(); // unchanged
  });
});
