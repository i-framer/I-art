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
const freightSettings = vi.hoisted(() => ({ value: null as any }));
const freightMethods = vi.hoisted(() => ({ value: [] as any[] }));
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
      freightSettingsTable: {
        findFirst: vi.fn(async () => freightSettings.value),
      },
      freightMethodsTable: {
        findMany: vi.fn(async () => freightMethods.value),
      },
    },
  },
  artworksTable: {
    id: "artwork.id",
    tenantId: "artwork.tenantId",
    status: "artwork.status",
    showInGallery: "artwork.showInGallery",
  },
  artworkImagesTable: { artworkId: "image.artworkId", isPrimary: "image.isPrimary" },
  freightSettingsTable: { tenantId: "settings.tenantId" },
  freightMethodsTable: {
    id: "method.id",
    tenantId: "method.tenantId",
    enabled: "method.enabled",
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

function request(freightMethodId?: string) {
  return new Request("http://localhost/api/stripe/checkout", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.42" },
    body: JSON.stringify({
      artworkId: "artwork-a",
      slug: "gallery-a",
      fulfillmentType: "SHIP",
      freightMethodId,
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
  freightSettings.value = { tenantId: "tenant-a", smallMaxMm: 800, mediumMaxMm: 1500 };
  freightMethods.value = [
    {
      id: "freight-a",
      tenantId: "tenant-a",
      name: "Australia Post",
      smallCents: 1500,
      mediumCents: 2500,
      largeCents: 4500,
      tubeCents: 2000,
      enabled: true,
    },
  ];
  checkoutCreate.mockResolvedValue({ url: "https://checkout.stripe.test/session" });
});

describe("checkout freight", () => {
  it("uses the gallery method and calculated class for the Stripe freight line item", async () => {
    const response = await POST(request("freight-a"));
    expect(response.status).toBe(200);

    const params = checkoutCreate.mock.calls[0]?.[0];
    expect(params.metadata).toMatchObject({
      freightMethodId: "freight-a",
      freightMethodName: "Australia Post",
      freightClass: "MEDIUM",
      freightCents: "2500",
    });
    expect(params.line_items).toHaveLength(2);
    expect(params.line_items[0].price_data.unit_amount).toBe(10_000);
    expect(params.line_items[1].price_data).toMatchObject({
      unit_amount: 2500,
      product_data: { name: "Freight — Australia Post" },
    });
    // The platform commission remains based on the artwork, not freight.
    expect(params.payment_intent_data.application_fee_amount).toBe(500);
  });

  it("rejects a freight method that is not one of the gallery's enabled methods", async () => {
    const response = await POST(request("method-from-another-gallery"));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/no longer available/i),
    });
    expect(checkoutCreate).not.toHaveBeenCalled();
  });

  it("blocks shipping when a gallery has freight methods but all are disabled", async () => {
    freightMethods.value = [{ ...freightMethods.value[0], enabled: false }];

    const response = await POST(request());
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/delivery is not currently available/i),
    });
    expect(checkoutCreate).not.toHaveBeenCalled();
  });

  it("keeps a selected free freight service as an explicit Stripe line item", async () => {
    freightMethods.value = [{ ...freightMethods.value[0], mediumCents: 0 }];

    const response = await POST(request("freight-a"));
    expect(response.status).toBe(200);

    const params = checkoutCreate.mock.calls[0]?.[0];
    expect(params.line_items).toHaveLength(2);
    expect(params.line_items[1].price_data).toMatchObject({
      unit_amount: 0,
      product_data: { name: "Freight — Australia Post" },
    });
    expect(params.metadata).toMatchObject({
      freightMethodName: "Australia Post",
      freightCents: "0",
    });
  });
});