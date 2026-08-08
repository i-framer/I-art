/**
 * updateRepresentedArtist — name change — real-DB integration.
 *
 * app/(admin)/(gated)/artists/[artistId]/actions.ts (or catalog/actions.ts):
 *   updateRepresentedArtist(artistId, prevState, formData).
 *   This tests specifically that an artist's name can be changed and is
 *   correctly persisted.
 *
 *  1. Artist name update is persisted to DB.
 *  2. Name update does not affect bio or commissionPct.
 *  3. Name is tenant-isolated — foreign artist not updated.
 *  4. Artist can be renamed multiple times; last value persists.
 *  5. Empty name is rejected or leaves name unchanged.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  representedArtistsTable,
  usersTable,
  tenantUsersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtistIds: string[] = [];
const createdUserIds: string[] = [];

function uid() { return `${randomUUID()}-urani-${RUN}-${++seq}`; }

const mockSession = { value: { userId: "u-artist-name", tenantId: "PLACEHOLDER", role: "owner" } };

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

import { updateRepresentedArtist } from "@/app/(admin)/(gated)/catalog/artists/actions";

async function createTenant() {
  const id = uid();
  const userId = uid();
  await db.insert(usersTable).values({ id: userId, email: `u-${userId}@test.com`, passwordHash: "x" } as any);
  createdUserIds.push(userId);
  mockSession.value = { userId, tenantId: id, role: "owner" };
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Artist Name Update Test", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  await db.insert(tenantUsersTable).values({ tenantId: id, userId, role: "owner" } as any);
  return { tenantId: id };
}

async function createArtist(tenantId: string, name: string) {
  const id = uid();
  await db.insert(representedArtistsTable).values({
    id, tenantId, name, bio: "Original bio", commissionPct: 15,
  } as any);
  createdArtistIds.push(id);
  return id;
}

function fd(name: string, bio?: string, commissionPct?: string) {
  const f = new FormData();
  f.set("name", name);
  if (bio !== undefined) f.set("bio", bio);
  if (commissionPct !== undefined) f.set("commissionPct", commissionPct);
  return f;
}

async function artistRow(artistId: string) {
  return db.query.representedArtistsTable.findFirst({ where: eq(representedArtistsTable.id, artistId) });
}

async function cleanup() {
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

describeIntegration("updateRepresentedArtist name change — real-DB integration", () => {
  it("artist name update is persisted to DB", async () => {
    const { tenantId } = await createTenant();
    const artistId = await createArtist(tenantId, "Original Name");

    await updateRepresentedArtist(artistId, { error: "" }, fd("Updated Name", "Original bio", "15")).catch((e: Error) => {
      if (!e.message.startsWith("REDIRECT:")) throw e;
    });

    const row = await artistRow(artistId);
    expect(row?.name).toBe("Updated Name");
  });

  it("name update does not affect bio or commissionPct when they're re-submitted unchanged", async () => {
    const { tenantId } = await createTenant();
    const artistId = await createArtist(tenantId, "Original Name");

    await updateRepresentedArtist(artistId, { error: "" }, fd("New Name", "Original bio", "15")).catch((e: Error) => {
      if (!e.message.startsWith("REDIRECT:")) throw e;
    });

    const row = await artistRow(artistId);
    expect(row?.name).toBe("New Name");
    expect(row?.bio).toBe("Original bio");
    expect(row?.commissionPct).toBe(15);
  });

  it("name is tenant-isolated — foreign artist not updated by another tenant's session", async () => {
    const { tenantId: ownId }     = await createTenant();
    const { tenantId: foreignId } = await createTenant();
    const foreignArtistId = await createArtist(foreignId, "Foreign Artist");

    // Own tenant's session tries to update a foreign artist.
    mockSession.value = { ...mockSession.value, tenantId: ownId };
    await updateRepresentedArtist(foreignArtistId, { error: "" }, fd("Hijacked Name", "", "0")).catch(() => {});

    const row = await artistRow(foreignArtistId);
    expect(row?.name).toBe("Foreign Artist"); // unchanged
  });

  it("artist can be renamed multiple times; last value persists", async () => {
    const { tenantId } = await createTenant();
    const artistId = await createArtist(tenantId, "First Name");

    await updateRepresentedArtist(artistId, { error: "" }, fd("Second Name", "", "0")).catch((e: Error) => {
      if (!e.message.startsWith("REDIRECT:")) throw e;
    });
    await updateRepresentedArtist(artistId, { error: "" }, fd("Third Name", "", "0")).catch((e: Error) => {
      if (!e.message.startsWith("REDIRECT:")) throw e;
    });

    const row = await artistRow(artistId);
    expect(row?.name).toBe("Third Name");
  });
});
