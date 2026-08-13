/**
 * Checkout route — invalid / missing inputs — real-DB integration.
 *
 * app/api/stripe/checkout/route.ts:42-66:
 *   Validates artworkId, slug, fulfillmentType presence (400 if missing).
 *   Validates fulfillmentType is a recognised enum value (400).
 *   Validates tenant exists by slug (400).
 *   No DB or Stripe side-effects for any of these error paths.
 *
 *  1. Missing artworkId → 400, no DB write.
 *  2. Missing slug → 400.
 *  3. Missing fulfillmentType → 400.
 *  4. Invalid fulfillmentType string → 400.
 *  5. Unknown slug (tenant not found) → 400.
 *  6. Valid inputs but artwork not found for tenant → 400.
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

function uid() { return `${randomUUID()}-ciii-${RUN}-${++seq}`; }

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => true),
}));
vi.mock("@/lib/tenant-cache", () => ({
  getTenantBySlug: vi.fn(async (slug: string) => {
    return db.query.tenantsTable.findFirst({ where: eq(tenantsTable.slug, slug) });
  }),
}));
vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(),
  calcApplicationFee: vi.fn(() => 0),
  calcApplicationFeeForTenant: vi.fn().mockReturnValue({ feeCents: 500, commissionBasisPoints: 500 }),
  StripeNotConfiguredError: class extends Error {},
}));

import { POST as checkoutPOST } from "@/app/api/stripe/checkout/route";

function post(body: Record<string, string | undefined>) {
  return checkoutPOST(new Request("http://localhost/api/stripe/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Invalid Input Test", type: "ARTIST",
    storefrontEnabled: true,
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id, slug: id };
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Test Art", sku: `sku-${id}`,
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

describeIntegration("Checkout route — invalid/missing inputs — real-DB integration", () => {
  it("missing artworkId → 400", async () => {
    const { slug } = await createTenant();
    const res = await post({ slug, fulfillmentType: "PICKUP" }); // no artworkId
    expect(res.status).toBe(400);
  });

  it("missing slug → 400", async () => {
    const { tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const res = await post({ artworkId, fulfillmentType: "PICKUP" }); // no slug
    expect(res.status).toBe(400);
  });

  it("missing fulfillmentType → 400", async () => {
    const { slug, tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const res = await post({ artworkId, slug }); // no fulfillmentType
    expect(res.status).toBe(400);
  });

  it("invalid fulfillmentType string → 400", async () => {
    const { slug, tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const res = await post({ artworkId, slug, fulfillmentType: "MAGIC_DELIVERY" });
    expect(res.status).toBe(400);
  });

  it("unknown slug (tenant not found) → 400", async () => {
    const res = await post({
      artworkId: `artwork-${uid()}`,
      slug: `unknown-slug-${uid()}`,
      fulfillmentType: "PICKUP",
    });
    expect(res.status).toBe(400);
  });

  it("valid inputs but artwork not found for tenant → 400", async () => {
    const { slug } = await createTenant();
    const res = await post({
      artworkId: `nonexistent-artwork-${uid()}`,
      slug,
      fulfillmentType: "PICKUP",
    });
    expect(res.status).toBe(400);
  });
});
