/**
 * Checkout route — Stripe Connect account readiness gate:
 *  - Returns 503 with a clear message when stripeChargesEnabled is cached false,
 *    before reserving the artwork or calling Stripe.
 *  - Returns 503 with the same message when Stripe itself returns an
 *    account_invalid error (second line of defence for accounts with no
 *    cached state yet), and releases the artwork reservation.
 *  - Allows checkout to proceed when stripeChargesEnabled is null (not yet
 *    cached from a webhook — do not block new onboardings prematurely).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Fake DB state ─────────────────────────────────────────────────────────────
const state = vi.hoisted(() => ({
  artworkStatus: "AVAILABLE" as string,
  reserveAttempts: 0,
  releaseAttempts: 0,
}));

vi.mock("@workspace/db", () => {
  const cas = (vals: any): boolean => {
    if (vals.status === "RESERVED") {
      state.reserveAttempts++;
      if (state.artworkStatus === "AVAILABLE") {
        state.artworkStatus = "RESERVED";
        return true;
      }
      return false;
    }
    if (vals.status === "AVAILABLE") {
      state.releaseAttempts++;
      if (state.artworkStatus === "RESERVED") {
        state.artworkStatus = "AVAILABLE";
        return true;
      }
      return false;
    }
    return false;
  };

  return {
    db: {
      query: {
        artworkImagesTable: { findFirst: vi.fn().mockResolvedValue(undefined) },
        ordersTable: { findFirst: vi.fn() },
        artworksTable: { findFirst: vi.fn() },
        tenantsTable: { findFirst: vi.fn() },
      },
      update: (_table: any) => ({
        set: (vals: any) => ({
          where: (_cond: any) => ({
            returning: () =>
              Promise.resolve(cas(vals) ? [{ id: "art-1", price: 12_000, title: "Sunset", medium: "Oil", sku: "SKU-1", status: state.artworkStatus, tenantId: "tenant-1" }] : []),
            then: (onF: any, onR: any) =>
              Promise.resolve(cas(vals)).then(onF, onR),
          }),
        }),
      }),
      insert: vi.fn(),
      transaction: vi.fn(),
    },
    artworksTable: {
      id: "id",
      tenantId: "tenantId",
      status: "status",
      showInGallery: "showInGallery",
    },
    artworkImagesTable: { artworkId: "artworkId", isPrimary: "isPrimary" },
    ordersTable: { stripeSessionId: "stripeSessionId", id: "id" },
    orderItemsTable: {},
    tenantsTable: { id: "id" },
  };
});

vi.mock("@/lib/tenant-cache", () => ({
  getTenantBySlug: vi.fn(),
}));
vi.mock("@/lib/object-storage", () => ({
  getServeUrl: vi.fn().mockResolvedValue("https://img.example/x"),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue(true),
}));

const sessionsCreate = vi.hoisted(() => vi.fn());
const getStripeClient = vi.hoisted(() => vi.fn());
vi.mock("@/lib/stripe", () => ({
  getStripeClient: (...a: any[]) => getStripeClient(...a),
  getStripeWebhookSecret: vi.fn().mockResolvedValue(null),
  calcApplicationFee: vi.fn().mockReturnValue(600),
  StripeNotConfiguredError: class StripeNotConfiguredError extends Error {},
}));

vi.mock("@/lib/email", () => ({ sendOrderConfirmation: vi.fn() }));
vi.mock("@/lib/base-url", () => ({ getTenantUrl: vi.fn() }));
vi.mock("@/lib/iframer", () => ({
  createIFramerJob: vi.fn(),
  IFramerError: class IFramerError extends Error {},
}));

import { getTenantBySlug } from "@/lib/tenant-cache";
import { POST as checkoutPOST } from "@/app/api/stripe/checkout/route";

const baseTenant = {
  id: "tenant-1",
  storefrontEnabled: true,
  stripeAccountId: "acct_1",
  stripeChargesEnabled: null as boolean | null,
  stripePayoutsEnabled: null as boolean | null,
  type: "ARTIST",
  customDomain: null,
  customDomainVerified: false,
};

function checkoutRequest() {
  return new Request("http://localhost/api/stripe/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      artworkId: "art-1",
      slug: "gallery",
      fulfillmentType: "SHIP",
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.artworkStatus = "AVAILABLE";
  state.reserveAttempts = 0;
  state.releaseAttempts = 0;
  sessionsCreate.mockResolvedValue({ url: "https://stripe.test/session" });
  getStripeClient.mockResolvedValue({
    checkout: { sessions: { create: sessionsCreate } },
  });
  vi.mocked(getTenantBySlug).mockResolvedValue({
    ...baseTenant,
    stripeChargesEnabled: null,
  } as any);
});

afterEach(() => {
  delete process.env.STRIPE_WEBHOOK_DEV_BYPASS;
});

// ── stripeChargesEnabled cached as false ──────────────────────────────────────

describe("checkout gate — stripeChargesEnabled cached as false", () => {
  beforeEach(() => {
    vi.mocked(getTenantBySlug).mockResolvedValue({
      ...baseTenant,
      stripeChargesEnabled: false,
    } as any);
  });

  it("returns 503 with the account-not-ready message", async () => {
    const res = await checkoutPOST(checkoutRequest());

    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toMatch(/not yet ready to accept payments/i);
  });

  it("does NOT reserve the artwork before rejecting", async () => {
    await checkoutPOST(checkoutRequest());

    // No reservation attempt should have been made at all.
    expect(state.reserveAttempts).toBe(0);
    expect(state.artworkStatus).toBe("AVAILABLE");
  });

  it("does NOT call Stripe before rejecting", async () => {
    await checkoutPOST(checkoutRequest());

    expect(getStripeClient).not.toHaveBeenCalled();
    expect(sessionsCreate).not.toHaveBeenCalled();
  });
});

// ── stripeChargesEnabled is null (no cached state yet) ────────────────────────

describe("checkout gate — stripeChargesEnabled is null (no webhook received yet)", () => {
  it("does NOT block checkout — proceeds to Stripe normally", async () => {
    vi.mocked(getTenantBySlug).mockResolvedValue({
      ...baseTenant,
      stripeChargesEnabled: null,
    } as any);

    const res = await checkoutPOST(checkoutRequest());

    // Checkout must not be blocked when we have no cached readiness info.
    expect(res.status).toBe(200);
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
  });
});

// ── Stripe returns account_invalid (second line of defence) ───────────────────

describe("checkout gate — Stripe account_invalid error (no cached state)", () => {
  it("returns 503 with the account-not-ready message and releases the reservation", async () => {
    const stripeError = Object.assign(
      new Error("The provided key 'acct_1' does not have charges enabled"),
      { type: "StripeInvalidRequestError", code: "account_invalid" },
    );
    sessionsCreate.mockRejectedValue(stripeError);

    const res = await checkoutPOST(checkoutRequest());

    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toMatch(/not yet ready to accept payments/i);

    // The artwork must be released back to AVAILABLE.
    expect(state.artworkStatus).toBe("AVAILABLE");
    expect(state.releaseAttempts).toBe(1);
  });

  it("returns 503 when Stripe error message mentions 'charges' (StripeInvalidRequestError)", async () => {
    const stripeError = Object.assign(
      new Error("This connected account cannot currently accept charges"),
      { type: "StripeInvalidRequestError" },
    );
    sessionsCreate.mockRejectedValue(stripeError);

    const res = await checkoutPOST(checkoutRequest());

    expect(res.status).toBe(503);
    expect(state.artworkStatus).toBe("AVAILABLE");
  });
});
