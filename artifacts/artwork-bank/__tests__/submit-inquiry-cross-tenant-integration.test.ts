/**
 * submitInquiry cross-tenant artwork scoping — real-DB integration.
 *
 * app/t/[slug]/[artworkId]/actions.ts:72-92:
 *   The query requires artwork.tenantId === tenant.id (resolved from slug) AND
 *   artwork.showInGallery === true. If artworkId belongs to a different tenant
 *   than the slug resolves to, the query returns nothing → { status: "error", error: "Artwork not found." }.
 *
 *  1. Submitting tenant A's artwork via tenant B's slug returns "Artwork not found."
 *  2. No inquiry row is inserted when the cross-tenant check fails.
 *  3. Submitting the same artwork via the correct (own) slug succeeds.
 *  4. Cross-tenant failure does not affect the foreign tenant's own inquiries.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  inquiriesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdInquiryIds: string[] = [];

function uid() { return `${randomUUID()}-sict-${RUN}-${++seq}`; }

vi.mock("@/lib/email", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...mod,
    sendArtworkInquiry: vi.fn(async () => true),
  };
});
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => true),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(() => new Headers()),
}));
vi.mock("@/lib/base-url", () => ({
  getTenantUrl: vi.fn((_tenant: unknown, path: string) => `https://example.com${path}`),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { submitInquiry } from "@/app/t/[slug]/[artworkId]/actions";

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Cross-Tenant Inquiry Gallery",
    type: "ARTIST", storefrontEnabled: true,
    contactEmail: `gallery-${id}@example.com`,
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id, slug: id };
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Cross-Tenant Art", sku: `sku-${id}`,
    status: "AVAILABLE", showInGallery: true,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

function fd() {
  const f = new FormData();
  f.set("name", "Test Buyer");
  f.set("email", "test@buyer.com");
  f.set("message", "Is this still available?");
  f.set("website", "");
  return f;
}

async function cleanup() {
  for (const id of createdInquiryIds.splice(0)) {
    await db.delete(inquiriesTable).where(eq(inquiriesTable.id, id)).catch(() => {});
  }
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

describeIntegration("submitInquiry cross-tenant scoping — real-DB integration", () => {
  it("submitting tenant A's artwork via tenant B's slug returns Artwork not found", async () => {
    const { tenantId: tenantA, slug: _slugA } = await createTenant();
    const { tenantId: _tenantB, slug: slugB } = await createTenant();
    const artworkA = await createArtwork(tenantA);

    // Use slugB (tenant B) but artworkId belongs to tenant A.
    const result = await submitInquiry(slugB, artworkA, { status: "idle", error: "" }, fd());

    expect(result.status).toBe("error");
    expect(result.error).toContain("Artwork not found");
  });

  it("no inquiry row is inserted when cross-tenant check fails", async () => {
    const { tenantId: tenantA, slug: _slugA } = await createTenant();
    const { tenantId: _tenantB, slug: slugB } = await createTenant();
    const artworkA = await createArtwork(tenantA);

    await submitInquiry(slugB, artworkA, { status: "idle", error: "" }, fd());

    const rows = await db.query.inquiriesTable.findMany({
      where: eq(inquiriesTable.artworkId, artworkA),
    });
    expect(rows).toHaveLength(0);
  });

  it("submitting the same artwork via its own correct slug succeeds", async () => {
    const { tenantId: tenantA, slug: slugA } = await createTenant();
    const artworkA = await createArtwork(tenantA);

    const result = await submitInquiry(slugA, artworkA, { status: "idle", error: "" }, fd());

    expect(result.status).toBe("sent");

    const rows = await db.query.inquiriesTable.findMany({
      where: eq(inquiriesTable.artworkId, artworkA),
    });
    expect(rows).toHaveLength(1);
    if (rows[0]) createdInquiryIds.push(rows[0].id);
  });

  it("cross-tenant failure does not affect foreign tenant's existing inquiries", async () => {
    const { tenantId: tenantA, slug: _slugA } = await createTenant();
    const { tenantId: tenantB, slug: slugB } = await createTenant();
    const artworkA = await createArtwork(tenantA);
    const artworkB = await createArtwork(tenantB);

    // First: successful inquiry on tenant B's artwork via own slug.
    const r1 = await submitInquiry(slugB, artworkB, { status: "idle", error: "" }, fd());
    expect(r1.status).toBe("sent");
    const foreignRows = await db.query.inquiriesTable.findMany({
      where: eq(inquiriesTable.artworkId, artworkB),
    });
    if (foreignRows[0]) createdInquiryIds.push(foreignRows[0].id);
    expect(foreignRows).toHaveLength(1);

    // Now attempt cross-tenant submission (A's artwork via B's slug).
    await submitInquiry(slugB, artworkA, { status: "idle", error: "" }, fd());

    // B's inquiry must be unaffected.
    const stillForeignRows = await db.query.inquiriesTable.findMany({
      where: eq(inquiriesTable.artworkId, artworkB),
    });
    expect(stillForeignRows).toHaveLength(1);
  });
});
