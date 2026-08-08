/**
 * Artwork represented-artist assignment (create + update actions) — real-DB integration.
 *
 * app/(admin)/(gated)/catalog/actions.ts:
 *   createArtwork: validates representedArtistId belongs to tenant before inserting.
 *   updateArtwork: validates representedArtistId belongs to tenant before updating.
 *   Both store the validated ID in artworksTable.representedArtistId.
 *
 *  1. createArtwork with a valid artist stores the artist ID.
 *  2. createArtwork with a foreign artist returns an error (not assigned).
 *  3. updateArtwork can assign a valid artist to an existing artwork.
 *  4. updateArtwork can change from one valid artist to another.
 *  5. updateArtwork with foreign artist returns an error (not assigned).
 *  6. Clearing representedArtistId (omitting field) stores null.
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

function uid() { return `${randomUUID()}-aaai-${RUN}-${++seq}`; }

const mockSession = { value: { userId: "u-artist-assign", tenantId: "PLACEHOLDER", role: "owner" } };

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
    id, slug: id, businessName: "Artist Assign Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  await db.insert(tenantUsersTable).values({ tenantId: id, userId, role: "owner" } as any);
  return { tenantId: id };
}

async function createArtist(tenantId: string, name: string) {
  const id = uid();
  await db.insert(representedArtistsTable).values({ id, tenantId, name } as any);
  createdArtistIds.push(id);
  return id;
}

async function insertArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Artist Assign Art", sku: `sku-${id}`, status: "AVAILABLE",
  } as any);
  createdArtworkIds.push(id);
  return id;
}

function fdCreate(extras: Record<string, string> = {}) {
  const f = new FormData();
  f.set("title", "Artist Assign Art");
  f.set("sku", `sku-${uid()}`);
  f.set("status", "AVAILABLE");
  f.set("price", "");
  for (const [k, v] of Object.entries(extras)) f.set(k, v);
  return f;
}

function fdUpdate(artworkId: string, extras: Record<string, string> = {}) {
  const f = new FormData();
  f.set("title", "Artist Assign Art");
  f.set("sku", `sku-${artworkId}`);
  f.set("status", "AVAILABLE");
  f.set("price", "");
  for (const [k, v] of Object.entries(extras)) f.set(k, v);
  return f;
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

describeIntegration("Artwork represented-artist assignment — real-DB integration", () => {
  it("createArtwork with a valid artist stores the artist ID", async () => {
    const { tenantId } = await createTenant();
    const artistId    = await createArtist(tenantId, "Valid Artist");

    let redirectUrl = "";
    await createArtwork({}, fdCreate({ representedArtistId: artistId }))
      .catch(e => { redirectUrl = String(e); });

    // On success, the action redirects to /catalog/{id}?created=1
    expect(redirectUrl).toContain("created=1");

    // Find the newly created artwork.
    const rows = await db.query.artworksTable.findMany({
      where: eq(artworksTable.tenantId, tenantId),
    });
    const created = rows.find(r => r.representedArtistId === artistId);
    if (created) createdArtworkIds.push(created.id);
    expect(created?.representedArtistId).toBe(artistId);
  });

  it("createArtwork with a foreign artist returns an error", async () => {
    const { tenantId: ownId } = await createTenant();
    const { tenantId: foreignId } = await createTenant();
    const foreignArtistId = await createArtist(foreignId, "Foreign Artist");

    // Restore own session.
    mockSession.value = { ...mockSession.value, tenantId: ownId };

    const result = await createArtwork({}, fdCreate({ representedArtistId: foreignArtistId }));
    expect(result).toHaveProperty("error");
  });

  it("updateArtwork can assign a valid artist to an existing artwork", async () => {
    const { tenantId } = await createTenant();
    const artworkId   = await insertArtwork(tenantId);
    const artistId    = await createArtist(tenantId, "Assigned Artist");

    await updateArtwork(artworkId, {}, fdUpdate(artworkId, { representedArtistId: artistId }))
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const row = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, artworkId) });
    expect(row?.representedArtistId).toBe(artistId);
  });

  it("updateArtwork can change from one valid artist to another", async () => {
    const { tenantId } = await createTenant();
    const artworkId   = await insertArtwork(tenantId);
    const artist1Id   = await createArtist(tenantId, "First Artist");
    const artist2Id   = await createArtist(tenantId, "Second Artist");

    // Assign first artist.
    await updateArtwork(artworkId, {}, fdUpdate(artworkId, { representedArtistId: artist1Id }))
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    // Change to second artist.
    await updateArtwork(artworkId, {}, fdUpdate(artworkId, { representedArtistId: artist2Id }))
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const row = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, artworkId) });
    expect(row?.representedArtistId).toBe(artist2Id);
  });

  it("updateArtwork with foreign artist returns an error (not assigned)", async () => {
    const { tenantId: ownId } = await createTenant();
    const { tenantId: foreignId } = await createTenant();
    const artworkId       = await insertArtwork(ownId);
    const foreignArtistId = await createArtist(foreignId, "Foreign Artist 2");

    // Restore own session.
    mockSession.value = { ...mockSession.value, tenantId: ownId };

    const result = await updateArtwork(artworkId, {},
      fdUpdate(artworkId, { representedArtistId: foreignArtistId }),
    );
    expect(result).toHaveProperty("error");

    const row = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, artworkId) });
    expect(row?.representedArtistId).toBeNull(); // unchanged
  });

  it("clearing representedArtistId by omitting the field stores null", async () => {
    const { tenantId } = await createTenant();
    const artworkId   = await insertArtwork(tenantId);
    const artistId    = await createArtist(tenantId, "To Be Cleared Artist");

    // Assign.
    await updateArtwork(artworkId, {}, fdUpdate(artworkId, { representedArtistId: artistId }))
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    // Clear (no representedArtistId in form).
    await updateArtwork(artworkId, {}, fdUpdate(artworkId))
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const row = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, artworkId) });
    expect(row?.representedArtistId).toBeNull();
  });
});
