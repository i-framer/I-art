/**
 * deleteRepresentedArtist with SOLD artwork — real-DB integration.
 *
 * app/(admin)/(gated)/catalog/artists/actions.ts:80 (deleteRepresentedArtist):
 *   Counts artworks linked to the artist; refuses deletion if count > 0.
 *   This test verifies that SOLD artworks still count as linked and block deletion.
 *
 *  1. Artist with SOLD artwork is blocked from deletion.
 *  2. Artist row persists after blocked delete attempt.
 *  3. SOLD artwork row persists after blocked delete attempt.
 *  4. Artist with only RESERVED artwork is also blocked.
 *  5. Artist with only HIDDEN artwork is also blocked.
 *  6. Artist with no linked artworks (any status) can be deleted.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  representedArtistsTable,
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
const createdArtistIds: string[] = [];
const createdUserIds: string[] = [];

function uid() { return `${randomUUID()}-adsa-${RUN}-${++seq}`; }

const mockTenantId = { value: "PLACEHOLDER" };
const mockUserId = { value: "u-delete-artist" };

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ userId: mockUserId.value, tenantId: mockTenantId.value, role: "owner" })),
}));
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
  hasActiveAccess: () => true,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

import { deleteRepresentedArtist } from "@/app/(admin)/(gated)/catalog/artists/actions";

async function createTenant() {
  const id = uid();
  const userId = uid();
  await db.insert(usersTable).values({ id: userId, email: `u-${userId}@test.com`, passwordHash: "x" } as any);
  createdUserIds.push(userId);
  mockUserId.value = userId;
  mockTenantId.value = id;
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Artist Delete SOLD Test", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  await db.insert(tenantUsersTable).values({ tenantId: id, userId, role: "owner" } as any);
  return id;
}

async function createArtist(tenantId: string, name = "Test Artist") {
  const id = uid();
  await db.insert(representedArtistsTable).values({ id, tenantId, name } as any);
  createdArtistIds.push(id);
  return id;
}

async function createArtwork(tenantId: string, artistId: string, status: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Linked Artwork", sku: `sku-${id}`,
    status, representedArtistId: artistId,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function cleanup() {
  for (const id of createdArtworkIds.splice(0)) {
    await db.delete(artworkCategoryOnArtworkTable)
      .where(eq(artworkCategoryOnArtworkTable.artworkId, id)).catch(() => {});
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdArtistIds.splice(0)) {
    await db.delete(representedArtistsTable).where(eq(representedArtistsTable.id, id)).catch(() => {});
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

describeIntegration("deleteRepresentedArtist with SOLD/RESERVED/HIDDEN artwork — real-DB integration", () => {
  it("artist with SOLD artwork is blocked from deletion", async () => {
    const tenantId = await createTenant();
    const artistId = await createArtist(tenantId, "SOLD Artist");
    await createArtwork(tenantId, artistId, "SOLD");

    const result = await deleteRepresentedArtist(artistId);
    expect(result).toHaveProperty("error");
    expect(result.error).toMatch(/artwork/i);
  });

  it("artist row persists after blocked delete attempt (SOLD artwork)", async () => {
    const tenantId = await createTenant();
    const artistId = await createArtist(tenantId, "Persisted Artist");
    await createArtwork(tenantId, artistId, "SOLD");

    await deleteRepresentedArtist(artistId);

    const row = await db.query.representedArtistsTable.findFirst({
      where: eq(representedArtistsTable.id, artistId),
    });
    expect(row).toBeDefined();
  });

  it("SOLD artwork row persists after blocked delete attempt", async () => {
    const tenantId = await createTenant();
    const artistId = await createArtist(tenantId, "SOLD Block Artist");
    const artworkId = await createArtwork(tenantId, artistId, "SOLD");

    await deleteRepresentedArtist(artistId);

    const row = await db.query.artworksTable.findFirst({
      where: eq(artworksTable.id, artworkId),
    });
    expect(row).toBeDefined();
    expect(row?.status).toBe("SOLD");
  });

  it("artist with only RESERVED artwork is also blocked", async () => {
    const tenantId = await createTenant();
    const artistId = await createArtist(tenantId, "RESERVED Artist");
    await createArtwork(tenantId, artistId, "RESERVED");

    const result = await deleteRepresentedArtist(artistId);
    expect(result).toHaveProperty("error");
    expect(result.error).toMatch(/artwork/i);
  });

  it("artist with only HIDDEN artwork is also blocked", async () => {
    const tenantId = await createTenant();
    const artistId = await createArtist(tenantId, "HIDDEN Artist");
    await createArtwork(tenantId, artistId, "HIDDEN");

    const result = await deleteRepresentedArtist(artistId);
    expect(result).toHaveProperty("error");
    expect(result.error).toMatch(/artwork/i);
  });

  it("artist with no linked artworks can be deleted", async () => {
    const tenantId = await createTenant();
    const artistId = await createArtist(tenantId, "Deletable No-Artwork Artist");

    const result = await deleteRepresentedArtist(artistId);
    expect(result.error).toBe("");

    const row = await db.query.representedArtistsTable.findFirst({
      where: eq(representedArtistsTable.id, artistId),
    });
    expect(row).toBeUndefined();
    const idx = createdArtistIds.indexOf(artistId);
    if (idx !== -1) createdArtistIds.splice(idx, 1);
  });
});
