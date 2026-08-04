/**
 * Task #305 — Confirm the checkout session sets the correct commission amount
 * before payment starts.
 *
 * Verifies that the Stripe checkout session is created with
 * payment_intent_data.application_fee_amount equal to the value returned by
 * calcApplicationFee(artwork.price), and that the gallery's connected account
 * receives the transfer (transfer_data.destination = tenant.stripeAccountId).
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

const sessionsCreate = vi.hoisted(() => vi.fn());
const calcApplicationFee = vi.hoisted(() =>
  vi.fn((cents: number) => Math.round(cents * 0.05)),
);

vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn().mockResolvedValue({
    checkout: { sessions: { create: (...a: any[]) => sessionsCreate(...a) } },
  }),
  calcApplicationFee: (cents: number) => calcApplicationFee(cents),
  StripeNotConfiguredError: class StripeNotConfiguredError extends Error {},
}));

// ── Route handler ─────────────────────────────────────────────────────────────

import { POST } from "@/app/api/stripe/checkout/route";

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

beforeEach(() => {
  vi.clearAllMocks();
  sessionsCreate.mockResolvedValue({ url: "https://checkout.stripe.com/cs_test_abc" });
  calcApplicationFee.mockImplementation((cents: number) => Math.round(cents * 0.05));
});

describe("POST /api/stripe/checkout — commission amount", () => {
  it("passes application_fee_amount equal to calcApplicationFee(artwork.price)", async () => {
    const res = await POST(checkoutRequest());
    expect(res.status).toBe(200);

    expect(calcApplicationFee).toHaveBeenCalledWith(artwork.price);

    const args = sessionsCreate.mock.calls[0][0];
    const expectedFee = Math.round(artwork.price * 0.05);
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

  it("commission changes proportionally when calcApplicationFee returns a different amount", async () => {
    // Simulate a 10% fee override.
    calcApplicationFee.mockImplementation((cents: number) => Math.round(cents * 0.10));
    await POST(checkoutRequest());
    const args = sessionsCreate.mock.calls[0][0];
    expect(args.payment_intent_data.application_fee_amount).toBe(
      Math.round(artwork.price * 0.10),
    );
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
});
