import { beforeEach, describe, expect, it, vi } from "vitest";

const checkRateLimit = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit }));

const getTenantBySlug = vi.hoisted(() => vi.fn());
vi.mock("@/lib/tenant-cache", () => ({ getTenantBySlug }));

const checkoutCreate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn().mockResolvedValue({
    checkout: { sessions: { create: checkoutCreate } },
  }),
  StripeNotConfiguredError: class extends Error {},
  calcApplicationFeeForTenant: vi.fn().mockReturnValue({
    feeCents: 500,
    commissionBasisPoints: 500,
  }),
}));

const artworkRows = vi.hoisted(() => ({ value: [] as any[] }));
const freightQuote = vi.hoisted(() => ({ value: null as any }));
vi.mock("@workspace/db", () => ({
  db: {
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => artworkRows.value),
        })),
      })),
    })),
    query: {
      artworkImagesTable: { findFirst: vi.fn().mockResolvedValue(null) },
      freightQuotesTable: { findFirst: vi.fn(async () => freightQuote.value) },
    },
  },
  artworksTable: {
    id: "artwork.id",
    tenantId: "artwork.tenantId",
    status: "artwork.status",
    showInGallery: "artwork.showInGallery",
  },
  artworkImagesTable: { artworkId: "image.artworkId", isPrimary: "image.isPrimary" },
  freightQuotesTable: {
    id: "quote.id",
    tenantId: "quote.tenantId",
    artworkId: "quote.artworkId",
    expiresAt: "quote.expiresAt",
  },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), { status: init?.status ?? 200 }),
  },
}));
vi.mock("@/lib/object-storage", () => ({ getServeUrl: vi.fn() }));

import { POST } from "@/app/api/stripe/checkout/route";

const tenant = {
  id: "tenant-a",
  slug: "gallery-a",
  storefrontEnabled: true,
  stripeAccountId: "acct_123",
  stripeChargesEnabled: true,
  type: "ARTIST",
  customDomain: null,
  customDomainVerified: false,
  commissionBasisPoints: null,
};

function request(freightQuoteId?: string) {
  return new Request("http://localhost/api/stripe/checkout", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.42" },
    body: JSON.stringify({
      artworkId: "artwork-a",
      slug: "gallery-a",
      fulfillmentType: "SHIP",
      freightQuoteId,
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getTenantBySlug.mockResolvedValue(tenant);
  artworkRows.value = [
    {
      id: "artwork-a",
      tenantId: "tenant-a",
      title: "Ocean Study",
      sku: "OCEAN-1",
      medium: "Oil on linen",
      price: 10_000,
      dimensionsW: 900,
      dimensionsH: 700,
      dimensionsD: 40,
      shippingFormat: "STANDARD",
    },
  ];
  freightQuote.value = {
    id: "quote-a",
    tenantId: "tenant-a",
    artworkId: "artwork-a",
    serviceName: "Express Post",
    freightClass: "MEDIUM",
    freightCents: 2500,
    provider: "AUSTRALIA_POST",
    serviceCode: "AUS_PARCEL_EXPRESS",
  };
  checkoutCreate.mockResolvedValue({ url: "https://checkout.stripe.test/session" });
});

describe("checkout freight", () => {
  it("uses a server-stored quote for the Stripe freight line item", async () => {
    const response = await POST(request("quote-a"));
    expect(response.status).toBe(200);

    const params = checkoutCreate.mock.calls[0]?.[0];
    expect(params.metadata).toMatchObject({
      freightQuoteId: "quote-a",
      freightMethodName: "Express Post",
      freightClass: "MEDIUM",
      freightCents: "2500",
      freightProvider: "AUSTRALIA_POST",
      freightServiceCode: "AUS_PARCEL_EXPRESS",
    });
    expect(params.line_items).toHaveLength(2);
    expect(params.line_items[0].price_data.unit_amount).toBe(10_000);
    expect(params.line_items[1].price_data).toMatchObject({
      unit_amount: 2500,
      product_data: { name: "Freight — Express Post" },
    });
    // The platform commission remains based on the artwork, not freight.
    expect(params.payment_intent_data.application_fee_amount).toBe(500);
  });

  it("rejects a quote that is not available for this artwork and gallery", async () => {
    freightQuote.value = null;
    const response = await POST(request("quote-from-another-gallery"));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/expired/i),
    });
    expect(checkoutCreate).not.toHaveBeenCalled();
  });

  it("blocks shipping when the buyer has not selected a quote", async () => {
    const response = await POST(request());
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/select a current freight quote/i),
    });
    expect(checkoutCreate).not.toHaveBeenCalled();
  });

  it("keeps a selected free quote as an explicit Stripe line item", async () => {
    freightQuote.value = { ...freightQuote.value, freightCents: 0 };

    const response = await POST(request("quote-a"));
    expect(response.status).toBe(200);

    const params = checkoutCreate.mock.calls[0]?.[0];
    expect(params.line_items).toHaveLength(2);
    expect(params.line_items[1].price_data).toMatchObject({
      unit_amount: 0,
      product_data: { name: "Freight — Express Post" },
    });
    expect(params.metadata).toMatchObject({
      freightMethodName: "Express Post",
      freightCents: "0",
    });
  });
});