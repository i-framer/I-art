/**
 * updateArtwork showInGallery toggle — real-DB integration.
 *
 * app/(admin)/(gated)/catalog/actions.ts: updateArtwork(id, _prevState, formData).
 * showInGallery field: checkbox "on" → true, absent → false.
 *
 *  1. showInGallery is cleared to false when field is not supplied.
 *  2. showInGallery is set to true when "on" is supplied.
 *  3. showInGallery is cleared to false when toggled off.
 *  4. showInGallery update is isolated to own tenant (foreign artwork blocked).
 *  5. showInGallery=false artworks are excluded from browse queries.
 *  6. showInGallery=true artworks appear in browse queries.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  usersTable,
  tenantUsersTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdUserIds: string[] = [];

function uid() { return `${randomUUID()}-sigti-${RUN}-${++seq}`; }

const mockSession = { value: { userId: "u-sig-toggle", tenantId: "PLACEHOLDER", role: "owner" } };

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
    id, slug: id, businessName: "ShowInGallery Toggle Test", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  await db.insert(tenantUsersTable).values({ tenantId: id, userId, role: "owner" } as any);
  return { tenantId: id };
}

async function createArtwork(tenantId: string, showInGallery = false) {
  const id = uid();
  const sku = `sku-${id}`;
  await db.insert(artworksTable).values({
    id, tenantId, title: "Gallery Toggle Art", sku,
    status: "AVAILABLE", showInGallery, price: 10000,
  } as any);
  createdArtworkIds.push(id);
  return { artworkId: id, sku };
}

/** Build FormData for updateArtwork. sku must match the row's actual SKU. */
function fd(sku: string, opts: { showInGallery?: boolean } = {}) {
  const f = new FormData();
  f.set("title", "Gallery Toggle Art");
  f.set("sku", sku);
  f.set("status", "AVAILABLE");
  f.set("price", "100");
  if (opts.showInGallery) f.set("showInGallery", "on");
  return f;
}

/** Call updateArtwork, swallowing the redirect it throws on success. */
async function callUpdate(artworkId: string, sku: string, opts: { showInGallery?: boolean } = {}) {
  await updateArtwork(artworkId, { error: "" }, fd(sku, opts)).catch((err: Error) => {
    if (!err.message.startsWith("REDIRECT:")) throw err;
  });
}

async function artworkRow(artworkId: string) {
  return db.query.artworksTable.findFirst({ where: eq(artworksTable.id, artworkId) });
}

async function cleanup() {
  for (const id of createdArtworkIds.splice(0)) {
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

describeIntegration("updateArtwork showInGallery toggle — real-DB integration", () => {
  it("showInGallery is cleared to false when field is not supplied", async () => {
    const { tenantId } = await createTenant();
    const { artworkId, sku } = await createArtwork(tenantId, true);

    await callUpdate(artworkId, sku, { showInGallery: false });

    const row = await artworkRow(artworkId);
    expect(row?.showInGallery).toBe(false);
  });

  it("showInGallery is set to true when 'on' is supplied", async () => {
    const { tenantId } = await createTenant();
    const { artworkId, sku } = await createArtwork(tenantId, false);

    await callUpdate(artworkId, sku, { showInGallery: true });

    const row = await artworkRow(artworkId);
    expect(row?.showInGallery).toBe(true);
  });

  it("showInGallery is cleared to false when toggled off", async () => {
    const { tenantId } = await createTenant();
    const { artworkId, sku } = await createArtwork(tenantId, true);

    // First ensure it's true in DB.
    let row = await artworkRow(artworkId);
    expect(row?.showInGallery).toBe(true);

    // Toggle off.
    await callUpdate(artworkId, sku, { showInGallery: false });

    row = await artworkRow(artworkId);
    expect(row?.showInGallery).toBe(false);
  });

  it("showInGallery update is isolated to own tenant (foreign artwork not updated)", async () => {
    const { tenantId: ownId }     = await createTenant();
    const { tenantId: foreignId } = await createTenant();
    const { artworkId: foreignArtworkId, sku: foreignSku } = await createArtwork(foreignId, false);

    // Authenticated as ownId, try to update foreignArtworkId.
    mockSession.value = { ...mockSession.value, tenantId: ownId };
    await callUpdate(foreignArtworkId, foreignSku, { showInGallery: true });

    // Foreign artwork must be unchanged.
    const row = await artworkRow(foreignArtworkId);
    expect(row?.showInGallery).toBe(false);
  });

  it("showInGallery=false artworks are excluded from browse query", async () => {
    const { tenantId } = await createTenant();
    const { artworkId } = await createArtwork(tenantId, false);

    const rows = await db.query.artworksTable.findMany({
      where: and(
        eq(artworksTable.tenantId, tenantId),
        eq(artworksTable.showInGallery, true),
      ),
    });
    expect(rows.find(r => r.id === artworkId)).toBeUndefined();
  });

  it("showInGallery=true artworks appear in browse query", async () => {
    const { tenantId } = await createTenant();
    const { artworkId } = await createArtwork(tenantId, true);

    const rows = await db.query.artworksTable.findMany({
      where: and(
        eq(artworksTable.tenantId, tenantId),
        eq(artworksTable.showInGallery, true),
      ),
    });
    expect(rows.find(r => r.id === artworkId)).toBeDefined();
  });
});
