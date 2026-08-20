/**
 * bulkSetInquiriesStatus — cross-tenant isolation — real-DB integration.
 *
 * Task #73: "Confirm bulk mark-as-handled can't touch another gallery's inquiries."
 *
 * The unit test (inquiry-bulk-mark-handled-tenant-scope.test.ts) uses a mocked DB.
 * This integration suite verifies the WHERE tenantId clause on real PostgreSQL:
 *
 *  1. Own inquiries → status set to HANDLED.
 *  2. Foreign inquiry IDs in the batch → remain NEW (not touched).
 *  3. Purely foreign batch (no own inquiries) → no-op, no error.
 *  4. Purely foreign batch resetting HANDLED → no-op, no error.
 *  5. Mixed batch (own + foreign) → only own inquiries updated.
 *  6. Empty batch → no-op, no error.
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

// ── Auth ──────────────────────────────────────────────────────────────────────
const mockSession = { userId: "u-bulk-owner", tenantId: "PLACEHOLDER", role: "owner" };
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
}));
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { bulkSetInquiriesStatus } from "@/app/(admin)/(gated)/inquiries/actions";
// bulkSetInquiriesStatus(inquiryIds: string[], status) — plain arrays, not FormData

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdInquiryIds: string[] = [];

function uid() { return `${randomUUID()}-bhi-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Bulk Handled Test Gallery", type: "ARTIST",
    billingExempt: true, subscriptionStatus: "active",
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Test Artwork", sku: `sku-${id}`, status: "AVAILABLE",
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createInquiry(
  tenantId: string,
  artworkId: string,
  status = "NEW",
) {
  const id = uid();
  await db.insert(inquiriesTable).values({
    id, tenantId, artworkId,
    artworkTitle: "Test Artwork",
    buyerName: "Buyer", buyerEmail: "buyer@example.com",
    message: "Is this available?",
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

describeIntegration("bulkSetInquiriesStatus — cross-tenant isolation — real-DB integration", () => {
  it("own inquiries → status set to HANDLED", async () => {
    const tenantId = await createTenant();
    mockSession.tenantId = tenantId;
    const artworkId = await createArtwork(tenantId);
    const inq1 = await createInquiry(tenantId, artworkId);
    const inq2 = await createInquiry(tenantId, artworkId);

    await bulkSetInquiriesStatus([inq1, inq2], "HANDLED");

    const rows = await db.query.inquiriesTable.findMany({
      where: eq(inquiriesTable.tenantId, tenantId),
    });
    for (const row of rows) {
      expect(row.status).toBe("HANDLED");
    }
  });

  it("foreign inquiry IDs → remain NEW, not touched", async () => {
    const ownTenantId = await createTenant();
    const foreignTenantId = await createTenant();
    mockSession.tenantId = ownTenantId;

    const ownArtworkId = await createArtwork(ownTenantId);
    const foreignArtworkId = await createArtwork(foreignTenantId);
    // Create one own inquiry so the batch is non-empty (action rejects empty batches).
    const ownInq = await createInquiry(ownTenantId, ownArtworkId);
    const foreignInq = await createInquiry(foreignTenantId, foreignArtworkId);

    await bulkSetInquiriesStatus([ownInq, foreignInq], "HANDLED");

    const foreign = await db.query.inquiriesTable.findFirst({
      where: eq(inquiriesTable.id, foreignInq),
    });
    expect(foreign?.status).toBe("NEW");
  });

  it("purely foreign inquiry IDs with no own inquiries → resolves without touching the foreign inquiry", async () => {
    const ownTenantId = await createTenant();
    const foreignTenantId = await createTenant();
    mockSession.tenantId = ownTenantId;

    const foreignArtworkId = await createArtwork(foreignTenantId);
    const foreignInq = await createInquiry(foreignTenantId, foreignArtworkId);

    await expect(
      bulkSetInquiriesStatus([foreignInq], "HANDLED"),
    ).resolves.not.toThrow();

    const foreign = await db.query.inquiriesTable.findFirst({
      where: eq(inquiriesTable.id, foreignInq),
    });
    expect(foreign).toBeDefined();
    expect(foreign?.status).toBe("NEW");
  });

  it("purely foreign HANDLED inquiry IDs reset by another tenant → resolves without changing the foreign inquiry", async () => {
    const ownTenantId = await createTenant();
    const foreignTenantId = await createTenant();
    mockSession.tenantId = ownTenantId;

    const foreignArtworkId = await createArtwork(foreignTenantId);
    const foreignInq = await createInquiry(
      foreignTenantId,
      foreignArtworkId,
      "HANDLED",
    );

    await expect(
      bulkSetInquiriesStatus([foreignInq], "NEW"),
    ).resolves.not.toThrow();

    const foreign = await db.query.inquiriesTable.findFirst({
      where: eq(inquiriesTable.id, foreignInq),
    });
    expect(foreign).toBeDefined();
    expect(foreign?.status).toBe("HANDLED");
  });

  it("mixed batch (own + foreign) → only own inquiry updated", async () => {
    const ownTenantId = await createTenant();
    const foreignTenantId = await createTenant();
    mockSession.tenantId = ownTenantId;

    const ownArtworkId = await createArtwork(ownTenantId);
    const foreignArtworkId = await createArtwork(foreignTenantId);

    const ownInq = await createInquiry(ownTenantId, ownArtworkId);
    const foreignInq = await createInquiry(foreignTenantId, foreignArtworkId);

    await bulkSetInquiriesStatus([ownInq, foreignInq], "HANDLED");

    const own = await db.query.inquiriesTable.findFirst({
      where: eq(inquiriesTable.id, ownInq),
    });
    const foreign = await db.query.inquiriesTable.findFirst({
      where: eq(inquiriesTable.id, foreignInq),
    });

    expect(own?.status).toBe("HANDLED");
    expect(foreign?.status).toBe("NEW");
  });

  it("empty batch → resolves as a silent no-op", async () => {
    const tenantId = await createTenant();
    mockSession.tenantId = tenantId;

    await expect(bulkSetInquiriesStatus([], "HANDLED")).resolves.not.toThrow();
  });
});
