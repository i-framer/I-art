/**
 * createArtwork / updateArtwork / deleteArtwork — real-DB integration.
 *
 * Unit tests (artwork-actions-tenant-scope.test.ts) verify tenant isolation
 * with mocked DB.  This integration suite verifies DB persistence and
 * tenant-isolation invariants against real PostgreSQL:
 *
 * createArtwork:
 *  1. Inserts an artwork row with required fields and returns redirect.
 *  2. Stores nullable fields correctly (price, medium, notes → NULL when empty).
 *  3. Rejects a non-existent representedArtistId.
 *
 * updateArtwork:
 *  4. Persists changed title, sku, status, and price.
 *  5. Returns error for a foreign-tenant artworkId — row unchanged.
 *
 * deleteArtwork:
 *  6. Removes the artwork row.
 *  7. Silently ignores a foreign-tenant artworkId (tenant-scoped WHERE).
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable, representedArtistsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Auth ──────────────────────────────────────────────────────────────────────
const mockTenantId = { value: "PLACEHOLDER" };
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ userId: "u-artwork-crud", tenantId: mockTenantId.value })),
}));
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
  hasActiveAccess: () => true,
}));

// ── Object storage — no-op (images not tested here) ──────────────────────────
vi.mock("@/lib/object-storage", () => ({
  deleteObject: vi.fn(async () => {}),
  getServeUrl: vi.fn(async () => "https://img.example/test"),
  StorageNotConfiguredError: class extends Error {},
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

import {
  createArtwork,
  updateArtwork,
  deleteArtwork,
} from "@/app/(admin)/(gated)/catalog/actions";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtistIds: string[] = [];
const createdArtworkIds: string[] = [];

function uid() {
  return `${randomUUID()}-aw-${RUN}-${++seq}`;
}

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id,
    businessName: "Artwork CRUD Test Gallery",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: "active",
  } as any);
  createdTenantIds.push(id);
  mockTenantId.value = id;
  return id;
}

async function insertArtist(tenantId: string) {
  const id = uid();
  await db.insert(representedArtistsTable).values({
    id, tenantId, name: "Test Artist", commissionPct: 0,
  } as any);
  createdArtistIds.push(id);
  return id;
}

async function insertArtwork(tenantId: string, status = "AVAILABLE") {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Existing", sku: `sku-${id}`,
    status, showInGallery: true,
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
      .where(eq(representedArtistsTable.id, id)).catch(() => {});
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

describeIntegration("Artwork CRUD — real-DB integration", () => {
  // ── createArtwork ─────────────────────────────────────────────────────────

  it("createArtwork: inserts an artwork row and redirects", async () => {
    await createTenant();

    await expect(
      createArtwork(
        {},
        fd({
          title: "Blue Mountain",
          sku: `SKU-${uid()}`,
          status: "AVAILABLE",
          showInGallery: "on",
          price: "350",
        }),
      ),
    ).rejects.toThrow("REDIRECT:/catalog/");

    // The row was inserted — find it by tenant.
    const row = await db.query.artworksTable.findFirst({
      where: eq(artworksTable.tenantId, mockTenantId.value),
    });
    expect(row).toBeDefined();
    expect(row?.title).toBe("Blue Mountain");
    expect(row?.price).toBe(35000); // $350 → cents
    if (row?.id) createdArtworkIds.push(row.id);
  });

  it("createArtwork: stores NULL for empty optional fields", async () => {
    await createTenant();

    await expect(
      createArtwork(
        {},
        fd({
          title: "Minimal Artwork",
          sku: `SKU-${uid()}`,
          status: "HIDDEN",
          // medium, notes, price intentionally omitted
        }),
      ),
    ).rejects.toThrow("REDIRECT:");

    const row = await db.query.artworksTable.findFirst({
      where: eq(artworksTable.tenantId, mockTenantId.value),
    });
    expect(row?.medium).toBeNull();
    expect(row?.price).toBeNull();
    if (row?.id) createdArtworkIds.push(row.id);
  });

  it("createArtwork: returns error for a non-existent representedArtistId", async () => {
    await createTenant();

    const result = await createArtwork(
      {},
      fd({
        title: "Ghost Artist",
        sku: `SKU-${uid()}`,
        status: "AVAILABLE",
        representedArtistId: randomUUID(), // does not exist
      }),
    );

    expect(result.error).toMatch(/artist not found/i);
    // No artwork inserted.
    const row = await db.query.artworksTable.findFirst({
      where: eq(artworksTable.tenantId, mockTenantId.value),
    });
    expect(row).toBeUndefined();
  });

  // ── updateArtwork ─────────────────────────────────────────────────────────

  it("updateArtwork: persists changed title, status, and price", async () => {
    const tenantId = await createTenant();
    const artworkId = await insertArtwork(tenantId, "AVAILABLE");

    await expect(
      updateArtwork(
        artworkId,
        {},
        fd({
          title: "Updated Title",
          sku: "NEW-SKU-UPDATED",
          status: "SOLD",
          price: "500",
        }),
      ),
    ).rejects.toThrow("REDIRECT:");

    const row = await db.query.artworksTable.findFirst({
      where: eq(artworksTable.id, artworkId),
    });
    expect(row?.title).toBe("Updated Title");
    expect(row?.status).toBe("SOLD");
    expect(row?.price).toBe(50000);
  });

  it("updateArtwork: returns error for a foreign tenant's artworkId — row unchanged", async () => {
    const tenantA = await createTenant();
    const artworkId = await insertArtwork(tenantA, "AVAILABLE");

    // Switch to tenant B.
    const tenantB = await createTenant();
    mockTenantId.value = tenantB;

    const result = await updateArtwork(
      artworkId,
      {},
      fd({ title: "Hacked", sku: "HACKED-SKU", status: "HIDDEN" }),
    );

    expect(result.error).toMatch(/artwork not found/i);

    const row = await db.query.artworksTable.findFirst({
      where: eq(artworksTable.id, artworkId),
    });
    expect(row?.title).toBe("Existing");
  });

  // ── deleteArtwork ─────────────────────────────────────────────────────────

  it("deleteArtwork: removes the artwork row", async () => {
    const tenantId = await createTenant();
    const artworkId = await insertArtwork(tenantId);

    await deleteArtwork(artworkId);

    const row = await db.query.artworksTable.findFirst({
      where: eq(artworksTable.id, artworkId),
    });
    expect(row).toBeUndefined();
    // Remove from cleanup list — already deleted.
    const idx = createdArtworkIds.indexOf(artworkId);
    if (idx !== -1) createdArtworkIds.splice(idx, 1);
  });

  it("deleteArtwork: silently no-ops for a foreign tenant's artworkId", async () => {
    const tenantA = await createTenant();
    const artworkId = await insertArtwork(tenantA);

    // Switch to tenant B.
    const tenantB = await createTenant();
    mockTenantId.value = tenantB;

    await deleteArtwork(artworkId); // should not throw

    // The original row still exists.
    const row = await db.query.artworksTable.findFirst({
      where: eq(artworksTable.id, artworkId),
    });
    expect(row).toBeDefined();
  });

  // ── Form validation (createArtwork / updateArtwork) ───────────────────────

  it("createArtwork: returns error when title is blank; no row written", async () => {
    const tenantId = await createTenant();

    const result = await createArtwork(
      { error: "" },
      fd({ title: "", sku: "SKU-001", status: "AVAILABLE" }),
    );

    expect(result).toMatchObject({ error: expect.stringMatching(/title/i) });

    // No artwork should have been written.
    const rows = await db.query.artworksTable.findMany({
      where: eq(artworksTable.tenantId, tenantId),
    });
    expect(rows).toHaveLength(0);
  });

  it("createArtwork: returns error when SKU is blank; no row written", async () => {
    const tenantId = await createTenant();

    const result = await createArtwork(
      { error: "" },
      fd({ title: "Valid Title", sku: "", status: "AVAILABLE" }),
    );

    expect(result).toMatchObject({ error: expect.stringMatching(/sku/i) });

    const rows = await db.query.artworksTable.findMany({
      where: eq(artworksTable.tenantId, tenantId),
    });
    expect(rows).toHaveLength(0);
  });

  it("createArtwork: returns error when status is invalid; no row written", async () => {
    const tenantId = await createTenant();

    const result = await createArtwork(
      { error: "" },
      fd({ title: "Valid Title", sku: "SKU-002", status: "BOGUS" }),
    );

    expect(result).toMatchObject({ error: expect.any(String) });

    const rows = await db.query.artworksTable.findMany({
      where: eq(artworksTable.tenantId, tenantId),
    });
    expect(rows).toHaveLength(0);
  });

  it("createArtwork: returns error when condition is invalid; no row written", async () => {
    const tenantId = await createTenant();

    const result = await createArtwork(
      { error: "" },
      fd({ title: "Valid Title", sku: "SKU-003", status: "AVAILABLE", condition: "MINT" }),
    );

    expect(result).toMatchObject({ error: expect.any(String) });

    const rows = await db.query.artworksTable.findMany({
      where: eq(artworksTable.tenantId, tenantId),
    });
    expect(rows).toHaveLength(0);
  });

  it("updateArtwork: returns error when title is blank; existing row unchanged", async () => {
    const tenantId = await createTenant();
    const artworkId = await insertArtwork(tenantId);

    const result = await updateArtwork(
      artworkId,
      { error: "" },
      fd({ title: "", sku: "SKU-NEW", status: "AVAILABLE" }),
    );

    expect(result).toMatchObject({ error: expect.stringMatching(/title/i) });

    // Original row should still have the old title.
    const row = await db.query.artworksTable.findFirst({
      where: eq(artworksTable.id, artworkId),
    });
    expect(row?.title).toBe("Existing");
  });
});
