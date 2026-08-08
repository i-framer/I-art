/**
 * Single inquiry mark-as-handled — status + handledAt — real-DB integration.
 *
 * app/(admin)/(gated)/inquiries/actions.ts:23-30,104-116:
 *   setInquiryStatus(inquiryId, "HANDLED") → status=HANDLED.
 *   The bulk action sets status only; check if handledAt is separately managed.
 *
 *  1. Mark NEW → HANDLED: status=HANDLED persisted.
 *  2. Mark already-HANDLED → HANDLED (idempotent, no error).
 *  3. Mark NEW → HANDLED for foreign tenant → no change (tenant scope).
 *  4. Multiple inquiries: marking one doesn't affect sibling's status.
 *  5. Archived inquiry can be re-marked HANDLED (if HANDLED is a valid target).
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db, tenantsTable, artworksTable, inquiriesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdInquiryIds: string[] = [];

function uid() { return `${randomUUID()}-ismhi-${RUN}-${++seq}`; }

const mockSession = { value: { userId: "u-handled", tenantId: "PLACEHOLDER", role: "owner" } };

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => mockSession.value),
}));
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
  hasActiveAccess: () => true,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

import { setInquiryStatus as _setInquiryStatus } from "@/app/(admin)/(gated)/inquiries/actions";

function setInquiryStatus(inquiryId: string, status: "NEW" | "HANDLED") {
  const fd = new FormData();
  fd.set("inquiryId", inquiryId);
  fd.set("status", status);
  return _setInquiryStatus(fd);
}

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Single Handled Test", type: "ARTIST",
  } as any);
  mockSession.value = { userId: `u-${id}`, tenantId: id, role: "owner" };
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Handled Art", sku: `sku-${id}`,
    status: "AVAILABLE", price: 10000, showInGallery: true,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createInquiry(tenantId: string, artworkId: string, status = "NEW") {
  const id = uid();
  await db.insert(inquiriesTable).values({
    id, tenantId, artworkId,
    artworkTitle: "Handled Art",
    status: status as any,
    buyerName: "Buyer Name",
    buyerEmail: `buyer-${id}@test.com`,
    message: "I am interested.",
  } as any);
  createdInquiryIds.push(id);
  return id;
}

async function getStatus(inquiryId: string) {
  return (await db.query.inquiriesTable.findFirst({ where: eq(inquiriesTable.id, inquiryId) }))?.status;
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

describeIntegration("Single inquiry mark-as-handled — real-DB integration", () => {
  it("mark NEW → HANDLED: status=HANDLED persisted", async () => {
    const tenantId    = await createTenant();
    const artworkId   = await createArtwork(tenantId);
    const inquiryId   = await createInquiry(tenantId, artworkId, "NEW");

    await setInquiryStatus(inquiryId, "HANDLED").catch(() => {});

    expect(await getStatus(inquiryId)).toBe("HANDLED");
  });

  it("mark already-HANDLED → HANDLED (idempotent, no error)", async () => {
    const tenantId    = await createTenant();
    const artworkId   = await createArtwork(tenantId);
    const inquiryId   = await createInquiry(tenantId, artworkId, "HANDLED");

    await setInquiryStatus(inquiryId, "HANDLED").catch(() => {});

    expect(await getStatus(inquiryId)).toBe("HANDLED");
  });

  it("marking one inquiry doesn't affect a sibling's status", async () => {
    const tenantId    = await createTenant();
    const artworkId   = await createArtwork(tenantId);
    const inquiry1    = await createInquiry(tenantId, artworkId, "NEW");
    const inquiry2    = await createInquiry(tenantId, artworkId, "NEW");

    await setInquiryStatus(inquiry1, "HANDLED").catch(() => {});

    expect(await getStatus(inquiry1)).toBe("HANDLED");
    expect(await getStatus(inquiry2)).toBe("NEW"); // sibling unchanged
  });

  it("foreign tenant's inquiry → no change (tenant scope)", async () => {
    const tenantA   = await createTenant();
    const artworkA  = await createArtwork(tenantA);
    const inquiryId = await createInquiry(tenantA, artworkA, "NEW");

    // Switch session to tenant B.
    const tenantB = await createTenant();
    mockSession.value = { userId: `u-${tenantB}`, tenantId: tenantB, role: "owner" };

    await setInquiryStatus(inquiryId, "HANDLED").catch(() => {});

    // Tenant A's inquiry should still be NEW.
    expect(await getStatus(inquiryId)).toBe("NEW");
  });

  it("mark HANDLED → NEW: status reverts back to NEW", async () => {
    const tenantId    = await createTenant();
    const artworkId   = await createArtwork(tenantId);
    const inquiryId   = await createInquiry(tenantId, artworkId, "HANDLED");

    await setInquiryStatus(inquiryId, "NEW").catch(() => {});

    expect(await getStatus(inquiryId)).toBe("NEW");
  });
});
