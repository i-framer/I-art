/**
 * Represented artist CRUD actions — real-DB integration.
 *
 * Unit tests (artist-actions.test.ts) verify the logic with a mocked DB.
 * This integration suite verifies persistence and tenant-isolation invariants
 * against real PostgreSQL:
 *
 *  createRepresentedArtist:
 *   1. Inserts a row with correct tenantId/name/bio/commissionPct.
 *   2. Returns { error: "" , success: true }.
 *   3. Empty bio is stored as NULL.
 *   4. Foreign session cannot read another tenant's data (billing check scoped
 *      to session tenant, artist is created under session tenant).
 *
 *  updateRepresentedArtist:
 *   5. Updates name/bio/commissionPct for the correct row.
 *   6. A foreign tenant's artistId is silently not updated (tenant-scoped WHERE).
 *
 *  deleteRepresentedArtist:
 *   7. Deletes an artist with no linked artworks.
 *   8. Returns an error when artworks are linked — does NOT delete.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable, representedArtistsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Auth ──────────────────────────────────────────────────────────────────────
const mockTenantId = { value: "PLACEHOLDER" };
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ userId: "u-artist", tenantId: mockTenantId.value })),
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
  createRepresentedArtist,
  updateRepresentedArtist,
  deleteRepresentedArtist,
} from "@/app/(admin)/(gated)/catalog/artists/actions";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdArtistIds: string[] = [];

function uid() {
  return `${randomUUID()}-art-${RUN}-${++seq}`;
}

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id,
    businessName: "Artist CRUD Test Gallery",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: "active",
  } as any);
  createdTenantIds.push(id);
  mockTenantId.value = id;
  return id;
}

async function insertArtist(tenantId: string, name = "Test Artist") {
  const id = uid();
  await db.insert(representedArtistsTable).values({
    id, tenantId, name, bio: null, commissionPct: 0,
  } as any);
  createdArtistIds.push(id);
  return id;
}

async function insertArtwork(tenantId: string, artistId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId,
    representedArtistId: artistId,
    title: "Linked Artwork", sku: `sku-${id}`,
    status: "AVAILABLE", showInGallery: true,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function cleanup() {
  for (const id of createdArtworkIds.splice(0)) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdArtistIds.splice(0)) {
    await db.delete(representedArtistsTable)
      .where(eq(representedArtistsTable.id, id))
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

describeIntegration("Represented artist CRUD — real-DB integration", () => {
  // ── createRepresentedArtist ────────────────────────────────────────────────

  it("creates an artist row with correct fields and returns success", async () => {
    const tenantId = await createTenant();

    const result = await createRepresentedArtist(
      null as unknown as import("@/app/(admin)/(gated)/catalog/artists/actions").ArtistState,
      fd({ name: "Maria Nguyen", bio: "Watercolour specialist", commissionPct: "15" }),
    );

    expect(result.error).toBe("");
    expect(result.success).toBe(true);

    const row = await db.query.representedArtistsTable.findFirst({
      where: eq(representedArtistsTable.tenantId, tenantId),
    });
    expect(row).toBeDefined();
    expect(row?.name).toBe("Maria Nguyen");
    expect(row?.bio).toBe("Watercolour specialist");
    expect(row?.commissionPct).toBe(15);
    expect(row?.tenantId).toBe(tenantId);

    if (row?.id) createdArtistIds.push(row.id);
  });

  it("stores NULL bio when bio field is empty", async () => {
    const tenantId = await createTenant();

    const result = await createRepresentedArtist(
      null as unknown as import("@/app/(admin)/(gated)/catalog/artists/actions").ArtistState,
      fd({ name: "Anonymous", bio: "", commissionPct: "0" }),
    );
    expect(result.error).toBe("");

    const row = await db.query.representedArtistsTable.findFirst({
      where: eq(representedArtistsTable.tenantId, tenantId),
    });
    expect(row?.bio).toBeNull();
    if (row?.id) createdArtistIds.push(row.id);
  });

  // ── updateRepresentedArtist ────────────────────────────────────────────────

  it("updates name, bio, and commissionPct for the artist", async () => {
    const tenantId = await createTenant();
    const artistId = await insertArtist(tenantId, "Old Name");

    const result = await updateRepresentedArtist(
      artistId,
      null as unknown as import("@/app/(admin)/(gated)/catalog/artists/actions").ArtistState,
      fd({ name: "New Name", bio: "Updated bio", commissionPct: "25" }),
    );

    expect(result.error).toBe("");

    const row = await db.query.representedArtistsTable.findFirst({
      where: eq(representedArtistsTable.id, artistId),
    });
    expect(row?.name).toBe("New Name");
    expect(row?.bio).toBe("Updated bio");
    expect(row?.commissionPct).toBe(25);
  });

  it("does NOT update a foreign tenant's artist (silently no-ops)", async () => {
    const tenantA = await createTenant();
    const artistId = await insertArtist(tenantA, "Tenant A Artist");

    // Switch to tenant B.
    const tenantB = await createTenant();
    mockTenantId.value = tenantB;

    await updateRepresentedArtist(
      artistId,
      null as unknown as import("@/app/(admin)/(gated)/catalog/artists/actions").ArtistState,
      fd({ name: "Hijacked Name", bio: "", commissionPct: "0" }),
    );

    const row = await db.query.representedArtistsTable.findFirst({
      where: eq(representedArtistsTable.id, artistId),
    });
    // Name must be unchanged — tenant-scoped WHERE matched zero rows.
    expect(row?.name).toBe("Tenant A Artist");
  });

  // ── deleteRepresentedArtist ────────────────────────────────────────────────

  it("deletes an artist with no linked artworks", async () => {
    const tenantId = await createTenant();
    const artistId = await insertArtist(tenantId, "To Be Deleted");

    const result = await deleteRepresentedArtist(artistId);

    expect(result.error).toBe("");

    const row = await db.query.representedArtistsTable.findFirst({
      where: eq(representedArtistsTable.id, artistId),
    });
    expect(row).toBeUndefined();
    // Remove from cleanup list since it was deleted.
    const idx = createdArtistIds.indexOf(artistId);
    if (idx !== -1) createdArtistIds.splice(idx, 1);
  });

  it("returns an error and does NOT delete when artworks are linked", async () => {
    const tenantId = await createTenant();
    const artistId = await insertArtist(tenantId, "Artist With Artworks");
    await insertArtwork(tenantId, artistId);

    const result = await deleteRepresentedArtist(artistId);

    expect(result.error).toMatch(/\d+ artwork/i);

    // Artist row must still exist.
    const row = await db.query.representedArtistsTable.findFirst({
      where: eq(representedArtistsTable.id, artistId),
    });
    expect(row).toBeDefined();
  });

  it("cannot delete a foreign tenant's artist even if that artist has no local linked artworks", async () => {
    // Own tenant has no artworks linked to the foreign artist.
    const ownTenantId = await createTenant();
    const foreignTenantId = await createTenant();
    const foreignArtistId = await insertArtist(foreignTenantId, "Foreign Artist Unlinked");

    // Authenticated as ownTenant — should not delete the foreign artist.
    mockTenantId.value = ownTenantId;
    const _result = await deleteRepresentedArtist(foreignArtistId);

    // The action should succeed silently or report an error — but critically
    // the foreign artist row must still exist.
    const row = await db.query.representedArtistsTable.findFirst({
      where: eq(representedArtistsTable.id, foreignArtistId),
    });
    expect(row).toBeDefined(); // NOT deleted
  });
});
