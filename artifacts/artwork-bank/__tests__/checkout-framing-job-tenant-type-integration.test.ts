/**
 * Checkout POST — FRAMING_JOB tenant-type validation — real-DB integration.
 *
 * app/api/stripe/checkout/route.ts:99-104:
 *   FRAMING_JOB fulfillmentType is only allowed for tenant.type === "FRAMER".
 *   ARTIST tenants receive 400 with "Invalid fulfillment type for this gallery."
 *
 *  1. ARTIST tenant + FRAMING_JOB → 400 error.
 *  2. ARTIST tenant + FRAMING_JOB → artwork remains AVAILABLE (not reserved).
 *  3. ARTIST tenant + FRAMING_JOB → no Stripe checkout session created.
 *  4. FRAMER tenant + FRAMING_JOB → 200 with Stripe session URL.
 *  5. FRAMER tenant + PICKUP → 200 (PICKUP is allowed for any tenant type).
 *  6. ARTIST tenant + PICKUP → 200 (normal path).
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

function uid() { return `${randomUUID()}-cfjti-${RUN}-${++seq}`; }

const mockStripeSessionCreate = vi.fn(async () => ({
  url: "https://checkout.stripe.com/test-session",
}));
vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(() => ({
    checkout: { sessions: { create: mockStripeSessionCreate } },
  })),
  calcApplicationFee: vi.fn((cents: number) => Math.round(cents * 0.05)),
  StripeNotConfiguredError: class extends Error {},
}));
vi.mock("@/lib/object-storage", () => ({
  getServeUrl: vi.fn(async () => "https://storage.example.com/image.jpg"),
}));
vi.mock("@/lib/tenant-cache", () => ({
  getTenantBySlug: vi.fn(async (slug: string) => {
    return db.query.tenantsTable.findFirst({ where: eq(tenantsTable.slug, slug) });
  }),
}));

import { POST as checkoutPOST } from "@/app/api/stripe/checkout/route";
import { checkRateLimit } from "@/lib/rate-limit";

// Bypass rate limit by using a distinct IP per test.
function post(artworkId: string, slug: string, fulfillmentType: string, testSeq: number) {
  return checkoutPOST(new Request("http://localhost/api/stripe/checkout", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": `192.168.${testSeq % 256}.${(testSeq >> 8) % 256}`,
    },
    body: JSON.stringify({ artworkId, slug, fulfillmentType }),
  }));
}

async function createTenant(type: "ARTIST" | "FRAMER") {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: `${type} Gallery`, type,
    storefrontEnabled: true,
    stripeAccountId: `acct_${uid()}`,
    stripeChargesEnabled: true,
    billingExempt: true,
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id, slug: id };
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Framing Checkout Art", sku: `sku-${id}`,
    status: "AVAILABLE", price: 15000, showInGallery: true,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function artworkStatus(artworkId: string) {
  return (await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, artworkId) }))?.status;
}

async function cleanup() {
  for (const id of createdArtworkIds.splice(0)) {
    await db.update(artworksTable).set({ status: "AVAILABLE" } as any).where(eq(artworksTable.id, id)).catch(() => {});
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(async () => { mockStripeSessionCreate.mockClear(); await cleanup(); });
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Checkout FRAMING_JOB tenant-type validation — real-DB integration", () => {
  it("ARTIST tenant + FRAMING_JOB → 400 error", async () => {
    const { slug, tenantId } = await createTenant("ARTIST");
    const artworkId = await createArtwork(tenantId);
    const s = ++seq;

    const res = await post(artworkId, slug, "FRAMING_JOB", s);

    expect(res.status).toBe(400);
  });

  it("ARTIST tenant + FRAMING_JOB → artwork remains AVAILABLE (not reserved)", async () => {
    const { slug, tenantId } = await createTenant("ARTIST");
    const artworkId = await createArtwork(tenantId);
    const s = ++seq;

    await post(artworkId, slug, "FRAMING_JOB", s);

    expect(await artworkStatus(artworkId)).toBe("AVAILABLE");
  });

  it("ARTIST tenant + FRAMING_JOB → no Stripe session created", async () => {
    const { slug, tenantId } = await createTenant("ARTIST");
    const artworkId = await createArtwork(tenantId);
    const s = ++seq;

    await post(artworkId, slug, "FRAMING_JOB", s);

    expect(mockStripeSessionCreate).not.toHaveBeenCalled();
  });

  it("FRAMER tenant + FRAMING_JOB → Stripe session URL returned (200)", async () => {
    const { slug, tenantId } = await createTenant("FRAMER");
    const artworkId = await createArtwork(tenantId);
    const s = ++seq;

    const res = await post(artworkId, slug, "FRAMING_JOB", s);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.url).toBe("https://checkout.stripe.com/test-session");
  });

  it("FRAMER tenant + PICKUP → 200 (PICKUP allowed for any tenant type)", async () => {
    const { slug, tenantId } = await createTenant("FRAMER");
    const artworkId = await createArtwork(tenantId);
    const s = ++seq;

    const res = await post(artworkId, slug, "PICKUP", s);

    expect(res.status).toBe(200);
  });

  it("ARTIST tenant + PICKUP → 200 (normal path)", async () => {
    const { slug, tenantId } = await createTenant("ARTIST");
    const artworkId = await createArtwork(tenantId);
    const s = ++seq;

    const res = await post(artworkId, slug, "PICKUP", s);

    expect(res.status).toBe(200);
  });
});
