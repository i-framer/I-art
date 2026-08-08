/**
 * Checkout POST route — rate limit enforcement — real-DB integration.
 *
 * app/api/stripe/checkout/route.ts:20-36:
 *   checkRateLimit(`checkout:${ip}`, { limit: 5, windowMs: 10 * 60_000 })
 *   Returns 429 with error message when exceeded.
 *
 *  1. First request from an IP succeeds (past rate limiter, hits later validation).
 *  2. Six identical requests from the same IP → sixth returns 429.
 *  3. 429 response includes expected error message text.
 *  4. Different IP has independent allowance (not affected by first IP's usage).
 *  5. After rate limit is hit, the 429 response is not a 5xx.
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

function uid() { return `${randomUUID()}-crli-${RUN}-${++seq}`; }

// Mock Stripe but NOT rate-limit (we want the real Postgres-backed rate limiter).
vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(() => ({
    checkout: {
      sessions: {
        create: vi.fn(async () => ({ url: "https://checkout.stripe.com/test" })),
      },
    },
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

function makeRequest(artworkId: string, slug: string, ip: string) {
  return checkoutPOST(new Request("http://localhost/api/stripe/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ artworkId, slug, fulfillmentType: "PICKUP" }),
  }));
}

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Rate Limit Test Gallery", type: "ARTIST",
    billingExempt: true, storefrontEnabled: true, stripeChargesEnabled: true,
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id, slug: id };
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Rate Limit Art", sku: `sku-${id}`,
    status: "AVAILABLE", price: 10000, showInGallery: true,
  } as any);
  createdArtworkIds.push(id);
  return id;
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

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Checkout POST rate limit enforcement — real-DB integration", () => {
  it("first request from an IP is not rate-limited (gets past the rate limiter)", async () => {
    const { slug, tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const ip = `10.0.${RUN % 256}.${++seq}`;

    const res = await makeRequest(artworkId, slug, ip);

    // Rate limiter passes — it may fail for other reasons (Stripe config etc.)
    // but must NOT return 429 for the first request.
    expect(res.status).not.toBe(429);
  });

  it("six requests from same IP → sixth returns 429", async () => {
    const { slug, tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const ip = `10.1.${RUN % 256}.${++seq}`;

    let lastStatus = 0;
    for (let i = 0; i < 6; i++) {
      const res = await makeRequest(artworkId, slug, ip);
      lastStatus = res.status;
    }

    expect(lastStatus).toBe(429);
  });

  it("429 response includes the rate-limit error message", async () => {
    const { slug, tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const ip = `10.2.${RUN % 256}.${++seq}`;

    let body: { error?: string } = {};
    for (let i = 0; i < 6; i++) {
      const res = await makeRequest(artworkId, slug, ip);
      if (res.status === 429) {
        body = await res.json();
        break;
      }
    }

    expect(body.error).toMatch(/checkout|wait|slow|limit|too many/i);
  });

  it("different IP has independent rate-limit allowance", async () => {
    const { slug, tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const ipA = `10.3.${RUN % 256}.${++seq}`;
    const ipB = `10.4.${RUN % 256}.${++seq}`;

    // Exhaust IP A.
    for (let i = 0; i < 6; i++) {
      await makeRequest(artworkId, slug, ipA);
    }

    // IP B should still be allowed.
    const resB = await makeRequest(artworkId, slug, ipB);
    expect(resB.status).not.toBe(429);
  });

  it("after rate limit is hit, subsequent response is 429 not 5xx", async () => {
    const { slug, tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const ip = `10.5.${RUN % 256}.${++seq}`;

    // Exhaust the limit.
    for (let i = 0; i < 6; i++) {
      await makeRequest(artworkId, slug, ip);
    }

    const res = await makeRequest(artworkId, slug, ip);
    expect(res.status).toBe(429);
    expect(res.status).toBeLessThan(500);
  });
});
