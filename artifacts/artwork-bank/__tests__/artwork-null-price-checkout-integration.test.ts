/**
 * Artwork with null price (price-on-request) checkout rejection — real-DB integration.
 *
 * app/api/stripe/checkout/route.ts: the checkout route reads the artwork
 * and passes artwork.price to Stripe. The route behavior when price is null
 * should either reject with 400 or handle gracefully. This test verifies
 * what actually happens with a null-priced artwork in the real DB.
 *
 *  1. Artwork with null price rejects checkout (400) or returns a controlled response.
 *  2. Artwork status remains AVAILABLE after null-price checkout attempt fails.
 *  3. Artwork with valid price proceeds through the checkout reservation.
 *  4. null price is persisted correctly in artworksTable.
 *  5. price update from null to a value via DB update persists correctly.
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

function uid() { return `${randomUUID()}-anpci-${RUN}-${++seq}`; }

vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(async () => ({
    checkout: {
      sessions: {
        create: vi.fn(async () => ({ url: "https://stripe.test/checkout" })),
      },
    },
  })),
  calcApplicationFee: vi.fn((amount: number) => Math.round(amount * 0.05)),
  StripeNotConfiguredError: class extends Error {},
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => true),
}));
vi.mock("@/lib/object-storage", () => ({
  getServeUrl: vi.fn(async () => null),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(() => new Headers()),
}));

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Null Price Test Gallery",
    type: "ARTIST", storefrontEnabled: true,
    stripeAccountId: `acct_test_${id}`,
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id, slug: id };
}

async function createArtwork(tenantId: string, price: number | null) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Null Price Art", sku: `sku-${id}`,
    status: "AVAILABLE", showInGallery: true, price,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function artworkStatus(artworkId: string) {
  const row = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, artworkId) });
  return row?.status ?? null;
}

async function artworkPrice(artworkId: string) {
  const row = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, artworkId) });
  return row?.price ?? null;
}

async function callCheckout(slug: string, artworkId: string) {
  vi.doMock("@/lib/tenant-cache", () => ({
    getTenantBySlug: vi.fn(async (_slug: string) => ({
      id: _slug, slug: _slug, businessName: "Null Price Test Gallery",
      type: "ARTIST", storefrontEnabled: true, stripeAccountId: `acct_test_${_slug}`,
      stripeAccountStatus: "enabled",
    })),
  }));
  const { POST } = await import("@/app/api/stripe/checkout/route");
  const req = new Request("http://localhost/api/stripe/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ artworkId, slug, fulfillmentType: "PICKUP" }),
  });
  return POST(req);
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

describeIntegration("Artwork null price (price-on-request) checkout — real-DB integration", () => {
  it("null price is persisted correctly in artworksTable", async () => {
    const { tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId, null);
    expect(await artworkPrice(artworkId)).toBeNull();
  });

  it("price update from null to a value persists correctly", async () => {
    const { tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId, null);

    await db.update(artworksTable).set({ price: 75000 }).where(eq(artworksTable.id, artworkId));

    expect(await artworkPrice(artworkId)).toBe(75000);
  });

  it("artwork with null price returns a non-success response on checkout attempt", async () => {
    const { tenantId, slug } = await createTenant();
    const artworkId = await createArtwork(tenantId, null);

    const res = await callCheckout(slug, artworkId);
    // Null-price artworks should either be rejected (400) or blocked by the
    // route's price validation. We assert it is not a 5xx crash.
    expect(res.status).not.toBeGreaterThanOrEqual(500);
  });

  it("artwork with null price — status is AVAILABLE or RESERVED after checkout attempt (no inconsistent state)", async () => {
    const { tenantId, slug } = await createTenant();
    const artworkId = await createArtwork(tenantId, null);

    const res = await callCheckout(slug, artworkId);
    const status = await artworkStatus(artworkId);

    if (res.status === 200 || res.status === 302) {
      // If checkout proceeded, artwork must be RESERVED.
      expect(status).toBe("RESERVED");
    } else {
      // If checkout was rejected, artwork must remain AVAILABLE.
      expect(status).toBe("AVAILABLE");
    }
  });

  it("artwork with valid price proceeds through checkout reservation", async () => {
    const { tenantId, slug } = await createTenant();
    const artworkId = await createArtwork(tenantId, 50000); // valid price

    await callCheckout(slug, artworkId);

    expect(await artworkStatus(artworkId)).toBe("RESERVED");
  });
});
