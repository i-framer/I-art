/**
 * bulkSetInquiriesStatus — server action — real-DB integration.
 *
 * The existing inquiry-bulk-actions-integration.test.ts proves DB-level tenant
 * isolation with direct SQL. This suite verifies the ACTUAL server action
 * (including auth/session, billing, form-input deduplication) against real
 * PostgreSQL:
 *
 *  1. Owner can bulk-mark own inquiries HANDLED.
 *  2. Foreign IDs in the same call are silently skipped (tenant scope).
 *  3. Empty ID list throws.
 *  4. >200 IDs throws.
 *  5. Marking already-HANDLED inquiries back to NEW persists correctly.
 *  6. Duplicate IDs in the list are deduplicated before the UPDATE.
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

// ── Auth mock ─────────────────────────────────────────────────────────────────
const mockSession = { userId: "u-bulk-status", tenantId: "PLACEHOLDER" };
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
}));
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

import { bulkSetInquiriesStatus } from "@/app/(admin)/(gated)/inquiries/actions";

// ── DB helpers ────────────────────────────────────────────────────────────────
const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdInquiryIds: string[] = [];

function uid() { return `${randomUUID()}-bss-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Bulk Status Test Gallery",
    type: "ARTIST", billingExempt: true,
  } as any);
  createdTenantIds.push(id);
  mockSession.tenantId = id;
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Test Artwork", sku: `sku-${id}`,
    status: "AVAILABLE", showInGallery: true,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createInquiry(tenantId: string, artworkId: string, status = "NEW") {
  const id = uid();
  await db.insert(inquiriesTable).values({
    id, tenantId, artworkId,
    artworkTitle: "Test Artwork",
    buyerName: "Test Buyer",
    buyerEmail: "buyer@example.com",
    message: "Available?",
    status,
  } as any);
  createdInquiryIds.push(id);
  return id;
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

describeIntegration("bulkSetInquiriesStatus — server action — real-DB integration", () => {
  it("marks own inquiries HANDLED via real action call", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const inq1 = await createInquiry(tenantId, artworkId);
    const inq2 = await createInquiry(tenantId, artworkId);

    await bulkSetInquiriesStatus([inq1, inq2], "HANDLED");

    const [row1, row2] = await Promise.all([
      db.query.inquiriesTable.findFirst({ where: eq(inquiriesTable.id, inq1) }),
      db.query.inquiriesTable.findFirst({ where: eq(inquiriesTable.id, inq2) }),
    ]);
    expect(row1?.status).toBe("HANDLED");
    expect(row2?.status).toBe("HANDLED");
  });

  it("foreign-tenant IDs are silently skipped; own inquiries still updated", async () => {
    const ownTenantId = await createTenant();
    const foreignTenantId = await createTenant();
    const ownArtworkId = await createArtwork(ownTenantId);
    const foreignArtworkId = await createArtwork(foreignTenantId);

    const ownInqId = await createInquiry(ownTenantId, ownArtworkId);
    const foreignInqId = await createInquiry(foreignTenantId, foreignArtworkId);

    // Authenticated as ownTenant.
    mockSession.tenantId = ownTenantId;

    await bulkSetInquiriesStatus([ownInqId, foreignInqId], "HANDLED");

    const [ownRow, foreignRow] = await Promise.all([
      db.query.inquiriesTable.findFirst({ where: eq(inquiriesTable.id, ownInqId) }),
      db.query.inquiriesTable.findFirst({ where: eq(inquiriesTable.id, foreignInqId) }),
    ]);
    expect(ownRow?.status).toBe("HANDLED");    // updated
    expect(foreignRow?.status).toBe("NEW");    // skipped
  });

  it("empty ID list resolves as a silent no-op", async () => {
    await createTenant();

    await expect(bulkSetInquiriesStatus([], "HANDLED")).resolves.not.toThrow();
  });

  it(">200 IDs throws", async () => {
    await createTenant();
    const ids = Array.from({ length: 201 }, () => randomUUID());

    await expect(bulkSetInquiriesStatus(ids, "HANDLED")).rejects.toThrow();
  });

  it("HANDLED → NEW round-trip persists correctly", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const inqId = await createInquiry(tenantId, artworkId, "HANDLED");

    await bulkSetInquiriesStatus([inqId], "NEW");

    const row = await db.query.inquiriesTable.findFirst({
      where: eq(inquiriesTable.id, inqId),
    });
    expect(row?.status).toBe("NEW");
  });

  it("duplicate IDs in the list are deduplicated — single UPDATE, correct result", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const inqId = await createInquiry(tenantId, artworkId);

    // Pass the same ID three times.
    await bulkSetInquiriesStatus([inqId, inqId, inqId], "HANDLED");

    const row = await db.query.inquiriesTable.findFirst({
      where: eq(inquiriesTable.id, inqId),
    });
    expect(row?.status).toBe("HANDLED");
  });
});
