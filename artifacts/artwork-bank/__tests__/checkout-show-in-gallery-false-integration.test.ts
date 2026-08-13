/**
 * Checkout route — showInGallery=false artwork rejection — real-DB integration.
 *
 * app/api/stripe/checkout/route.ts: atomic update WHERE status=AVAILABLE AND showInGallery=true.
 * An artwork that is AVAILABLE but showInGallery=false must be rejected.
 *
 *  1. AVAILABLE artwork with showInGallery=false → checkout returns 400.
 *  2. Artwork remains AVAILABLE after rejected checkout (not set to RESERVED).
 *  3. Stripe session is NOT created when showInGallery=false.
 *  4. AVAILABLE artwork with showInGallery=true → checkout proceeds.
 *  5. Artwork changes from showInGallery=false to =true → checkout now succeeds.
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

function uid() { return `${randomUUID()}-csigl-${RUN}-${++seq}`; }

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
  calcApplicationFeeForTenant: vi.fn().mockReturnValue({ feeCents: 500, commissionBasisPoints: 500 }),
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
    id, slug: id, businessName: "ShowInGallery Test Gallery",
    type: "ARTIST", storefrontEnabled: true,
    stripeAccountId: `acct_test_${id}`,
    stripeChargesEnabled: true,
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id, slug: id };
}

async function createArtwork(tenantId: string, showInGallery: boolean) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "SIG Art", sku: `sku-${id}`,
    status: "AVAILABLE", price: 20000, showInGallery,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function callCheckout(slug: string, artworkId: string) {
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

describeIntegration("Checkout showInGallery=false rejection — real-DB integration", () => {
  it("AVAILABLE artwork with showInGallery=false → checkout returns 400", async () => {
    const { slug, tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId, false);

    const res = await callCheckout(slug, artworkId);
    expect(res.status).toBe(400);
  });

  it("artwork remains AVAILABLE after rejected checkout (showInGallery=false)", async () => {
    const { slug, tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId, false);

    await callCheckout(slug, artworkId);

    expect(await artworkStatus(artworkId)).toBe("AVAILABLE");
  });

  it("Stripe session is NOT created when showInGallery=false", async () => {
    mockStripeCreate.mockResolvedValue({ url: "https://stripe.test/checkout" });
    const { slug, tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId, false);

    await callCheckout(slug, artworkId);

    expect(mockStripeCreate).not.toHaveBeenCalled();
  });

  it("AVAILABLE artwork with showInGallery=true → checkout proceeds (not 400)", async () => {
    mockStripeCreate.mockResolvedValue({ url: "https://stripe.test/checkout" });
    const { slug, tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId, true);

    const res = await callCheckout(slug, artworkId);
    expect(res.status).not.toBe(400);
  });

  it("after updating showInGallery=false → =true, checkout now succeeds", async () => {
    mockStripeCreate.mockResolvedValue({ url: "https://stripe.test/checkout" });
    const { slug, tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId, false);

    // First attempt fails.
    expect((await callCheckout(slug, artworkId)).status).toBe(400);
    // Update to showInGallery=true.
    await db.update(artworksTable).set({ showInGallery: true }).where(eq(artworksTable.id, artworkId));
    // Second attempt succeeds.
    const res2 = await callCheckout(slug, artworkId);
    expect(res2.status).not.toBe(400);
  });
});
