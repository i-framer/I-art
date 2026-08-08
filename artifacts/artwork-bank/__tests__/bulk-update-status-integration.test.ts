/**
 * bulkUpdateStatus — real-DB integration.
 *
 * Unit/scope coverage exists in artwork-actions-tenant-scope.test.ts.
 * This integration suite verifies persistence and isolation invariants
 * against real PostgreSQL:
 *
 *  1. Updates status and updatedAt for all supplied IDs owned by the session
 *     tenant.
 *  2. A foreign tenant's artworkId in the list is silently skipped — its row
 *     is unchanged.
 *  3. Nonexistent IDs do not cause an error and don't affect other rows.
 *  4. Empty ID list performs no DB writes (early return).
 *  5. All four valid statuses (AVAILABLE, SOLD, RESERVED, HIDDEN) round-trip
 *     correctly.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Auth ──────────────────────────────────────────────────────────────────────
const mockTenantId = { value: "PLACEHOLDER" };
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ userId: "u-bulk-status", tenantId: mockTenantId.value })),
}));
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
  hasActiveAccess: () => true,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

import { bulkUpdateStatus } from "@/app/(admin)/(gated)/catalog/actions";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];

function uid() {
  return `${randomUUID()}-blk-${RUN}-${++seq}`;
}

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "BulkStatus Test Gallery",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: "active",
  } as any);
  createdTenantIds.push(id);
  mockTenantId.value = id;
  return id;
}

async function createArtwork(tenantId: string, status: string = "AVAILABLE") {
  const id = uid();
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test",
    sku: `sku-${id}`,
    status,
    showInGallery: true,
  } as any);
  createdArtworkIds.push(id);
  return id;
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
  it("updates status and updatedAt for all supplied IDs owned by the session tenant", async () => {
    const tenantId = await createTenant();
    const id1 = await createArtwork(tenantId, "AVAILABLE");
    const id2 = await createArtwork(tenantId, "AVAILABLE");

    const before = new Date();
    await bulkUpdateStatus([id1, id2], "SOLD");

    const rows = await db
      .select({ id: artworksTable.id, status: artworksTable.status, updatedAt: artworksTable.updatedAt })
      .from(artworksTable)
      .where(eq(artworksTable.tenantId, tenantId));

    for (const row of rows) {
      expect(row.status).toBe("SOLD");
      expect(new Date(row.updatedAt).getTime()).toBeGreaterThanOrEqual(before.getTime());
    }
  });

  it("silently skips a foreign tenant's artworkId — that row is unchanged", async () => {
    const tenantA = await createTenant();
    const foreignId = await createArtwork(tenantA, "AVAILABLE");

    // Switch to tenant B.
    const tenantB = await createTenant();
    mockTenantId.value = tenantB;

    const ownId = await createArtwork(tenantB, "AVAILABLE");

    await bulkUpdateStatus([ownId, foreignId], "HIDDEN");

    const ownRow = await db.query.artworksTable.findFirst({
      where: eq(artworksTable.id, ownId),
    });
    expect(ownRow?.status).toBe("HIDDEN");

    const foreignRow = await db.query.artworksTable.findFirst({
      where: eq(artworksTable.id, foreignId),
    });
    expect(foreignRow?.status).toBe("AVAILABLE"); // unchanged
  });

  it("nonexistent IDs in the list do not cause an error", async () => {
    const tenantId = await createTenant();
    const id = await createArtwork(tenantId, "AVAILABLE");

    await expect(
      bulkUpdateStatus([id, randomUUID(), randomUUID()], "RESERVED"),
    ).resolves.toBeUndefined();

    const row = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, id) });
    expect(row?.status).toBe("RESERVED");
  });

  it("empty ID list performs no DB writes (early return)", async () => {
    const tenantId = await createTenant();
    const id = await createArtwork(tenantId, "AVAILABLE");

    await bulkUpdateStatus([], "SOLD");

    const row = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, id) });
    expect(row?.status).toBe("AVAILABLE"); // unchanged
  });

  it.each([
    ["AVAILABLE"],
    ["SOLD"],
    ["RESERVED"],
    ["HIDDEN"],
  ] as const)("status=%s round-trips correctly", async (status) => {
    const tenantId = await createTenant();
    const id = await createArtwork(tenantId, "AVAILABLE");

    await bulkUpdateStatus([id], status);

    const row = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, id) });
    expect(row?.status).toBe(status);
  });
});
