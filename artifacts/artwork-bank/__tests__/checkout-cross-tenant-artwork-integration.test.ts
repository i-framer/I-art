/**
 * Checkout route — cross-tenant artwork (artwork from wrong tenant) — real-DB integration.
 *
 * app/api/stripe/checkout/route.ts:111-143:
 *   Atomically updates only where artworkId, tenantId from slug, AVAILABLE, showInGallery match.
 *   Mismatch (tenant B slug + tenant A artwork) → 400, no Stripe session, no reservation.
 *
 *  1. Wrong tenant slug + correct artworkId → 400.
 *  2. Artwork remains AVAILABLE when cross-tenant checkout fails.
 *  3. Stripe session is NOT created when cross-tenant checkout fails.
 *  4. Nonexistent tenant slug + valid artworkId → 400 or similar error.
 *  5. Correct tenant + correct artwork → checkout proceeds (not 400 from tenant check).
 *  6. Reverse: correct slug + artwork from different tenant → 400.
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

function uid() { return `${randomUUID()}-cctai-${RUN}-${++seq}`; }

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

async function createTenant(enabled = true) {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Cross Tenant Checkout Test",
    type: "ARTIST", storefrontEnabled: enabled,
    stripeAccountId: `acct_test_${id}`,
    stripeChargesEnabled: true,
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id, slug: id };
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Cross Tenant Art", sku: `sku-${id}`,
    status: "AVAILABLE", price: 30000, showInGallery: true,
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

describeIntegration("Checkout cross-tenant artwork — real-DB integration", () => {
  it("wrong tenant slug + correct artworkId → 400", async () => {
    const { tenantId: tenantA }     = await createTenant();
    const { slug: slugB }           = await createTenant();
    const artworkIdA = await createArtwork(tenantA);

    const res = await callCheckout(slugB, artworkIdA);
    expect(res.status).toBe(400);
  });

  it("artwork remains AVAILABLE when cross-tenant checkout fails", async () => {
    const { tenantId: tenantA }     = await createTenant();
    const { slug: slugB }           = await createTenant();
    const artworkIdA = await createArtwork(tenantA);

    await callCheckout(slugB, artworkIdA);

    expect(await artworkStatus(artworkIdA)).toBe("AVAILABLE");
  });

  it("Stripe session is NOT created when cross-tenant checkout fails", async () => {
    mockStripeCreate.mockResolvedValue({ url: "https://stripe.test/checkout" });
    const { tenantId: tenantA }     = await createTenant();
    const { slug: slugB }           = await createTenant();
    const artworkIdA = await createArtwork(tenantA);

    await callCheckout(slugB, artworkIdA);

    expect(mockStripeCreate).not.toHaveBeenCalled();
  });

  it("nonexistent tenant slug → 400 or similar non-5xx error", async () => {
    const { tenantId: tenantA } = await createTenant();
    const artworkIdA = await createArtwork(tenantA);

    const res = await callCheckout(`nonexistent-slug-${uid()}`, artworkIdA);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("correct tenant slug + own artwork → checkout proceeds (reservation created)", async () => {
    mockStripeCreate.mockResolvedValue({ url: "https://stripe.test/checkout" });
    const { tenantId, slug } = await createTenant();
    const artworkId = await createArtwork(tenantId);

    const res = await callCheckout(slug, artworkId);

    expect(res.status).not.toBe(400);
    expect(await artworkStatus(artworkId)).toBe("RESERVED");
  });

  it("correct slug + artwork from a different (non-matching) tenant → 400", async () => {
    const { slug: slugOwn }         = await createTenant();
    const { tenantId: tenantForeign } = await createTenant();
    const foreignArtwork = await createArtwork(tenantForeign);

    const res = await callCheckout(slugOwn, foreignArtwork);
    expect(res.status).toBe(400);
    expect(await artworkStatus(foreignArtwork)).toBe("AVAILABLE");
  });
});
