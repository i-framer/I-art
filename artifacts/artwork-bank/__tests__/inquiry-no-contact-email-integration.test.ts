/**
 * Inquiry submission — tenant contactEmail missing — real-DB integration.
 *
 * app/t/[slug]/[artworkId]/actions.ts:76-81:
 *   !tenant.contactEmail → "This gallery is not accepting inquiries right now."
 *
 *  1. Tenant with null contactEmail → submitInquiry returns error, no inquiry row.
 *  2. Tenant with empty string contactEmail → same error.
 *  3. Tenant with valid contactEmail → inquiry succeeds (control case).
 *  4. Changing contactEmail to null after a success → next inquiry is blocked.
 *  5. Error message describes the gallery not accepting inquiries.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable, inquiriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];

function uid() { return `${randomUUID()}-incei-${RUN}-${++seq}`; }

vi.mock("@/lib/email", () => ({
  sendArtworkInquiry: vi.fn(async () => true),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => true),
}));
vi.mock("@/lib/base-url", () => ({
  getTenantUrl: vi.fn(() => "https://example.com"),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(() => new Headers()),
}));

import { submitInquiry } from "@/app/t/[slug]/[artworkId]/actions";

async function createTenant(contactEmail: string | null) {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "No Contact Email Test", type: "ARTIST",
    storefrontEnabled: true,
    contactEmail: contactEmail,
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id, slug: id };
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "No Contact Art", sku: `sku-${id}`,
    status: "AVAILABLE", showInGallery: true, price: 10000,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

function inquiryFd() {
  const f = new FormData();
  f.set("name", "Test Buyer");
  f.set("email", "buyer@test.com");
  f.set("message", "Interested!");
  return f;
}

const PREV = { status: "idle" as const, error: "" };

async function inquiryCountForArtwork(artworkId: string) {
  const rows = await db.query.inquiriesTable.findMany({ where: eq(inquiriesTable.artworkId, artworkId) });
  return rows.length;
}

async function cleanup() {
  for (const id of createdArtworkIds.splice(0)) {
    await db.delete(inquiriesTable).where(eq(inquiriesTable.artworkId, id)).catch(() => {});
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Inquiry — tenant contactEmail missing — real-DB integration", () => {
  it("null contactEmail → error status, no inquiry row created", async () => {
    const { slug, tenantId } = await createTenant(null);
    const artworkId = await createArtwork(tenantId);

    const result = await submitInquiry(slug, artworkId, PREV, inquiryFd());

    expect(result.status).toBe("error");
    expect(await inquiryCountForArtwork(artworkId)).toBe(0);
  });

  it("empty string contactEmail → error status, no inquiry row created", async () => {
    const { slug, tenantId } = await createTenant("");
    const artworkId = await createArtwork(tenantId);

    const result = await submitInquiry(slug, artworkId, PREV, inquiryFd());

    expect(result.status).toBe("error");
    expect(await inquiryCountForArtwork(artworkId)).toBe(0);
  });

  it("valid contactEmail → inquiry succeeds (control case)", async () => {
    const { slug, tenantId } = await createTenant("gallery@test.com");
    const artworkId = await createArtwork(tenantId);

    const result = await submitInquiry(slug, artworkId, PREV, inquiryFd());

    expect(result.status).toBe("sent");
    expect(await inquiryCountForArtwork(artworkId)).toBe(1);
  });

  it("clearing contactEmail after a success → next inquiry is blocked", async () => {
    const { slug, tenantId } = await createTenant("gallery@test.com");
    const artworkId = await createArtwork(tenantId);

    // First inquiry succeeds.
    const first = await submitInquiry(slug, artworkId, PREV, inquiryFd());
    expect(first.status).toBe("sent");

    // Clear contactEmail.
    await db.update(tenantsTable).set({ contactEmail: null } as any).where(eq(tenantsTable.id, tenantId));

    // Second inquiry is blocked.
    const second = await submitInquiry(slug, artworkId, PREV, inquiryFd());
    expect(second.status).toBe("error");
    // Still only 1 inquiry row (from the first submission).
    expect(await inquiryCountForArtwork(artworkId)).toBe(1);
  });

  it("error message describes the gallery not accepting inquiries", async () => {
    const { slug, tenantId } = await createTenant(null);
    const artworkId = await createArtwork(tenantId);

    const result = await submitInquiry(slug, artworkId, PREV, inquiryFd());

    expect(result.error.toLowerCase()).toMatch(/not accepting|contact email|inquir/);
  });
});
