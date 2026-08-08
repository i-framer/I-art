/**
 * bulkUpdateStatus — real-DB integration.
 *
 * app/(admin)/(gated)/catalog/actions.ts:233
 * Updates status for a list of artwork IDs scoped to the session tenant.
 *
 *  1. Sets HIDDEN for a list of own artworks.
 *  2. Sets AVAILABLE for a list that includes SOLD/HIDDEN artworks.
 *  3. Skips foreign-tenant artworks (tenant-scoped WHERE clause).
 *  4. Empty ID list is a no-op (early return without DB query).
 *  5. Duplicate IDs in the list do not cause errors.
 *  6. Mixed own+foreign IDs — only own artworks are updated.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];

function uid() { return `${randomUUID()}-abus-${RUN}-${++seq}`; }

// ── Auth / billing / next ────────────────────────────────────────────────────
const mockTenantId = { value: "PLACEHOLDER" };
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ userId: "u-bulk-status", tenantId: mockTenantId.value })),
}));
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
  hasActiveAccess: () => true,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/object-storage", () => ({
  deleteObject: vi.fn(async () => {}),
  getServeUrl: vi.fn(async () => "https://img.example/test"),
  StorageNotConfiguredError: class extends Error {},
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

import { bulkUpdateStatus } from "@/app/(admin)/(gated)/catalog/actions";

// ── DB helpers ───────────────────────────────────────────────────────────────
async function createTenant() {
  const id = uid();
  mockTenantId.value = id;
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Bulk Status Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function insertArtwork(tenantId: string, status: "AVAILABLE" | "SOLD" | "RESERVED" | "HIDDEN" = "AVAILABLE") {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Bulk Status Test", sku: `sku-${id}`, status,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function statusOf(id: string) {
  const row = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, id) });
  return row?.status;
}

async function cleanup() {
  for (const id of createdArtworkIds.splice(0)) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("bulkUpdateStatus — real-DB integration", () => {
  it("sets HIDDEN for a list of own artworks", async () => {
    const tenantId = await createTenant();
    const id1 = await insertArtwork(tenantId, "AVAILABLE");
    const id2 = await insertArtwork(tenantId, "SOLD");

    await bulkUpdateStatus([id1, id2], "HIDDEN");

    expect(await statusOf(id1)).toBe("HIDDEN");
    expect(await statusOf(id2)).toBe("HIDDEN");
  });

  it("sets AVAILABLE for SOLD and HIDDEN artworks", async () => {
    const tenantId = await createTenant();
    const soldId   = await insertArtwork(tenantId, "SOLD");
    const hiddenId = await insertArtwork(tenantId, "HIDDEN");

    await bulkUpdateStatus([soldId, hiddenId], "AVAILABLE");

    expect(await statusOf(soldId)).toBe("AVAILABLE");
    expect(await statusOf(hiddenId)).toBe("AVAILABLE");
  });

  it("skips foreign-tenant artworks — status unchanged", async () => {
    const ownTenantId     = await createTenant();
    const foreignTenantId = await createTenant();
    // Temporarily set session to foreign so we can insert foreign artwork.
    mockTenantId.value = foreignTenantId;
    const foreignId = await insertArtwork(foreignTenantId, "AVAILABLE");
    // Switch back to own tenant for the action.
    mockTenantId.value = ownTenantId;
    const ownId = await insertArtwork(ownTenantId, "AVAILABLE");

    await bulkUpdateStatus([ownId, foreignId], "HIDDEN");

    expect(await statusOf(ownId)).toBe("HIDDEN");         // updated
    expect(await statusOf(foreignId)).toBe("AVAILABLE");  // untouched (foreign)
  });

  it("empty ID list is a no-op — no DB error", async () => {
    const tenantId = await createTenant();
    const id = await insertArtwork(tenantId, "AVAILABLE");

    await bulkUpdateStatus([], "HIDDEN"); // must not throw

    expect(await statusOf(id)).toBe("AVAILABLE"); // unchanged
  });

  it("duplicate IDs in the list do not cause errors or double-update", async () => {
    const tenantId = await createTenant();
    const id = await insertArtwork(tenantId, "AVAILABLE");

    await expect(bulkUpdateStatus([id, id, id], "SOLD")).resolves.not.toThrow();

    expect(await statusOf(id)).toBe("SOLD");
  });

  it("mixed own+foreign IDs — only own artworks are updated", async () => {
    const ownTenantId     = await createTenant();
    const foreignTenantId = await createTenant();
    mockTenantId.value = foreignTenantId;
    const foreign1 = await insertArtwork(foreignTenantId, "AVAILABLE");
    const foreign2 = await insertArtwork(foreignTenantId, "SOLD");
    mockTenantId.value = ownTenantId;
    const own1 = await insertArtwork(ownTenantId, "AVAILABLE");
    const own2 = await insertArtwork(ownTenantId, "RESERVED");

    await bulkUpdateStatus([own1, own2, foreign1, foreign2], "HIDDEN");

    expect(await statusOf(own1)).toBe("HIDDEN");
    expect(await statusOf(own2)).toBe("HIDDEN");
    expect(await statusOf(foreign1)).toBe("AVAILABLE");
    expect(await statusOf(foreign2)).toBe("SOLD");
  });
});
