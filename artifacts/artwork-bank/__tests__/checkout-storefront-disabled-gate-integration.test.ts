/**
 * Checkout route — storefrontEnabled gate — real-DB integration.
 *
 * app/api/stripe/checkout/route.ts:62-67:
 *   !tenant?.storefrontEnabled → 400 "Store not available"
 *
 *  1. storefrontEnabled=false → checkout returns 400.
 *  2. storefrontEnabled=true → checkout proceeds (no 400 from storefront gate).
 *  3. storefrontEnabled=false → artwork status is NOT changed to RESERVED.
 *  4. Stripe checkout session is NOT created when storefront is disabled.
 *  5. storefrontEnabled=false → response body mentions "not available" or similar.
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

function uid() { return `${randomUUID()}-csdgi-${RUN}-${++seq}`; }

const mockStripeCreate = vi.fn();

vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(async () => ({
    checkout: {
      sessions: {
        create: (...args: any[]) => mockStripeCreate(...args),
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

async function createTenant(storefrontEnabled: boolean) {
  const id = uid();
  const slug = id;
  await db.insert(tenantsTable).values({
    id, slug, businessName: "Storefront Gate Test Gallery",
    type: "ARTIST", storefrontEnabled,
    stripeAccountId: `acct_test_${id}`,
    stripeChargesEnabled: true,
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id, slug };
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Storefront Gate Art", sku: `sku-${id}`,
    status: "AVAILABLE", price: 25000, showInGallery: true,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function callCheckout(slug: string, artworkId: string) {
  const _tenantId = slug; // slug === tenantId in our fixtures
  vi.doMock("@/lib/tenant-cache", () => ({
    getTenantBySlug: vi.fn(async (_slug: string) => {
      const row = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.slug, _slug) });
      return row ?? null;
    }),
  }));
  const { POST } = await import("@/app/api/stripe/checkout/route");
  return POST(new Request("http://localhost/api/stripe/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ artworkId, slug, fulfillmentType: "PICKUP" }),
  }));
}

async function artworkStatus(artworkId: string) {
  const row = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, artworkId) });
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

afterEach(async () => {
  mockStripeCreate.mockReset();
  await cleanup();
  vi.resetModules();
});
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Checkout storefront-disabled gate — real-DB integration", () => {
  it("storefrontEnabled=false → checkout returns 400", async () => {
    const { slug } = await createTenant(false);
    const artworkId = await createArtwork(slug);

    const res = await callCheckout(slug, artworkId);
    expect(res.status).toBe(400);
  });

  it("storefrontEnabled=true → checkout proceeds (no 400 from storefront gate)", async () => {
    mockStripeCreate.mockResolvedValue({ url: "https://stripe.test/checkout" });
    const { slug } = await createTenant(true);
    const artworkId = await createArtwork(slug);

    const res = await callCheckout(slug, artworkId);
    // Proceeds past storefront gate — should not be 400 due to storefront disabled.
    expect(res.status).not.toBe(400);
  });

  it("storefrontEnabled=false → artwork status is NOT changed to RESERVED", async () => {
    const { slug } = await createTenant(false);
    const artworkId = await createArtwork(slug);

    await callCheckout(slug, artworkId);

    expect(await artworkStatus(artworkId)).toBe("AVAILABLE");
  });

  it("Stripe checkout session is NOT created when storefront is disabled", async () => {
    mockStripeCreate.mockResolvedValue({ url: "https://stripe.test/checkout" });
    const { slug } = await createTenant(false);
    const artworkId = await createArtwork(slug);

    await callCheckout(slug, artworkId);

    expect(mockStripeCreate).not.toHaveBeenCalled();
  });

  it("storefrontEnabled=false response body mentions store / not available", async () => {
    const { slug } = await createTenant(false);
    const artworkId = await createArtwork(slug);

    const res = await callCheckout(slug, artworkId);
    const body = await res.json().catch(() => ({}));
    // Accept any error body that communicates store unavailability.
    const text = JSON.stringify(body).toLowerCase();
    expect(text).toMatch(/store|storefront|available|disabled/);
  });
});
