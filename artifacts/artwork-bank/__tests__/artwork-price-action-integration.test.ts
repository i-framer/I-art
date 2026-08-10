/**
 * updateArtwork action — price persistence — real-DB integration.
 *
 * app/(admin)/(gated)/catalog/actions.ts:142 + toInsertValues maps the
 * parsed form price into the artworksTable `price` column.
 *
 * This suite verifies that calling the action persists the new price:
 *
 *  1. New price is persisted via the updateArtwork action.
 *  2. Price update overwrites a previous value.
 *  3. Clearing price (empty) stores null.
 *  4. Price change does not alter the artwork title.
 *  5. Foreign tenant's artwork price cannot be updated via own session.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable, usersTable, tenantUsersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdUserIds: string[] = [];

function uid() { return `${randomUUID()}-apac-${RUN}-${++seq}`; }

const mockSession = { value: { userId: "u-price-test", tenantId: "PLACEHOLDER", role: "owner" } };

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
  await db.insert(usersTable).values({ id: userId, email: `user-${userId}@test.com`, passwordHash: "x" } as any);
  createdUserIds.push(userId);
  mockSession.value = { userId, tenantId: id, role: "owner" };
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Price Action Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  await db.insert(tenantUsersTable).values({ tenantId: id, userId, role: "owner" } as any);
  return { tenantId: id, userId };
}

async function createArtwork(tenantId: string, price?: number | null) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Price Action Test Art", sku: `sku-${id}`,
    status: "AVAILABLE", price: price ?? null,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

function fd(entries: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

async function artworkPrice(id: string) {
  const row = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, id) });
  return row?.price ?? null;
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

describeIntegration("updateArtwork action — price persistence — real-DB integration", () => {
  it("new price is persisted via the updateArtwork action", async () => {
    const { tenantId } = await createTenant();
    const id = await createArtwork(tenantId, null);

    await updateArtwork(id, { error: "" } as import("@/app/(admin)/(gated)/catalog/actions").ArtworkFormState, fd({
      title: "Price Action Test Art", sku: `sku-${id}`, status: "AVAILABLE",
      price: "450",
    })).catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    expect(await artworkPrice(id)).toBe(45000); // stored in cents
  });

  it("price update overwrites a previous value", async () => {
    const { tenantId } = await createTenant();
    const id = await createArtwork(tenantId, 200);

    await updateArtwork(id, { error: "" } as import("@/app/(admin)/(gated)/catalog/actions").ArtworkFormState, fd({
      title: "Price Action Test Art", sku: `sku-${id}`, status: "AVAILABLE",
      price: "750",
    })).catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    expect(await artworkPrice(id)).toBe(75000); // stored in cents
  });

  it("clearing price (empty string) stores null", async () => {
    const { tenantId } = await createTenant();
    const id = await createArtwork(tenantId, 300);

    await updateArtwork(id, { error: "" } as import("@/app/(admin)/(gated)/catalog/actions").ArtworkFormState, fd({
      title: "Price Action Test Art", sku: `sku-${id}`, status: "AVAILABLE",
      price: "",
    })).catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    expect(await artworkPrice(id)).toBeNull();
  });

  it("price change does not alter the artwork title", async () => {
    const { tenantId } = await createTenant();
    const id = await createArtwork(tenantId, 100);

    await updateArtwork(id, { error: "" } as import("@/app/(admin)/(gated)/catalog/actions").ArtworkFormState, fd({
      title: "Stable Title Art", sku: `sku-${id}`, status: "AVAILABLE",
      price: "999",
    })).catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const row = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, id) });
    expect(row?.price).toBe(99900); // stored in cents
    expect(row?.title).toBe("Stable Title Art");
  });

  it("foreign tenant artwork price cannot be updated via own session", async () => {
    const { tenantId: _ownTenantId } = await createTenant();

    const foreignTenantId = uid();
    await db.insert(tenantsTable).values({
      id: foreignTenantId, slug: foreignTenantId,
      businessName: "Foreign Price Gallery", type: "ARTIST",
    } as any);
    createdTenantIds.push(foreignTenantId);
    const foreignId = uid();
    await db.insert(artworksTable).values({
      id: foreignId, tenantId: foreignTenantId, title: "Foreign Art",
      sku: `sku-${foreignId}`, status: "AVAILABLE", price: 500,
    } as any);
    createdArtworkIds.push(foreignId);

    const result = await updateArtwork(foreignId, { error: "" } as import("@/app/(admin)/(gated)/catalog/actions").ArtworkFormState, fd({
      title: "Foreign Art", sku: `sku-${foreignId}`, status: "AVAILABLE",
      price: "1",
    }));

    expect(result).toEqual({ error: "Artwork not found." });
    expect(await artworkPrice(foreignId)).toBe(500);
  });
});
