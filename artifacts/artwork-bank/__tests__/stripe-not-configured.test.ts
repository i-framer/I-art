/**
 * Regression tests: checkout and webhook routes must fail gracefully (503,
 * friendly message) when Stripe credentials are missing — no connector
 * available and no STRIPE_SECRET_KEY set.
 *
 * The real lib/stripe.ts is exercised (not mocked) so a future refactor that
 * stops throwing/catching StripeNotConfiguredError breaks these tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Mock heavy/external dependencies of the routes ─────────────────────────
vi.mock("@workspace/db", () => ({
  db: {
    query: {
      artworksTable: { findFirst: vi.fn() },
      artworkImagesTable: { findFirst: vi.fn() },
      ordersTable: { findFirst: vi.fn() },
      tenantsTable: { findFirst: vi.fn() },
    },
    insert: vi.fn(),
    update: vi.fn(),
  },
  artworksTable: { id: "id", tenantId: "tenantId", status: "status", showInGallery: "showInGallery" },
  artworkImagesTable: { artworkId: "artworkId", isPrimary: "isPrimary" },
  ordersTable: { stripeSessionId: "stripeSessionId", id: "id" },
  orderItemsTable: {},
  tenantsTable: { id: "id" },
}));

vi.mock("@/lib/tenant-cache", () => ({
  getTenantBySlug: vi.fn(),
}));

vi.mock("@/lib/object-storage", () => ({
  getServeUrl: vi.fn(),
}));

vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: vi.fn(),
}));

vi.mock("@/lib/iframer", () => ({
  createIFramerJob: vi.fn(),
  IFramerError: class IFramerError extends Error {},
}));

const mockHeaders = vi.fn();
vi.mock("next/headers", () => ({
  headers: () => mockHeaders(),
}));

import { db } from "@workspace/db";
import { getTenantBySlug } from "@/lib/tenant-cache";
import { POST as checkoutPOST } from "@/app/api/stripe/checkout/route";
import { POST as webhookPOST } from "@/app/api/stripe/webhook/route";

const ENV_KEYS = [
  "REPLIT_CONNECTORS_HOSTNAME",
  "REPL_IDENTITY",
  "WEB_REPL_RENEWAL",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_WEBHOOK_DEV_BYPASS",
] as const;

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("POST /api/stripe/checkout with missing Stripe credentials", () => {
  it("returns 503 with a friendly message when getStripeClient throws StripeNotConfiguredError", async () => {
    // Valid tenant + artwork so the request reaches the Stripe client step
    vi.mocked(getTenantBySlug).mockResolvedValue({
      id: "tenant-1",
      storefrontEnabled: true,
      stripeAccountId: "acct_123",
      type: "GALLERY",
      customDomain: null,
      customDomainVerified: false,
    } as any);
    vi.mocked(db.query.artworksTable.findFirst).mockResolvedValue({
      id: "art-1",
      title: "Sunset",
      price: 10_000,
      medium: "Oil",
      sku: "SKU-1",
    } as any);
    vi.mocked(db.query.artworkImagesTable.findFirst).mockResolvedValue(undefined as any);

    const res = await checkoutPOST(
      new Request("http://localhost/api/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          artworkId: "art-1",
          slug: "gallery",
          fulfillmentType: "SHIP",
        }),
      }),
    );

    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toBe(
      "Payments are not configured for this gallery. Please try again later or contact the gallery directly.",
    );
  });
});

describe("POST /api/stripe/webhook with missing Stripe credentials", () => {
  it("returns 503 (not a crash) when a signed webhook arrives but Stripe is not configured", async () => {
    // A webhook secret exists (env) but no secret key / connector — the route
    // must fail with 503 when it can't build a Stripe client to verify.
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    mockHeaders.mockResolvedValue(
      new Headers({ "stripe-signature": "t=1,v1=abc" }),
    );

    const res = await webhookPOST(
      new Request("http://localhost/api/stripe/webhook", {
        method: "POST",
        body: JSON.stringify({ type: "checkout.session.completed" }),
      }),
    );

    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toBe("Payments are not configured.");
  });

  it("returns 400 (rejects, does not crash) when neither webhook secret nor signature exist", async () => {
    mockHeaders.mockResolvedValue(new Headers());

    const res = await webhookPOST(
      new Request("http://localhost/api/stripe/webhook", {
        method: "POST",
        body: "{}",
      }),
    );

    expect(res.status).toBe(400);
  });
});
