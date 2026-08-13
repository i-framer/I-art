/**
 * Checkout route — stripeChargesEnabled=false gate — real-DB integration.
 *
 * app/api/stripe/checkout/route.ts:83-89:
 *   tenant.stripeChargesEnabled === false → 503 (store payments unavailable).
 *
 *  1. stripeChargesEnabled=false → checkout returns 503.
 *  2. Artwork remains AVAILABLE when charges disabled checkout is rejected.
 *  3. Stripe session is NOT created when charges are disabled.
 *  4. stripeChargesEnabled=true → checkout proceeds past this gate.
 *  5. stripeChargesEnabled=null (not set) → checkout returns 503 or similar error.
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

function uid() { return `${randomUUID()}-cscdi-${RUN}-${++seq}`; }

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

async function createTenant(stripeChargesEnabled: boolean | null) {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Charges Gate Test", type: "ARTIST",
    storefrontEnabled: true,
    stripeAccountId: `acct_test_${id}`,
    stripeChargesEnabled: stripeChargesEnabled,
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id, slug: id };
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Charges Gate Art", sku: `sku-${id}`,
    status: "AVAILABLE", price: 20000, showInGallery: true,
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

describeIntegration("Checkout stripeChargesEnabled=false gate — real-DB integration", () => {
  it("stripeChargesEnabled=false → checkout returns 503", async () => {
    const { slug, tenantId } = await createTenant(false);
    const artworkId = await createArtwork(tenantId);

    const res = await callCheckout(slug, artworkId);
    expect(res.status).toBe(503);
  });

  it("artwork remains AVAILABLE when charges-disabled checkout is rejected", async () => {
    const { slug, tenantId } = await createTenant(false);
    const artworkId = await createArtwork(tenantId);

    await callCheckout(slug, artworkId);

    expect(await artworkStatus(artworkId)).toBe("AVAILABLE");
  });

  it("Stripe session is NOT created when charges are disabled", async () => {
    mockStripeCreate.mockResolvedValue({ url: "https://stripe.test/checkout" });
    const { slug, tenantId } = await createTenant(false);
    const artworkId = await createArtwork(tenantId);

    await callCheckout(slug, artworkId);

    expect(mockStripeCreate).not.toHaveBeenCalled();
  });

  it("stripeChargesEnabled=true → checkout proceeds past this gate", async () => {
    mockStripeCreate.mockResolvedValue({ url: "https://stripe.test/checkout" });
    const { slug, tenantId } = await createTenant(true);
    const artworkId = await createArtwork(tenantId);

    const res = await callCheckout(slug, artworkId);

    expect(res.status).not.toBe(503);
  });

  it("stripeChargesEnabled=null → checkout returns 503 or similar (no charges configured)", async () => {
    const { slug, tenantId } = await createTenant(null);
    const artworkId = await createArtwork(tenantId);

    const res = await callCheckout(slug, artworkId);

    // null charges means payments not set up — expect a non-2xx response.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(600);
  });
});
