/**
 * Checkout route — invalid input and missing-resource edge cases.
 *
 * Covers:
 *  - Missing required fields (artworkId, slug, fulfillmentType) → 400
 *  - Invalid fulfillmentType → 400
 *  - Unknown/disabled tenant (storefrontEnabled=false) → 400
 *  - Tenant with no stripeAccountId → 400
 *  - FRAMING_JOB fulfillment type on a non-FRAMER tenant → 400
 *  - Artwork not available (no rows updated by the conditional RESERVED UPDATE) → 400
 *  - Rate limit exceeded → 429
 *
 * These are pure unit tests using mocked DB + Stripe.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Rate limiter mock (allow by default) ──────────────────────────────────────
const checkRateLimit = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit }));

// ── Tenant cache mock ─────────────────────────────────────────────────────────
const getTenantBySlug = vi.hoisted(() => vi.fn());
vi.mock("@/lib/tenant-cache", () => ({ getTenantBySlug }));

// ── DB mock ───────────────────────────────────────────────────────────────────
const artworkUpdateRows = vi.hoisted(() => ({ value: [] as unknown[] }));
vi.mock("@workspace/db", () => ({
  db: {
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => artworkUpdateRows.value),
        })),
      })),
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
  ordersTable: {},
  orderItemsTable: {},
  eq: vi.fn(),
  and: vi.fn(),
}));

// ── Stripe mock ───────────────────────────────────────────────────────────────
const stripeCheckoutCreate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn().mockResolvedValue({
    checkout: { sessions: { create: stripeCheckoutCreate } },
  }),
  StripeNotConfiguredError: class extends Error {},
  calcApplicationFee: vi.fn().mockReturnValue(50),
  calcApplicationFeeForTenant: vi.fn().mockReturnValue({ feeCents: 50, commissionBasisPoints: 500 }),
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

const VALID_TENANT = {
  id: "tenant-1",
  slug: "gallery-a",
  businessName: "Gallery A",
  storefrontEnabled: true,
  stripeAccountId: "acct_test_123",
  stripeChargesEnabled: true,
  type: "ARTIST",
  customDomain: null,
  customDomainVerified: false,
};

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/stripe/checkout", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "1.2.3.4" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  checkRateLimit.mockResolvedValue(true);
  getTenantBySlug.mockResolvedValue(VALID_TENANT);
  artworkUpdateRows.value = [{ id: "art-1", title: "Painting", price: 10000, tenantId: "tenant-1" }];
  stripeCheckoutCreate.mockResolvedValue({ url: "https://checkout.stripe.com/pay/cs_test" });
});

describe("checkout route — rate limiting", () => {
  it("returns 429 when rate limit is exceeded", async () => {
    checkRateLimit.mockResolvedValueOnce(false);
    const res = await POST(makeRequest({ artworkId: "a-1", slug: "gallery-a", fulfillmentType: "SHIP" }));
    expect(res.status).toBe(429);
  });
});

describe("checkout route — missing/invalid fields", () => {
  it("returns 400 when artworkId is missing", async () => {
    const res = await POST(makeRequest({ slug: "gallery-a", fulfillmentType: "SHIP" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when slug is missing", async () => {
    const res = await POST(makeRequest({ artworkId: "a-1", fulfillmentType: "SHIP" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when fulfillmentType is missing", async () => {
    const res = await POST(makeRequest({ artworkId: "a-1", slug: "gallery-a" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid fulfillmentType", async () => {
    const res = await POST(makeRequest({ artworkId: "a-1", slug: "gallery-a", fulfillmentType: "DELIVERY" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid fulfillment type/i);
  });
});

describe("checkout route — tenant validation", () => {
  it("returns 400 when tenant is not found", async () => {
    getTenantBySlug.mockResolvedValueOnce(null);
    const res = await POST(makeRequest({ artworkId: "a-1", slug: "unknown", fulfillmentType: "SHIP" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when storefront is disabled", async () => {
    getTenantBySlug.mockResolvedValueOnce({ ...VALID_TENANT, storefrontEnabled: false });
    const res = await POST(makeRequest({ artworkId: "a-1", slug: "gallery-a", fulfillmentType: "SHIP" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/store not available/i);
  });

  it("returns 400 when tenant has no stripeAccountId", async () => {
    getTenantBySlug.mockResolvedValueOnce({ ...VALID_TENANT, stripeAccountId: null });
    const res = await POST(makeRequest({ artworkId: "a-1", slug: "gallery-a", fulfillmentType: "SHIP" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/not accepting payments/i);
  });

  it("returns 400 for FRAMING_JOB on a non-FRAMER tenant", async () => {
    getTenantBySlug.mockResolvedValueOnce({ ...VALID_TENANT, type: "ARTIST" });
    const res = await POST(makeRequest({ artworkId: "a-1", slug: "gallery-a", fulfillmentType: "FRAMING_JOB" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid fulfillment type/i);
  });
});

describe("checkout route — artwork not available", () => {
  it("returns 400 when the conditional UPDATE reserves 0 rows (artwork taken/not available)", async () => {
    artworkUpdateRows.value = []; // UPDATE WHERE status=AVAILABLE matched nothing
    const res = await POST(makeRequest({ artworkId: "art-taken", slug: "gallery-a", fulfillmentType: "SHIP" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/not available/i);
  });
});
