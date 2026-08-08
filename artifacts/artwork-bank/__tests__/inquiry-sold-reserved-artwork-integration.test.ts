/**
 * Inquiry submission — artwork status visibility contract — real-DB integration.
 *
 * app/t/[slug]/[artworkId]/actions.ts: submitInquiry(slug, artworkId, prev, formData).
 * The action looks up artwork WHERE showInGallery=true (no status filter).
 * HIDDEN artworks have showInGallery=false and are therefore blocked.
 *
 * Key findings from action code (lines 83-92):
 *   WHERE artworkId AND tenantId AND showInGallery=true
 *   → AVAILABLE/SOLD/RESERVED (all showInGallery=true) are accepted.
 *   → HIDDEN (showInGallery=false) is rejected → "Artwork not found."
 *
 *  1. Inquiry for an AVAILABLE artwork creates an inquiry row.
 *  2. Inquiry for a SOLD artwork (showInGallery=true) also creates a row.
 *  3. Inquiry for a RESERVED artwork (showInGallery=true) creates a row.
 *  4. Inquiry for a HIDDEN artwork (showInGallery=false) does NOT create a row.
 *  5. Inquiry for an artwork from a different tenant is blocked.
 *  6. buyerName/buyerEmail/message are persisted exactly on the row.
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

function uid() { return `${randomUUID()}-israi-${RUN}-${++seq}`; }

vi.mock("@/lib/email", () => ({
  sendArtworkInquiry: vi.fn(async () => true),
  sendInquiryNotification: vi.fn(async () => true),
  sendInquiryAcknowledgement: vi.fn(async () => true),
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

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Inquiry Status Test", type: "ARTIST",
    storefrontEnabled: true,
    contactEmail: `gallery-${id}@test.com`,
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id, slug: id };
}

async function createArtwork(tenantId: string, status: string) {
  const id = uid();
  const showInGallery = status !== "HIDDEN";
  await db.insert(artworksTable).values({
    id, tenantId, title: "Inquiry Art", sku: `sku-${id}`,
    status, showInGallery, price: 20000,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

function inquiryFd(name = "Test Buyer", email = "buyer@test.com", message = "Is this available?") {
  const f = new FormData();
  f.set("name", name);
  f.set("email", email);
  f.set("message", message);
  return f;
}

const PREV: { status: "idle"; error: "" } = { status: "idle", error: "" };

async function inquiryCountForArtwork(artworkId: string) {
  const rows = await db.query.inquiriesTable.findMany({
    where: eq(inquiriesTable.artworkId, artworkId),
  });
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

import { submitInquiry } from "@/app/t/[slug]/[artworkId]/actions";

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Inquiry submission artwork status contract — real-DB integration", () => {
  it("inquiry for an AVAILABLE artwork creates an inquiry row", async () => {
    const { slug, tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId, "AVAILABLE");

    const result = await submitInquiry(slug, artworkId, PREV, inquiryFd());

    expect(result.status).toBe("sent");
    expect(await inquiryCountForArtwork(artworkId)).toBe(1);
  });

  it("inquiry for a SOLD artwork (showInGallery=true) also creates a row", async () => {
    const { slug, tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId, "SOLD");

    const result = await submitInquiry(slug, artworkId, PREV, inquiryFd());

    // Action does not block SOLD artworks — only showInGallery=false blocks.
    expect(result.status).toBe("sent");
    expect(await inquiryCountForArtwork(artworkId)).toBe(1);
  });

  it("inquiry for a RESERVED artwork (showInGallery=true) creates a row", async () => {
    const { slug, tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId, "RESERVED");

    const result = await submitInquiry(slug, artworkId, PREV, inquiryFd());

    expect(result.status).toBe("sent");
    expect(await inquiryCountForArtwork(artworkId)).toBe(1);
  });

  it("inquiry for a HIDDEN artwork (showInGallery=false) does NOT create a row", async () => {
    const { slug, tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId, "HIDDEN");

    const result = await submitInquiry(slug, artworkId, PREV, inquiryFd());

    expect(result.status).toBe("error");
    expect(await inquiryCountForArtwork(artworkId)).toBe(0);
  });

  it("inquiry for an artwork from a different tenant is blocked", async () => {
    const { slug: slugA }     = await createTenant();
    const { tenantId: tenantB } = await createTenant();
    const artworkB = await createArtwork(tenantB, "AVAILABLE");

    // Use slug A but artwork from tenant B.
    const result = await submitInquiry(slugA, artworkB, PREV, inquiryFd());

    expect(result.status).toBe("error");
    expect(await inquiryCountForArtwork(artworkB)).toBe(0);
  });

  it("buyerName/buyerEmail/message are persisted exactly on the inquiry row", async () => {
    const { slug, tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId, "AVAILABLE");

    await submitInquiry(
      slug, artworkId, PREV,
      inquiryFd("Jane Smith", "jane@gallery.com", "Interested in buying this piece."),
    );

    const rows = await db.query.inquiriesTable.findMany({ where: eq(inquiriesTable.artworkId, artworkId) });
    expect(rows[0]?.buyerName).toBe("Jane Smith");
    expect(rows[0]?.buyerEmail).toBe("jane@gallery.com");
    expect(rows[0]?.message).toBe("Interested in buying this piece.");
  });
});
