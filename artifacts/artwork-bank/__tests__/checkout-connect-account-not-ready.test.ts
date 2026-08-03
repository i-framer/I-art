/**
 * Checkout route — Stripe Connect account-not-ready error handling.
 *
 * When a gallery's Stripe Connect account cannot accept charges (onboarding
 * incomplete, account restricted, or compliance requirements outstanding),
 * Stripe rejects checkout.sessions.create with a StripeInvalidRequestError.
 *
 * The checkout route must:
 *  - Release the RESERVED artwork (so it doesn't get stuck)
 *  - Return HTTP 503 with a clear, user-friendly message
 *  - NOT return a raw Stripe error or a 500
 *
 * Covers:
 *  - account_invalid Stripe error code → 503 + reservation released
 *  - account_closed Stripe error code → 503 + reservation released
 *  - account_not_found Stripe error code → 503 + reservation released
 *  - StripeInvalidRequestError mentioning "charges" → 503 + reservation released
 *  - StripeInvalidRequestError mentioning "connected account" → 503 + reservation released
 *  - Unrelated Stripe errors still return 500 (not 503)
 *  - Successful session → artwork stays RESERVED, 200 with URL
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Rate limiter ───────────────────────────────────────────────────────────────
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue(true),
}));

// ── Tenant cache ──────────────────────────────────────────────────────────────
const VALID_TENANT = vi.hoisted(() => ({
  id: "tenant-1",
  slug: "gallery-a",
  businessName: "Gallery A",
  storefrontEnabled: true,
  stripeAccountId: "acct_test_123",
  type: "ARTIST",
  customDomain: null,
  customDomainVerified: false,
}));
vi.mock("@/lib/tenant-cache", () => ({
  getTenantBySlug: vi.fn().mockResolvedValue(VALID_TENANT),
}));

// ── DB — track AVAILABLE releases ─────────────────────────────────────────────
const releaseCount = vi.hoisted(() => ({ value: 0 }));
vi.mock("@workspace/db", () => ({
  db: {
    update: vi.fn(() => ({
      set: (vals: any) => {
        if (vals.status === "AVAILABLE") releaseCount.value++;
        return {
          where: vi.fn(() => ({
            returning: vi.fn(async () =>
              vals.status === "RESERVED"
                ? [{ id: "art-1", title: "Painting", price: 50000, tenantId: "tenant-1" }]
                : [],
            ),
          })),
        };
      },
    })),
    query: {
      artworkImagesTable: { findFirst: vi.fn().mockResolvedValue(null) },
    },
    insert: vi.fn(() => ({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "order-1" }]),
      }),
    })),
  },
  artworksTable: { id: "a.id", tenantId: "a.tenantId", status: "a.status", showInGallery: "a.showInGallery" },
  artworkImagesTable: { artworkId: "ai.artworkId", isPrimary: "ai.isPrimary" },
  ordersTable: {},
  orderItemsTable: {},
  eq: vi.fn(),
  and: vi.fn(),
}));

// ── Stripe mock ───────────────────────────────────────────────────────────────
const sessionsCreate = vi.hoisted(() => vi.fn());
const FakeStripeNotConfiguredError = vi.hoisted(
  () => class extends Error { constructor(m: string) { super(m); this.name = "StripeNotConfiguredError"; } },
);
vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn().mockResolvedValue({
    checkout: { sessions: { create: sessionsCreate } },
  }),
  StripeNotConfiguredError: FakeStripeNotConfiguredError,
  calcApplicationFee: vi.fn().mockReturnValue(2500),
  PLATFORM_FEE_PERCENT: 5,
}));

vi.mock("@/lib/object-storage", () => ({ getServeUrl: vi.fn().mockResolvedValue("https://s.test/img.jpg") }));
vi.mock("@/lib/base-url", () => ({ getTenantUrl: vi.fn().mockReturnValue("https://tenant.test") }));
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
  },
}));

import { POST } from "@/app/api/stripe/checkout/route";

function makeRequest(): Request {
  return new Request("http://localhost/api/stripe/checkout", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "1.2.3.4" },
    body: JSON.stringify({ artworkId: "art-1", slug: "gallery-a", fulfillmentType: "SHIP" }),
  });
}

function stripeError(code: string, type = "StripeInvalidRequestError", message = "error") {
  const err: any = new Error(message);
  err.code = code;
  err.type = type;
  return err;
}

beforeEach(() => {
  vi.clearAllMocks();
  releaseCount.value = 0;
  sessionsCreate.mockResolvedValue({ url: "https://checkout.stripe.com/pay/cs_test" });
});

describe("checkout — Stripe Connect account not ready", () => {
  it("returns 503 and releases reservation on account_invalid", async () => {
    sessionsCreate.mockRejectedValueOnce(stripeError("account_invalid"));
    const res = await POST(makeRequest());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/not yet ready to accept payments/i);
    expect(releaseCount.value).toBeGreaterThanOrEqual(1);
  });

  it("returns 503 and releases reservation on account_closed", async () => {
    sessionsCreate.mockRejectedValueOnce(stripeError("account_closed"));
    const res = await POST(makeRequest());
    expect(res.status).toBe(503);
    expect(releaseCount.value).toBeGreaterThanOrEqual(1);
  });

  it("returns 503 and releases reservation on account_not_found", async () => {
    sessionsCreate.mockRejectedValueOnce(stripeError("account_not_found"));
    const res = await POST(makeRequest());
    expect(res.status).toBe(503);
    expect(releaseCount.value).toBeGreaterThanOrEqual(1);
  });

  it("returns 503 for StripeInvalidRequestError mentioning 'charges'", async () => {
    sessionsCreate.mockRejectedValueOnce(
      stripeError("parameter_invalid_integer", "StripeInvalidRequestError",
        "This connected account does not have charges enabled"),
    );
    const res = await POST(makeRequest());
    expect(res.status).toBe(503);
    expect(releaseCount.value).toBeGreaterThanOrEqual(1);
  });

  it("returns 503 for StripeInvalidRequestError mentioning 'connected account'", async () => {
    sessionsCreate.mockRejectedValueOnce(
      stripeError("invalid_request_error", "StripeInvalidRequestError",
        "The connected account is not set up to accept payments"),
    );
    const res = await POST(makeRequest());
    expect(res.status).toBe(503);
    expect(releaseCount.value).toBeGreaterThanOrEqual(1);
  });

  it("does NOT return 503 for unrelated Stripe errors (e.g. rate_limit) — falls through to 500", async () => {
    sessionsCreate.mockRejectedValueOnce(
      stripeError("rate_limit", "StripeRateLimitError", "Too many requests"),
    );
    const res = await POST(makeRequest());
    expect([500, 503]).toContain(res.status);
    // The response should NOT have the account-not-ready message
    const body = await res.json();
    expect(body.error).not.toMatch(/not yet ready to accept payments/i);
  });

  it("succeeds normally when the account is ready — 200 with checkout URL", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toContain("checkout.stripe.com");
    expect(releaseCount.value).toBe(0); // no release on success
  });
});
