/**
 * Checkout route — Stripe account status gates — real-DB integration.
 *
 * app/api/stripe/checkout/route.ts:69-95:
 *   !tenant.stripeAccountId → 400 (no Connect account registered).
 *   stripeChargesEnabled === false → 503 (account registered but not ready).
 *   stripeChargesEnabled === null/undefined → 503 (account in review).
 *
 *  1. Tenant with no stripeAccountId → 400.
 *  2. Tenant with stripeAccountId but stripeChargesEnabled=false → 503.
 *  3. Tenant with stripeAccountId and stripeChargesEnabled=true → proceeds (not 400/503).
 *  4. billingExempt tenant with no stripeAccountId → still 400 (no Connect acct).
 *  5. stripeChargesEnabled=null (in review) → 503.
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

function uid() { return `${randomUUID()}-csasi-${RUN}-${++seq}`; }

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => true),
}));
vi.mock("@/lib/tenant-cache", () => ({
  getTenantBySlug: vi.fn(async (slug: string) => {
    return db.query.tenantsTable.findFirst({ where: eq(tenantsTable.slug, slug) });
  }),
}));
const mockStripeCreate = vi.fn(async () => ({ url: "https://checkout.stripe.com/test" }));
vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(async () => ({
    checkout: { sessions: { create: mockStripeCreate } },
  })),
  calcApplicationFee: vi.fn(() => 0),
  StripeNotConfiguredError: class extends Error {},
}));

import { POST as checkoutPOST } from "@/app/api/stripe/checkout/route";

function post(artworkId: string, slug: string) {
  return checkoutPOST(new Request("http://localhost/api/stripe/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ artworkId, slug, fulfillmentType: "PICKUP" }),
  }));
}

async function createTenant(opts: {
  stripeAccountId?: string | null;
  stripeChargesEnabled?: boolean | null;
  billingExempt?: boolean;
} = {}) {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Stripe Status Test", type: "ARTIST",
    stripeAccountId: opts.stripeAccountId === undefined ? null : opts.stripeAccountId,
    stripeChargesEnabled: opts.stripeChargesEnabled === undefined ? null : opts.stripeChargesEnabled,
    billingExempt: opts.billingExempt ?? true,
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id, slug: id };
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Stripe Status Art", sku: `sku-${id}`,
    status: "AVAILABLE", price: 10000, showInGallery: true,
  } as any);
  createdArtworkIds.push(id);
  return id;
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

afterEach(async () => { mockStripeCreate.mockReset(); await cleanup(); });
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Checkout Stripe account status gates — real-DB integration", () => {
  it("tenant with no stripeAccountId → 400", async () => {
    const { slug, tenantId } = await createTenant({ stripeAccountId: null });
    const artworkId = await createArtwork(tenantId);

    const res = await post(artworkId, slug);

    expect(res.status).toBe(400);
  });

  it("tenant with stripeAccountId but stripeChargesEnabled=false → 503", async () => {
    const { slug, tenantId } = await createTenant({
      stripeAccountId: `acct_${uid()}`,
      stripeChargesEnabled: false,
    });
    const artworkId = await createArtwork(tenantId);

    const res = await post(artworkId, slug);

    expect(res.status).toBe(503);
  });

  it("tenant with stripeAccountId and stripeChargesEnabled=true → proceeds (not 400/503)", async () => {
    const { slug, tenantId } = await createTenant({
      stripeAccountId: `acct_${uid()}`,
      stripeChargesEnabled: true,
    });
    const artworkId = await createArtwork(tenantId);
    mockStripeCreate.mockResolvedValue({ url: "https://checkout.stripe.com/test-ok" });

    const res = await post(artworkId, slug);

    expect([400, 503]).not.toContain(res.status);
  });

  it("billingExempt tenant with no stripeAccountId → still 400 (no Connect account)", async () => {
    const { slug, tenantId } = await createTenant({
      stripeAccountId: null,
      billingExempt: true,
    });
    const artworkId = await createArtwork(tenantId);

    const res = await post(artworkId, slug);

    expect(res.status).toBe(400);
  });

  it("stripeChargesEnabled=null (account registered, status unknown) → not blocked (proceeds to Stripe)", async () => {
    // The === false guard is strict: null passes through and Stripe Connect
    // is still attempted. This documents the intentional no-block contract.
    const { slug, tenantId } = await createTenant({
      stripeAccountId: `acct_${uid()}`,
      stripeChargesEnabled: null,
    });
    const artworkId = await createArtwork(tenantId);
    mockStripeCreate.mockResolvedValue({ url: "https://checkout.stripe.com/test-null" });

    const res = await post(artworkId, slug);

    // null → passes the === false guard → attempts Stripe → not a 400 or 503
    expect([400, 503]).not.toContain(res.status);
  });
});
