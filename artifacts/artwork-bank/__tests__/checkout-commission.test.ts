/**
 * Task #305 — Confirm the checkout session sets the correct commission amount
 * before payment starts.
 *
 * Verifies that the Stripe checkout session is created with
 * payment_intent_data.application_fee_amount equal to the value returned by
 * the REAL calcApplicationFee(artwork.price), and that the gallery's connected
 * account receives the transfer (transfer_data.destination =
 * tenant.stripeAccountId).
 *
 * calcApplicationFee is intentionally NOT mocked here (uses importOriginal like
 * the webhook-commission sibling test) so a regression in the production
 * rounding formula would cause these tests to fail.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── DB mock ───────────────────────────────────────────────────────────────────

const artwork = {
  id: "art-1",
  tenantId: "tenant-1",
  status: "AVAILABLE",
  showInGallery: true,
  title: "Coastal Morning",
  medium: "Oil on canvas",
  sku: "CM-01",
  price: 24_000, // $240.00 AUD
};

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      artworkImagesTable: {
        findFirst: vi.fn().mockResolvedValue(undefined),
      },
    },
    update: (_table: any) => ({
      set: (_vals: any) => ({
        where: (_cond: any) => ({
          returning: () => Promise.resolve([{ ...artwork }]),
        }),
      }),
    }),
  },
  artworksTable: {
    id: "id",
    tenantId: "tenantId",
    status: "status",
    showInGallery: "showInGallery",
  },
  artworkImagesTable: { artworkId: "artworkId", isPrimary: "isPrimary" },
}));

// ── Tenant cache mock ─────────────────────────────────────────────────────────

const tenant = vi.hoisted(() => ({
  id: "tenant-1",
  storefrontEnabled: true,
  stripeAccountId: "acct_gallery_001",
  stripeChargesEnabled: true,
  type: "GALLERY",
  customDomain: null,
  customDomainVerified: false,
  // null → no per-tenant override → calcApplicationFeeForTenant falls back
  // to the global PLATFORM_FEE_PERCENT (5%), same as calcApplicationFee.
  commissionBasisPoints: null,
}));

vi.mock("@/lib/tenant-cache", () => ({
  getTenantBySlug: vi.fn().mockResolvedValue(tenant),
}));

// ── Rate limit: always allow ──────────────────────────────────────────────────

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue(true),
}));

// ── Object storage: optional image ───────────────────────────────────────────

vi.mock("@/lib/object-storage", () => ({
  getServeUrl: vi.fn().mockResolvedValue("https://cdn.example/art.jpg"),
}));

// ── Stripe: capture what the route passes to sessions.create ─────────────────
// Use the REAL calcApplicationFee (importOriginal) so the rounding edge case
// verifies production formula behaviour, not a copy of it.

const sessionsCreate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/stripe", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/stripe")>();
  return {
    getStripeClient: vi.fn().mockResolvedValue({
      checkout: { sessions: { create: (...a: any[]) => sessionsCreate(...a) } },
    }),
    calcApplicationFee: real.calcApplicationFee,
    // Task #217: per-tenant commission override — route calls calcApplicationFeeForTenant
    // instead of calcApplicationFee.  Expose the real implementation so the
    // test also catches formula drift in the new function.
    calcApplicationFeeForTenant: real.calcApplicationFeeForTenant,
    StripeNotConfiguredError: class StripeNotConfiguredError extends Error {},
  };
});

// ── Route handler ─────────────────────────────────────────────────────────────

import { POST } from "@/app/api/stripe/checkout/route";
import { calcApplicationFee } from "@/lib/stripe";

function checkoutRequest(overrides: Record<string, string> = {}) {
  return new Request("http://localhost/api/stripe/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      artworkId: "art-1",
      slug: "gallery",
      fulfillmentType: "SHIP",
      ...overrides,
    }),
  });
}

/** Return a mock db.update that resolves with the given artwork price. */
function dbUpdateReturning(price: number) {
  return (_table: any) => ({
    set: (_vals: any) => ({
      where: (_cond: any) => ({
        returning: () => Promise.resolve([{ ...artwork, price }]),
      }),
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionsCreate.mockResolvedValue({
    url: "https://checkout.stripe.com/cs_test_abc",
  });
});

describe("POST /api/stripe/checkout — commission amount", () => {
  it("passes application_fee_amount equal to calcApplicationFee(artwork.price)", async () => {
    const res = await POST(checkoutRequest());
    expect(res.status).toBe(200);

    const args = sessionsCreate.mock.calls[0][0];
    const expectedFee = calcApplicationFee(artwork.price);
    expect(args.payment_intent_data.application_fee_amount).toBe(expectedFee);
  });

  it("sets transfer_data.destination to the tenant's stripeAccountId", async () => {
    await POST(checkoutRequest());
    const args = sessionsCreate.mock.calls[0][0];
    expect(args.payment_intent_data.transfer_data.destination).toBe(
      tenant.stripeAccountId,
    );
  });

  it("commission is non-zero for a positive price", async () => {
    await POST(checkoutRequest());
    const args = sessionsCreate.mock.calls[0][0];
    expect(args.payment_intent_data.application_fee_amount).toBeGreaterThan(0);
  });

  it("uses the artwork price as the Stripe line item unit_amount", async () => {
    await POST(checkoutRequest());
    const args = sessionsCreate.mock.calls[0][0];
    expect(args.line_items[0].price_data.unit_amount).toBe(artwork.price);
  });

  it("records the artwork in session metadata so the webhook can link it", async () => {
    await POST(checkoutRequest());
    const args = sessionsCreate.mock.calls[0][0];
    expect(args.metadata).toMatchObject({
      artworkId: "art-1",
      tenantId: tenant.id,
      fulfillmentType: "SHIP",
    });
  });

  it("rounds odd-cent commission correctly — 9 999 × 5% = 499.95 → 500 cents", async () => {
    // Use the REAL calcApplicationFee (not a copy of the formula) so this test
    // would fail if the production function were changed to truncate instead of round.
    const oddCentPrice = 9_999;
    const { db: mockDb } = await import("@workspace/db");
    (mockDb as any).update = dbUpdateReturning(oddCentPrice);

    const res = await POST(checkoutRequest());
    expect(res.status).toBe(200);

    const args = sessionsCreate.mock.calls[0][0];
    // Real calcApplicationFee: Math.round(9999 * (5/100)) = Math.round(499.95) = 500
    const realFee = calcApplicationFee(oddCentPrice);
    expect(realFee).toBe(500); // sanity-check the real function
    expect(args.payment_intent_data.application_fee_amount).toBe(realFee);
  });
});
