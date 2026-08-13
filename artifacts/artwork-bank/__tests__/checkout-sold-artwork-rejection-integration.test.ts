/**
 * Checkout initiation — SOLD/RESERVED/HIDDEN artwork rejection — real-DB integration.
 *
 * app/api/stripe/checkout/route.ts: the route atomically UPDATEs the artwork
 * to RESERVED only when status = AVAILABLE. All other statuses return 400.
 *
 *  1. SOLD artwork checkout is rejected with 400.
 *  2. SOLD artwork status remains SOLD after rejected checkout.
 *  3. RESERVED artwork checkout is rejected with 400.
 *  4. HIDDEN artwork checkout is rejected with 400.
 *  5. AVAILABLE artwork checkout sets status to RESERVED in the DB.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];

function uid() { return `${randomUUID()}-csar-${RUN}-${++seq}`; }

vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(async () => ({
    checkout: {
      sessions: {
        create: vi.fn(async () => ({ url: "https://stripe.test/checkout" })),
      },
    },
  })),
  calcApplicationFee: vi.fn((amount: number) => Math.round(amount * 0.05)),
  calcApplicationFeeForTenant: vi.fn().mockReturnValue({ feeCents: 500, commissionBasisPoints: 500 }),
  StripeNotConfiguredError: class extends Error {},
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => true),
}));
vi.mock("@/lib/object-storage", () => ({
  getServeUrl: vi.fn(async () => null),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(() => new Headers()),
}));

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Sold Checkout Test Gallery",
    type: "ARTIST", storefrontEnabled: true,
    stripeAccountId: `acct_test_${id}`,
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id, slug: id };
}

async function createArtwork(tenantId: string, status: string, price = 50000) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Checkout Rejection Art",
    sku: `sku-${id}`, status, price, showInGallery: true,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function artworkStatus(artworkId: string) {
  const row = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, artworkId) });
  return row?.status ?? null;
}

async function cleanup() {
  for (const id of createdArtworkIds.splice(0)) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

/** Call the checkout route with the given artwork and slug. */
async function callCheckout(slug: string, artworkId: string) {
  // Inline the tenant-cache mock here so it always returns the right tenant
  // for the slug created in this test, regardless of other test ordering.
  vi.doMock("@/lib/tenant-cache", () => ({
    getTenantBySlug: vi.fn(async (_slug: string) => ({
      id: _slug, slug: _slug, businessName: "Sold Checkout Test Gallery",
      type: "ARTIST", storefrontEnabled: true, stripeAccountId: `acct_test_${_slug}`,
      stripeAccountStatus: "enabled",
    })),
  }));

  const { POST } = await import("@/app/api/stripe/checkout/route");
  const req = new Request("http://localhost/api/stripe/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ artworkId, slug, fulfillmentType: "PICKUP" }),
  });
  return POST(req);
}

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Checkout SOLD/RESERVED/HIDDEN artwork rejection — real-DB integration", () => {
  it("SOLD artwork checkout is rejected with 400", async () => {
    const { tenantId, slug } = await createTenant();
    const artworkId = await createArtwork(tenantId, "SOLD");

    const res = await callCheckout(slug, artworkId);
    expect(res.status).toBe(400);
  });

  it("SOLD artwork status remains SOLD after rejected checkout", async () => {
    const { tenantId, slug } = await createTenant();
    const artworkId = await createArtwork(tenantId, "SOLD");

    await callCheckout(slug, artworkId);

    expect(await artworkStatus(artworkId)).toBe("SOLD");
  });

  it("RESERVED artwork checkout is rejected with 400", async () => {
    const { tenantId, slug } = await createTenant();
    const artworkId = await createArtwork(tenantId, "RESERVED");

    const res = await callCheckout(slug, artworkId);
    expect(res.status).toBe(400);
  });

  it("HIDDEN artwork checkout is rejected with 400", async () => {
    const { tenantId, slug } = await createTenant();
    const artworkId = await createArtwork(tenantId, "HIDDEN");

    const res = await callCheckout(slug, artworkId);
    expect(res.status).toBe(400);
  });

  it("AVAILABLE artwork checkout atomically sets status to RESERVED", async () => {
    const { tenantId, slug } = await createTenant();
    const artworkId = await createArtwork(tenantId, "AVAILABLE");

    await callCheckout(slug, artworkId);

    expect(await artworkStatus(artworkId)).toBe("RESERVED");
  });
});
