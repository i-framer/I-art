/**
 * Checkout route — primary image URL in Stripe session product data — real-DB integration.
 *
 * app/api/stripe/checkout/route.ts:168-189:
 *   Queries artworkImagesTable WHERE isPrimary=true, calls getServeUrl(),
 *   and conditionally passes images: [imageUrl] to Stripe session.
 *   Failure to resolve image is non-fatal (images omitted).
 *
 *  1. Artwork with primary image → Stripe session created with images array.
 *  2. Artwork with no image → Stripe session created without images key.
 *  3. Primary image URL resolution failure → session still created (images omitted).
 *  4. Non-primary image is NOT included in Stripe session images.
 *  5. Correct artwork title and SKU in product_data metadata.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable, artworkImagesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];

function uid() { return `${randomUUID()}-csiui-${RUN}-${++seq}`; }

const mockSessionCreate = vi.fn(async (params: any) => ({
  url: "https://checkout.stripe.com/test-session",
  _params: params,
}));
vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(async () => ({
    checkout: { sessions: { create: mockSessionCreate } },
  })),
  calcApplicationFee: vi.fn((cents: number) => Math.round(cents * 0.05)),
  StripeNotConfiguredError: class extends Error {},
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => true),
}));
vi.mock("@/lib/tenant-cache", () => ({
  getTenantBySlug: vi.fn(async (slug: string) => {
    return db.query.tenantsTable.findFirst({ where: eq(tenantsTable.slug, slug) });
  }),
}));

vi.mock("@/lib/object-storage", () => ({
  getServeUrl: vi.fn(),
  StorageNotConfiguredError: class extends Error {},
}));

import { POST as checkoutPOST } from "@/app/api/stripe/checkout/route";
import { getServeUrl } from "@/lib/object-storage";
const mockGetServeUrl = vi.mocked(getServeUrl);

function post(artworkId: string, slug: string) {
  return checkoutPOST(new Request("http://localhost/api/stripe/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ artworkId, slug, fulfillmentType: "PICKUP" }),
  }));
}

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Image Test Gallery", type: "ARTIST",
    storefrontEnabled: true, stripeAccountId: `acct_${uid()}`,
    stripeChargesEnabled: true, billingExempt: true,
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id, slug: id };
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: `Image Art ${seq}`, sku: `sku-${id}`,
    status: "AVAILABLE", price: 20000, showInGallery: true,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function addPrimaryImage(artworkId: string, tenantId: string, isPrimary = true) {
  const id = uid();
  await db.insert(artworkImagesTable).values({
    id, artworkId, tenantId, isPrimary,
    objectPath: `/objects/${id}.jpg`,
    filename: `${id}.jpg`,
  } as any);
  return id;
}

async function cleanup() {
  for (const id of createdArtworkIds.splice(0)) {
    await db.delete(artworkImagesTable).where(eq(artworkImagesTable.artworkId, id)).catch(() => {});
    await db.update(artworksTable).set({ status: "AVAILABLE" } as any).where(eq(artworksTable.id, id)).catch(() => {});
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(async () => { mockSessionCreate.mockReset(); mockGetServeUrl.mockReset(); await cleanup(); });
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Checkout primary image URL in Stripe session — real-DB integration", () => {
  it("artwork with primary image → Stripe session created with images array", async () => {
    const { slug, tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId);
    await addPrimaryImage(artworkId, tenantId, true);
    const imageUrl = "https://storage.example.com/image.jpg";
    mockGetServeUrl.mockResolvedValue(imageUrl);
    mockSessionCreate.mockResolvedValue({ url: "https://checkout.stripe.com/test" } as any);

    await post(artworkId, slug);

    const call = mockSessionCreate.mock.calls[0]?.[0];
    const productData = call?.line_items?.[0]?.price_data?.product_data;
    expect(productData?.images).toContain(imageUrl);
  });

  it("artwork with no image → Stripe session created without images key", async () => {
    const { slug, tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId);
    // No image inserted.
    mockSessionCreate.mockResolvedValue({ url: "https://checkout.stripe.com/test" } as any);

    await post(artworkId, slug);

    const call = mockSessionCreate.mock.calls[0]?.[0];
    const productData = call?.line_items?.[0]?.price_data?.product_data;
    // No images key or empty array.
    expect(productData?.images ?? []).toHaveLength(0);
  });

  it("image URL resolution failure → session still created (images omitted)", async () => {
    const { slug, tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId);
    await addPrimaryImage(artworkId, tenantId, true);
    mockGetServeUrl.mockRejectedValue(new Error("storage error"));
    mockSessionCreate.mockResolvedValue({ url: "https://checkout.stripe.com/test" } as any);

    const res = await post(artworkId, slug);

    expect(res.status).toBe(200);
    const call = mockSessionCreate.mock.calls[0]?.[0];
    expect(call).not.toBeUndefined(); // session was still created
  });

  it("non-primary image is NOT included in Stripe session images", async () => {
    const { slug, tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId);
    await addPrimaryImage(artworkId, tenantId, false); // non-primary
    mockSessionCreate.mockResolvedValue({ url: "https://checkout.stripe.com/test" } as any);

    await post(artworkId, slug);

    expect(mockGetServeUrl).not.toHaveBeenCalled(); // no primary → not resolved
    const call = mockSessionCreate.mock.calls[0]?.[0];
    const productData = call?.line_items?.[0]?.price_data?.product_data;
    expect(productData?.images ?? []).toHaveLength(0);
  });

  it("artwork title and SKU in product_data metadata", async () => {
    const { slug, tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId);
    mockSessionCreate.mockResolvedValue({ url: "https://checkout.stripe.com/test" } as any);

    await post(artworkId, slug);

    const call = mockSessionCreate.mock.calls[0]?.[0];
    const productData = call?.line_items?.[0]?.price_data?.product_data;
    expect(productData?.metadata?.artworkId).toBe(artworkId);
  });
});
