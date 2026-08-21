/**
 * Checkout route — Stripe session creation failure releases the RESERVED artwork.
 *
 * After the artwork is atomically set to RESERVED, any failure before a
 * Stripe checkout URL is returned must release the reservation back to
 * AVAILABLE, so the piece isn't permanently stuck reserved with no active
 * checkout session.
 *
 * Covers:
 *  - Stripe client unreachable (getStripeClient throws) → artwork reverted, 503
 *  - Stripe not configured (StripeNotConfiguredError) → artwork reverted, 503
 *  - checkout.sessions.create throws → artwork reverted, 500
 *  - Artwork with no price → artwork reverted, 400
 *  - Successful checkout → artwork stays RESERVED, returns URL
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Rate limiter (always allow) ────────────────────────────────────────────────
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue(true),
}));

// ── Tenant cache mock ─────────────────────────────────────────────────────────
const VALID_TENANT = vi.hoisted(() => ({
  id: "tenant-1",
  slug: "gallery-a",
  businessName: "Gallery A",
  storefrontEnabled: true,
  stripeAccountId: "acct_test_123",
  stripeChargesEnabled: true,
  type: "ARTIST",
  customDomain: null,
  customDomainVerified: false,
}));
vi.mock("@/lib/tenant-cache", () => ({
  getTenantBySlug: vi.fn().mockResolvedValue(VALID_TENANT),
}));

// ── DB state ──────────────────────────────────────────────────────────────────
// artwork row returned by the RESERVED UPDATE
const artworkRow = vi.hoisted(() => ({
  value: [{ id: "art-1", title: "Painting", price: 50000, tenantId: "tenant-1" }] as unknown[],
}));
// track release (AVAILABLE) UPDATE calls
const releaseUpdateCalls = vi.hoisted(() => ({ count: 0 }));
const updateSetFn = vi.hoisted(() => vi.fn());

vi.mock("@workspace/db", () => ({
  db: {
    update: vi.fn(() => ({
      set: (vals: any) => {
        updateSetFn(vals);
        if (vals.status === "AVAILABLE") releaseUpdateCalls.count++;
        return {
          where: vi.fn(() => ({
            returning: vi.fn(async () =>
              vals.status === "RESERVED" ? artworkRow.value : [],
            ),
          })),
        };
      },
    })),
    query: {
      artworkImagesTable: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    },
    insert: vi.fn(() => ({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "order-1" }]),
      }),
    })),
  },
  artworksTable: { id: "a.id", tenantId: "a.tenantId", status: "a.status", showInGallery: "a.showInGallery" },
  artworkImagesTable: { artworkId: "ai.artworkId", isPrimary: "ai.isPrimary" },
  tenantsTable: { id: "t.id", stripeAccountId: "t.stripeAccountId" },
  ordersTable: {},
  orderItemsTable: {},
  eq: vi.fn(),
  and: vi.fn(),
}));

// ── Stripe mock ───────────────────────────────────────────────────────────────
const getStripeClient = vi.hoisted(() => vi.fn());
const FakeStripeNotConfiguredError = vi.hoisted(
  () =>
    class extends Error {
      constructor(m: string) {
        super(m);
        this.name = "StripeNotConfiguredError";
      }
    },
);
vi.mock("@/lib/stripe", () => ({
  getStripeClient,
  StripeNotConfiguredError: FakeStripeNotConfiguredError,
  calcApplicationFee: vi.fn().mockReturnValue(2500),
  calcApplicationFeeForTenant: vi.fn().mockReturnValue({ feeCents: 2500, commissionBasisPoints: 500 }),
  PLATFORM_FEE_PERCENT: 5,
}));

// ── Object storage mock ───────────────────────────────────────────────────────
vi.mock("@/lib/object-storage", () => ({
  getServeUrl: vi.fn().mockResolvedValue("https://storage.test/img.jpg"),
}));

// ── Base URL mock ─────────────────────────────────────────────────────────────
vi.mock("@/lib/base-url", () => ({
  getTenantUrl: vi.fn().mockReturnValue("https://tenant.test"),
}));

// ── next/server mock ──────────────────────────────────────────────────────────
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

function makeRequest(body: Record<string, unknown> = {}): Request {
  return new Request("http://localhost/api/stripe/checkout", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "1.2.3.4" },
    body: JSON.stringify({
      artworkId: "art-1",
      slug: "gallery-a",
      fulfillmentType: "SHIP",
      ...body,
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  artworkRow.value = [{ id: "art-1", title: "Painting", price: 50000, tenantId: "tenant-1" }];
  releaseUpdateCalls.count = 0;
  updateSetFn.mockClear();
  // Default: Stripe client available with working session create
  getStripeClient.mockResolvedValue({
    checkout: {
      sessions: {
        create: vi.fn().mockResolvedValue({ url: "https://checkout.stripe.com/pay/cs_test" }),
      },
    },
  });
});

describe("checkout route — successful path", () => {
  it("returns 200 with a checkout URL on success", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toContain("checkout.stripe.com");
  });

  it("does not release the reservation on success", async () => {
    await POST(makeRequest());
    expect(releaseUpdateCalls.count).toBe(0);
  });
});

describe("checkout route — Stripe failure releases reservation", () => {
  it("releases reservation and returns 503 when Stripe is not configured", async () => {
    getStripeClient.mockRejectedValueOnce(
      new FakeStripeNotConfiguredError("Stripe not configured"),
    );

    const res = await POST(makeRequest());

    expect(res.status).toBe(503);
    expect(releaseUpdateCalls.count).toBe(1); // reservation released
  });

  it("releases reservation and returns 503/500 when Stripe client is unreachable", async () => {
    getStripeClient.mockRejectedValueOnce(new Error("Network error"));

    const res = await POST(makeRequest());

    expect([500, 503]).toContain(res.status);
    expect(releaseUpdateCalls.count).toBeGreaterThanOrEqual(1);
  });

  it("releases reservation when checkout.sessions.create throws", async () => {
    getStripeClient.mockResolvedValueOnce({
      checkout: {
        sessions: {
          create: vi.fn().mockRejectedValueOnce(new Error("Stripe API error")),
        },
      },
    });

    const res = await POST(makeRequest());

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(releaseUpdateCalls.count).toBe(1);
  });

  it("clears a stale Connect account and returns a buyer-safe reconnect message", async () => {
    const staleAccountError = Object.assign(
      new Error("No such account: 'acct_test_123'"),
      { code: "resource_missing" },
    );
    getStripeClient.mockResolvedValueOnce({
      checkout: {
        sessions: {
          create: vi.fn().mockRejectedValueOnce(staleAccountError),
        },
      },
    });

    const res = await POST(makeRequest());

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error:
        "This gallery's payment connection needs to be reconnected. Please try again later or contact the gallery directly.",
    });
    expect(releaseUpdateCalls.count).toBe(1);
    expect(updateSetFn).toHaveBeenCalledWith({
      stripeAccountId: null,
      stripeChargesEnabled: false,
      stripePayoutsEnabled: false,
    });
  });
});

describe("checkout route — artwork with no price", () => {
  it("releases reservation and returns 400 when artwork has no price", async () => {
    artworkRow.value = [{ id: "art-1", title: "NFS Painting", price: null, tenantId: "tenant-1" }];

    const res = await POST(makeRequest());

    expect(res.status).toBe(400);
    expect(releaseUpdateCalls.count).toBe(1);
  });
});
