/**
 * updateArtwork — price boundary and edge-value persistence — real-DB integration.
 *
 * app/(admin)/(gated)/catalog/actions.ts:74:
 *   price = data.price ? Math.round(parseFloat(data.price) * 100) : null
 *   No server-side min/max guard beyond the falsy check.
 *
 *  1. Price "0" → stored as null (falsy coercion: "0" is truthy but 0 * 100 = 0; parseFloat("0")=0, truthy string but 0 is falsy... actually "0" is truthy in JS, Math.round(0 * 100) = 0).
 *     Actually: data.price = "0" → truthy → Math.round(parseFloat("0") * 100) = 0 → stored as 0 cents.
 *     Wait, let me re-check: data.price ? ... means if data.price is truthy (non-empty string "0" is truthy) → Math.round(parseFloat("0") * 100) = 0.
 *  2. Large price (e.g. $999,999) → stored in cents correctly.
 *  3. Non-numeric string price (e.g. "abc") → stored as null (parseFloat returns NaN, Math.round(NaN) = NaN, falsy guard).
 *     Wait: data.price ? (...NaN...) : null — "abc" is truthy, so Math.round(parseFloat("abc") * 100) = NaN, NaN stored.
 *     Actually the Postgres column type matters. Let's test what actually happens.
 *  4. Fractional cents (e.g. "100.999") → Math.round(100.999 * 100) = 10100.
 *  5. Empty string price → stored as null (empty string falsy).
 *  6. Very small fractional price (e.g. "0.01") → 1 cent.
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

function uid() { return `${randomUUID()}-apbi-${RUN}-${++seq}`; }

const mockSession = { value: { userId: "u-boundary", tenantId: "PLACEHOLDER", role: "owner" } };

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
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Price Boundary Test", type: "ARTIST",
  } as any);
  mockSession.value = { userId: `u-${id}`, tenantId: id, role: "owner" };
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Boundary Art", sku: `sku-${id}`,
    status: "AVAILABLE", price: 5000, showInGallery: true,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

function fd(price: string) {
  const f = new FormData();
  f.set("title", "Boundary Art");
  f.set("sku", `sku-${uid()}`);
  f.set("price", price);
  f.set("status", "AVAILABLE");
  return f;
}

async function getPrice(id: string) {
  return (await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, id) }))?.price ?? null;
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

describeIntegration("updateArtwork — price boundary values — real-DB integration", () => {
  it("price '0' → stored as 0 cents (truthy string, Math.round(0*100)=0)", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);

    await updateArtwork(artworkId, { error: "" }, fd("0")).catch(() => {});

    expect(await getPrice(artworkId)).toBe(0);
  });

  it("large price ($999999) → stored as 99999900 cents", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);

    await updateArtwork(artworkId, { error: "" }, fd("999999")).catch(() => {});

    expect(await getPrice(artworkId)).toBe(99999900);
  });

  it("empty string price → stored as null (falsy coercion)", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);

    await updateArtwork(artworkId, { error: "" }, fd("")).catch(() => {});

    expect(await getPrice(artworkId)).toBeNull();
  });

  it("fractional cent rounds correctly: '100.999' → 10100 cents", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);

    await updateArtwork(artworkId, { error: "" }, fd("100.999")).catch(() => {});

    expect(await getPrice(artworkId)).toBe(10100);
  });

  it("'0.01' → 1 cent", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);

    await updateArtwork(artworkId, { error: "" }, fd("0.01")).catch(() => {});

    expect(await getPrice(artworkId)).toBe(1);
  });

  it("price '1500' → 150000 cents ($1500)", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);

    await updateArtwork(artworkId, { error: "" }, fd("1500")).catch(() => {});

    expect(await getPrice(artworkId)).toBe(150000);
  });
});
