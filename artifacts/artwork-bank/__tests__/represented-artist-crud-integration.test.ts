/**
 * Represented artist create/delete lifecycle — real-DB integration.
 *
 * app/(admin)/(gated)/catalog/artists/actions.ts:
 *   createRepresentedArtist: validates name, inserts row with tenantId.
 *   deleteRepresentedArtist: guards against artworks linked; tenant-scoped delete.
 *
 *  1. createRepresentedArtist → row inserted with name/bio/commissionPct.
 *  2. createRepresentedArtist with missing name → error returned, no row.
 *  3. deleteRepresentedArtist with no linked artworks → row removed.
 *  4. deleteRepresentedArtist with linked artwork → returns error, row NOT deleted.
 *  5. deleteRepresentedArtist from another tenant's artist → no-op (tenant scope).
 *  6. createRepresentedArtist commissionPct persisted correctly.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db, tenantsTable, representedArtistsTable, artworksTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtistIds: string[] = [];
const createdArtworkIds: string[] = [];

function uid() { return `${randomUUID()}-racri-${RUN}-${++seq}`; }

const mockSession: { value: { userId: string; tenantId: string; role: string } } = {
  value: { userId: "u-artist", tenantId: "PLACEHOLDER", role: "owner" },
};
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => mockSession.value),
}));
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
}));

import {
  createRepresentedArtist,
  deleteRepresentedArtist,
} from "@/app/(admin)/(gated)/catalog/artists/actions";

function makeForm(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const INITIAL_STATE = { error: "" };

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Artist Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  mockSession.value = { userId: `u-${id}`, tenantId: id, role: "owner" };
  return id;
}

async function createArtist(tenantId: string) {
  const [row] = await db.insert(representedArtistsTable).values({
    tenantId, name: `Artist ${uid()}`,
  } as any).returning({ id: representedArtistsTable.id });
  const id = row!.id;
  createdArtistIds.push(id);
  return id;
}

async function createArtwork(tenantId: string, representedArtistId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, representedArtistId,
    title: "Linked Art", sku: `sku-${id}`,
    status: "AVAILABLE", price: 10000, showInGallery: true,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function cleanup() {
  for (const id of createdArtworkIds.splice(0)) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdArtistIds.splice(0)) {
    await db.delete(representedArtistsTable).where(eq(representedArtistsTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Represented artist create/delete lifecycle — real-DB integration", () => {
  it("createRepresentedArtist → row inserted with name/bio/commissionPct", async () => {
    const tenantId = await createTenant();
    const form = makeForm({ name: "Maria Santos", bio: "Oil painter", commissionPct: "15" });

    const result = await createRepresentedArtist(INITIAL_STATE, form);

    expect(result.error).toBe("");
    expect(result.success).toBe(true);
    const row = await db.query.representedArtistsTable.findFirst({
      where: eq(representedArtistsTable.tenantId, tenantId),
    });
    expect(row).not.toBeUndefined();
    createdArtistIds.push(row!.id); // track for cleanup
    expect(row?.name).toBe("Maria Santos");
    expect(row?.bio).toBe("Oil painter");
  });

  it("createRepresentedArtist with missing name → error returned, no row", async () => {
    const tenantId = await createTenant();
    const before = await db.query.representedArtistsTable.findMany({
      where: eq(representedArtistsTable.tenantId, tenantId),
    });
    const form = makeForm({ name: "" }); // empty name

    const result = await createRepresentedArtist(INITIAL_STATE, form);

    expect(result.error).not.toBe("");
    const after = await db.query.representedArtistsTable.findMany({
      where: eq(representedArtistsTable.tenantId, tenantId),
    });
    expect(after).toHaveLength(before.length);
  });

  it("deleteRepresentedArtist with no linked artworks → row removed", async () => {
    const tenantId = await createTenant();
    const artistId = await createArtist(tenantId);

    const result = await deleteRepresentedArtist(artistId);

    expect(result.error).toBe("");
    const row = await db.query.representedArtistsTable.findFirst({
      where: eq(representedArtistsTable.id, artistId),
    });
    expect(row).toBeUndefined();
  });

  it("deleteRepresentedArtist with linked artwork → returns error, row NOT deleted", async () => {
    const tenantId = await createTenant();
    const artistId = await createArtist(tenantId);
    await createArtwork(tenantId, artistId);

    const result = await deleteRepresentedArtist(artistId);

    expect(result.error).toMatch(/artwork|linked/i);
    const row = await db.query.representedArtistsTable.findFirst({
      where: eq(representedArtistsTable.id, artistId),
    });
    expect(row).not.toBeUndefined(); // not deleted
  });

  it("deleteRepresentedArtist from another tenant → no-op (tenant scope)", async () => {
    const tenantA = await createTenant();
    const artistId = await createArtist(tenantA);
    // Switch session to tenant B.
    const tenantB = await createTenant(); // sets mockSession.value.tenantId = tenantB
    mockSession.value = { userId: `u-${tenantB}`, tenantId: tenantB, role: "owner" };

    await deleteRepresentedArtist(artistId); // artist belongs to tenantA

    // Artist should still exist (different tenant scope).
    const row = await db.query.representedArtistsTable.findFirst({
      where: eq(representedArtistsTable.id, artistId),
    });
    expect(row).not.toBeUndefined();
  });

  it("createRepresentedArtist commissionPct persisted correctly", async () => {
    const tenantId = await createTenant();
    const form = makeForm({ name: "Fee Artist", commissionPct: "30" });

    await createRepresentedArtist(INITIAL_STATE, form);

    const row = await db.query.representedArtistsTable.findFirst({
      where: eq(representedArtistsTable.tenantId, tenantId),
    });
    createdArtistIds.push(row!.id);
    expect(row?.commissionPct).toBe(30);
  });
});
