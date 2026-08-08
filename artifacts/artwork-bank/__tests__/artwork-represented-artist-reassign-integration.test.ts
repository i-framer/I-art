/**
 * updateArtwork — representedArtistId reassignment — real-DB integration.
 *
 * app/(admin)/(gated)/catalog/actions.ts: updateArtwork(id, prevState, formData).
 * Tests artist link changes: A → B, A → null, null → A, invalid ID.
 *
 *  1. Artwork can be reassigned from artist A to artist B.
 *  2. Artist link can be cleared (set to null).
 *  3. Null artist link can be set to an artist.
 *  4. Reassignment to a nonexistent/foreign artist ID is rejected or leaves unchanged.
 *  5. Artwork from another tenant cannot have its artist link changed by this tenant.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  artworkCategoryOnArtworkTable,
  representedArtistsTable,
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

function uid() { return `${randomUUID()}-araai-${RUN}-${++seq}`; }

const mockSession = { value: { userId: "u-reassign", tenantId: "PLACEHOLDER", role: "owner" } };

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
    id, slug: id, businessName: "Artist Reassign Test", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  await db.insert(tenantUsersTable).values({ tenantId: id, userId, role: "owner" } as any);
  return { tenantId: id };
}

async function createArtist(tenantId: string) {
  const id = uid();
  await db.insert(representedArtistsTable).values({ id, tenantId, name: `Artist ${seq}` } as any);
  createdArtistIds.push(id);
  return id;
}

async function createArtworkInDb(tenantId: string, representedArtistId?: string) {
  const id = uid();
  const sku = `sku-${id}`;
  await db.insert(artworksTable).values({
    id, tenantId, title: "Reassign Art", sku, status: "AVAILABLE",
    representedArtistId: representedArtistId ?? null,
  } as any);
  createdArtworkIds.push(id);
  return { artworkId: id, sku };
}

function fd(sku: string, representedArtistId?: string) {
  const f = new FormData();
  f.set("title", "Reassign Art");
  f.set("sku", sku);
  f.set("status", "AVAILABLE");
  f.set("price", "100");
  if (representedArtistId) f.set("representedArtistId", representedArtistId);
  return f;
}

async function artworkArtistId(artworkId: string) {
  const row = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, artworkId) });
  return row?.representedArtistId ?? null;
}

async function callUpdate(artworkId: string, sku: string, representedArtistId?: string) {
  await updateArtwork(artworkId, { error: "" }, fd(sku, representedArtistId)).catch((e: Error) => {
    if (!e.message.startsWith("REDIRECT:")) throw e;
  });
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

describeIntegration("updateArtwork representedArtistId reassignment — real-DB integration", () => {
  it("artwork can be reassigned from artist A to artist B", async () => {
    const { tenantId } = await createTenant();
    const artistA = await createArtist(tenantId);
    const artistB = await createArtist(tenantId);
    const { artworkId, sku } = await createArtworkInDb(tenantId, artistA);

    await callUpdate(artworkId, sku, artistB);

    expect(await artworkArtistId(artworkId)).toBe(artistB);
  });

  it("artist link can be cleared (set to null) by omitting representedArtistId", async () => {
    const { tenantId } = await createTenant();
    const artistA = await createArtist(tenantId);
    const { artworkId, sku } = await createArtworkInDb(tenantId, artistA);

    await callUpdate(artworkId, sku); // no representedArtistId

    expect(await artworkArtistId(artworkId)).toBeNull();
  });

  it("null artist link can be set to an artist", async () => {
    const { tenantId } = await createTenant();
    const artist = await createArtist(tenantId);
    const { artworkId, sku } = await createArtworkInDb(tenantId); // no artist

    await callUpdate(artworkId, sku, artist);

    expect(await artworkArtistId(artworkId)).toBe(artist);
  });

  it("reassignment to a nonexistent artist ID is rejected or leaves artworkId unchanged", async () => {
    const { tenantId } = await createTenant();
    const artistA = await createArtist(tenantId);
    const { artworkId, sku } = await createArtworkInDb(tenantId, artistA);
    const nonExistentId = `nonexistent-${uid()}`;

    const before = await artworkArtistId(artworkId);

    await callUpdate(artworkId, sku, nonExistentId).catch(() => {});

    const after = await artworkArtistId(artworkId);
    // Either the update was rejected (value unchanged) or the DB ignored the invalid ID.
    expect(after).toBe(before); // stays the same — nonexistent IDs should not alter the row
  });

  it("foreign tenant artwork cannot have its artist link changed by own session", async () => {
    const { tenantId: ownId }     = await createTenant();
    const { tenantId: foreignId } = await createTenant();
    const foreignArtist = await createArtist(foreignId);
    const ownArtist     = await createArtist(ownId);
    const { artworkId, sku } = await createArtworkInDb(foreignId, foreignArtist);

    mockSession.value = { ...mockSession.value, tenantId: ownId };
    await callUpdate(artworkId, sku, ownArtist).catch(() => {});

    expect(await artworkArtistId(artworkId)).toBe(foreignArtist); // unchanged
  });
});
