/**
 * Task #305 / Task #217 — Confirm the checkout session sets the correct
 * commission amount before payment starts.
 *
 * Verifies that the Stripe checkout session is created with
 * payment_intent_data.application_fee_amount equal to the value returned by
 * the REAL calcApplicationFee(artwork.price) for standard tenants, and the
 * REAL calcApplicationFeeForTenant(artwork.price, 350) for i-Framer Premium
 * tenants (Task #217).
 *
 * Neither calcApplicationFee nor calcApplicationFeeForTenant are mocked — the
 * real implementations are used so formula regressions fail the tests.
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
  // Widened to number | null so tests can mutate it to 350/500 for i-Framer Premium cases.
  commissionBasisPoints: null as number | null,
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
      fulfillmentType: "PICKUP",
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
  // Restore default (standard) tenant state before each test
  tenant.commissionBasisPoints = null;
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
      fulfillmentType: "PICKUP",
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

// ── Task #217 — i-Framer Premium checkout commission ─────────────────────────
//
// Requirements:
//   B. Eligible i-Framer Premium gallery → reduced 3.5% fee (350 bp)
//   C. Non-premium gallery → cannot accidentally receive the premium fee
//   E. Fee follows current DB eligibility state, not stale/client-side data
//   F. Session metadata carries the correct commissionBasisPoints for the webhook
//
// The real calcApplicationFeeForTenant implementation is used throughout so
// formula drift causes these tests to fail rather than silently passing.

import { calcApplicationFeeForTenant } from "@/lib/stripe";

describe("POST /api/stripe/checkout — i-Framer Premium commission (Task #217)", () => {
  // artwork.price = 24_000 cents ($240 AUD)
  // 5.0%: Math.round(24000 * 0.05) = 1200 cents
  // 3.5%: Math.round(24000 * 0.035) = 840 cents

  beforeEach(async () => {
    // The "odd-cent" test in the sibling describe block mutates db.update to
    // return price 9 999 and that mutation persists across describe blocks
    // because the mock module is a shared object. Restore it here so these
    // tests always operate on artwork.price = 24 000.
    const { db: mockDb } = await import("@workspace/db");
    (mockDb as any).update = (_table: any) => ({
      set: (_vals: any) => ({
        where: (_cond: any) => ({
          returning: () => Promise.resolve([{ ...artwork }]),
        }),
      }),
    });
  });

  // ── Requirement B: Premium gallery receives 3.5% fee ───────────────────────

  it("uses 3.5% (350 bp) fee when tenant.commissionBasisPoints = 350", async () => {
    // Simulate a verified i-Framer Premium tenant (commissionBasisPoints set to 350
    // by verifyIFramerAccount when the portal URL was successfully checked).
    tenant.commissionBasisPoints = 350;

    const res = await POST(checkoutRequest());
    expect(res.status).toBe(200);

    const args = sessionsCreate.mock.calls[0][0];
    const expected = calcApplicationFeeForTenant(artwork.price, 350);
    expect(args.payment_intent_data.application_fee_amount).toBe(expected.feeCents);
    // Sanity: 3.5% of $240 = $8.40 = 840 cents
    expect(args.payment_intent_data.application_fee_amount).toBe(840);
  });

  it("Premium 3.5% fee is strictly lower than the standard 5% fee on the same artwork", async () => {
    // Regression guard: the Premium rate must always be a discount, not equal
    // or greater than the standard rate.
    tenant.commissionBasisPoints = 350;
    await POST(checkoutRequest());
    const premiumFee = sessionsCreate.mock.calls[0][0].payment_intent_data.application_fee_amount;

    vi.clearAllMocks();
    sessionsCreate.mockResolvedValue({ url: "https://checkout.stripe.com/cs_test_std" });
    tenant.commissionBasisPoints = null; // standard rate
    await POST(checkoutRequest());
    const standardFee = sessionsCreate.mock.calls[0][0].payment_intent_data.application_fee_amount;

    expect(premiumFee).toBeLessThan(standardFee);
  });

  // ── Requirement F: Session metadata carries commissionBasisPoints ───────────

  it("carries commissionBasisPoints=350 in session metadata for Premium tenant", async () => {
    tenant.commissionBasisPoints = 350;

    await POST(checkoutRequest());
    const args = sessionsCreate.mock.calls[0][0];

    // The webhook reads commissionBasisPoints from metadata to persist the
    // effective rate on the order row — it must be present and correct.
    expect(args.metadata.commissionBasisPoints).toBe("350");
  });

  it("carries commissionBasisPoints matching the global rate in metadata for standard tenant", async () => {
    // commissionBasisPoints is null → route uses global PLATFORM_FEE_PERCENT
    // and should embed the effective bp in metadata so the webhook can record it.
    tenant.commissionBasisPoints = null;

    await POST(checkoutRequest());
    const args = sessionsCreate.mock.calls[0][0];

    // The route stores String(commissionBasisPoints) where commissionBasisPoints
    // is the effective value returned by calcApplicationFeeForTenant, which
    // converts the global PLATFORM_FEE_PERCENT back to basis points.
    const { commissionBasisPoints: effectiveBp } = calcApplicationFeeForTenant(artwork.price, null);
    expect(args.metadata.commissionBasisPoints).toBe(String(effectiveBp));
  });

  // ── Requirement C: Non-premium cannot accidentally get Premium fee ──────────

  it("non-Premium tenant (null bp) does NOT receive the 3.5% Premium fee", async () => {
    tenant.commissionBasisPoints = null; // not a Premium tenant

    await POST(checkoutRequest());
    const args = sessionsCreate.mock.calls[0][0];

    const premiumFee = calcApplicationFeeForTenant(artwork.price, 350).feeCents;
    const actualFee = args.payment_intent_data.application_fee_amount;

    // A non-Premium tenant must never have the Premium reduced fee applied.
    expect(actualFee).not.toBe(premiumFee);
    // Must use the global rate instead.
    expect(actualFee).toBe(calcApplicationFee(artwork.price));
  });

  it("tenant with an explicit standard 500 bp override does not receive the Premium 3.5% rate", async () => {
    // If an operator explicitly sets commissionBasisPoints to 500 (the global
    // default), the checkout must honour that value, not apply 350 by accident.
    tenant.commissionBasisPoints = 500;

    await POST(checkoutRequest());
    const args = sessionsCreate.mock.calls[0][0];

    const premiumFee = calcApplicationFeeForTenant(artwork.price, 350).feeCents;
    expect(args.payment_intent_data.application_fee_amount).not.toBe(premiumFee);
    expect(args.payment_intent_data.application_fee_amount).toBe(
      calcApplicationFeeForTenant(artwork.price, 500).feeCents,
    );
  });

  // ── Requirement E: Fee follows current eligibility state ───────────────────

  it("uses the tenant's current DB commissionBasisPoints — not a cached/stale value", async () => {
    // The checkout route reads commissionBasisPoints from the tenant record
    // returned by getTenantBySlug() on every request, so it always reflects the
    // current verified state set by verifyIFramerAccount / recheckIFramerVerification.
    //
    // Simulate a tenant whose premium lapsed: commissionBasisPoints was just
    // cleared to null by recheckIFramerVerification.
    tenant.commissionBasisPoints = null; // lapsed — cleared by recheck

    await POST(checkoutRequest());
    const args = sessionsCreate.mock.calls[0][0];

    // Must use the global (standard) rate, not the old 350 bp Premium rate.
    expect(args.payment_intent_data.application_fee_amount).toBe(
      calcApplicationFee(artwork.price),
    );
    expect(args.metadata.commissionBasisPoints).not.toBe("350");
  });

  it("immediately applies Premium rate on the first checkout after verification", async () => {
    // Simulate a tenant who just verified: commissionBasisPoints set to 350.
    tenant.commissionBasisPoints = 350;

    const res = await POST(checkoutRequest());
    expect(res.status).toBe(200);

    const args = sessionsCreate.mock.calls[0][0];
    expect(args.payment_intent_data.application_fee_amount).toBe(840); // 3.5% of $240
    expect(args.metadata.commissionBasisPoints).toBe("350");
  });

  // ── Rounding with Premium rate ──────────────────────────────────────────────

  it("rounds 3.5% Premium fee correctly — 9 999 × 3.5% = 349.965 → 350 cents", async () => {
    tenant.commissionBasisPoints = 350;

    const { db: mockDb } = await import("@workspace/db");
    (mockDb as any).update = dbUpdateReturning(9_999);

    await POST(checkoutRequest());
    const args = sessionsCreate.mock.calls[0][0];

    // Math.round(9999 * (350/100/100)) = Math.round(349.965) = 350
    const expected = calcApplicationFeeForTenant(9_999, 350).feeCents;
    expect(expected).toBe(350); // sanity-check real function
    expect(args.payment_intent_data.application_fee_amount).toBe(expected);
  });
});
