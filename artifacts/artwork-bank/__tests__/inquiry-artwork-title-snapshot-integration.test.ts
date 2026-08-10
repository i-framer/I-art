/**
 * Inquiry artworkTitle snapshot — real-DB integration.
 *
 * When a buyer submits an inquiry on the public storefront, the inquiry row
 * records the artwork title at submission time. A subsequent rename of the
 * artwork title must NOT change the stored inquiry.artworkTitle snapshot.
 *
 *  1. Submitted inquiry stores the artwork title at submission time.
 *  2. Renaming artwork AFTER inquiry submission does not change the snapshot.
 *  3. Two inquiries on the same artwork record independent title snapshots.
 *  4. artworkTitle is preserved even when other artwork fields change.
 *  5. Foreign tenant inquiry title is not affected by own tenant artwork rename.
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

function uid() { return `${randomUUID()}-iats-${RUN}-${++seq}`; }

vi.mock("@/lib/email", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...mod,
    sendInquiryNotification: vi.fn(async () => {}),
    sendInquiryConfirmation: vi.fn(async () => {}),
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

async function createTenant(storefrontEnabled = true) {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Title Snapshot Inquiry Gallery",
    type: "ARTIST", storefrontEnabled,
    contactEmail: `gallery-${id}@example.com`,
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id, slug: id };
}

async function createArtwork(tenantId: string, title: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title, sku: `sku-${id}`,
    status: "AVAILABLE", showInGallery: true,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

function _fd(extras: Record<string, string> = {}) {
  return {
    get: (k: string) => extras[k] ?? { name: "Test Buyer", email: "test@buyer.com", message: "Hello", website: "" }[k] ?? null,
    getAll: () => [],
  } as unknown as FormData;
}

async function inquiryTitle(inquiryId: string) {
  const row = await db.query.inquiriesTable.findFirst({ where: eq(inquiriesTable.id, inquiryId) });
  return row?.artworkTitle ?? null;
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

async function submitAndCapture(slug: string, artworkId: string) {
  const f = new FormData();
  f.set("name", "Test Buyer");
  f.set("email", "test@buyer.com");
  f.set("message", "Is this available?");
  f.set("website", "");

  await submitInquiry(slug, artworkId, { status: "idle", error: "" }, f);

  const rows = await db.query.inquiriesTable.findMany({
    where: eq(inquiriesTable.artworkId, artworkId),
  });
  const latest = rows.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))[0];
  if (latest?.id) createdInquiryIds.push(latest.id);
  return latest?.id ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Inquiry artworkTitle snapshot — real-DB integration", () => {
  it("submitted inquiry stores the artwork title at submission time", async () => {
    const { tenantId, slug } = await createTenant();
    const artworkId = await createArtwork(tenantId, "Submission Time Title");

    const inquiryId = await submitAndCapture(slug, artworkId);
    expect(inquiryId).not.toBeNull();
    expect(await inquiryTitle(inquiryId!)).toBe("Submission Time Title");
  });

  it("renaming artwork AFTER inquiry submission does NOT change the snapshot", async () => {
    const { tenantId, slug } = await createTenant();
    const artworkId = await createArtwork(tenantId, "Original Inquiry Title");

    const inquiryId = await submitAndCapture(slug, artworkId);

    // Rename the artwork.
    await db.update(artworksTable)
      .set({ title: "Renamed After Inquiry" })
      .where(eq(artworksTable.id, artworkId));

    expect(await inquiryTitle(inquiryId!)).toBe("Original Inquiry Title");
  });

  it("two inquiries on same artwork record title at their own submission time", async () => {
    const { tenantId, slug } = await createTenant();
    const artworkId = await createArtwork(tenantId, "First Submission Title");

    const inquiry1 = await submitAndCapture(slug, artworkId);
    expect(await inquiryTitle(inquiry1!)).toBe("First Submission Title");

    // Rename before second inquiry.
    await db.update(artworksTable)
      .set({ title: "Second Submission Title" })
      .where(eq(artworksTable.id, artworkId));

    const inquiry2 = await submitAndCapture(slug, artworkId);
    expect(await inquiryTitle(inquiry2!)).toBe("Second Submission Title");

    // First inquiry unchanged.
    expect(await inquiryTitle(inquiry1!)).toBe("First Submission Title");
  });

  it("artworkTitle is preserved even when other artwork fields change (price, status)", async () => {
    const { tenantId, slug } = await createTenant();
    const artworkId = await createArtwork(tenantId, "Preserved Title Art");

    const inquiryId = await submitAndCapture(slug, artworkId);

    await db.update(artworksTable)
      .set({ price: 99900, status: "RESERVED" })
      .where(eq(artworksTable.id, artworkId));

    expect(await inquiryTitle(inquiryId!)).toBe("Preserved Title Art");
  });

  it("foreign tenant inquiry title is unaffected by own tenant artwork rename", async () => {
    const { tenantId: ownId, slug: ownSlug }         = await createTenant();
    const { tenantId: foreignId, slug: foreignSlug } = await createTenant();

    const foreignArtworkId = await createArtwork(foreignId, "Foreign Title");
    const foreignInquiryId = await submitAndCapture(foreignSlug, foreignArtworkId);

    // Own tenant creates and renames its artwork.
    const ownArtworkId = await createArtwork(ownId, "Own Title");
    await submitAndCapture(ownSlug, ownArtworkId);
    await db.update(artworksTable)
      .set({ title: "Renamed Own Title" })
      .where(eq(artworksTable.id, ownArtworkId));

    expect(await inquiryTitle(foreignInquiryId!)).toBe("Foreign Title");
  });
});
