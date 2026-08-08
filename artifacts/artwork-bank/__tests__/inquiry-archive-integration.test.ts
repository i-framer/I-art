/**
 * setInquiryArchived / bulkSetInquiriesArchived — real-DB integration.
 *
 * Existing tests (inquiry-archive-tenant-scope.test.ts,
 * inquiry-bulk-archive-tenant-scope.test.ts) mock the DB.  This suite
 * verifies archive behavior against real PostgreSQL:
 *
 * setInquiryArchived:
 *  1. Archive: archivedAt set to non-null timestamp.
 *  2. Unarchive: archivedAt cleared to null.
 *  3. Cross-tenant: action silently ignores foreign inquiry.
 *
 * bulkSetInquiriesArchived:
 *  4. Own inquiries → all archivedAt set.
 *  5. Foreign inquiry in batch → remains null (not touched).
 *  6. Mixed batch → only own updated.
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
const mockSession = { userId: "u-arch-owner", tenantId: "PLACEHOLDER", role: "owner" };
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
}));
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  setInquiryArchived,
  bulkSetInquiriesArchived,
} from "@/app/(admin)/(gated)/inquiries/actions";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdInquiryIds: string[] = [];

function uid() { return `${randomUUID()}-arch-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Archive Test Gallery", type: "ARTIST",
    billingExempt: true, subscriptionStatus: "active",
  } as any);
  createdTenantIds.push(id);
  mockSession.tenantId = id;
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Archive Artwork", sku: `sku-${id}`, status: "AVAILABLE",
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createInquiry(tenantId: string, artworkId: string) {
  const id = uid();
  await db.insert(inquiriesTable).values({
    id, tenantId, artworkId,
    artworkTitle: "Archive Artwork",
    buyerName: "Buyer", buyerEmail: "buyer@example.com",
    message: "Is it available?", status: "NEW",
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

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("setInquiryArchived / bulkSetInquiriesArchived — real-DB integration", () => {
  // ── setInquiryArchived ────────────────────────────────────────────────────

  it("archive: archivedAt set to non-null timestamp", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const inquiryId = await createInquiry(tenantId, artworkId);

    await setInquiryArchived(fd({ inquiryId, archived: "true" }));

    const row = await db.query.inquiriesTable.findFirst({
      where: eq(inquiriesTable.id, inquiryId),
    });
    expect(row?.archivedAt).not.toBeNull();
  });

  it("unarchive: archivedAt cleared to null", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const inquiryId = await createInquiry(tenantId, artworkId);

    await setInquiryArchived(fd({ inquiryId, archived: "true" }));
    await setInquiryArchived(fd({ inquiryId, archived: "false" }));

    const row = await db.query.inquiriesTable.findFirst({
      where: eq(inquiriesTable.id, inquiryId),
    });
    expect(row?.archivedAt).toBeNull();
  });

  it("cross-tenant: foreign inquiry not touched (action rejects or silently skips)", async () => {
    const ownTenantId = await createTenant();
    const foreignTenantId = uid();
    await db.insert(tenantsTable).values({
      id: foreignTenantId, slug: foreignTenantId,
      businessName: "Foreign Gallery", type: "ARTIST",
    } as any);
    createdTenantIds.push(foreignTenantId);
    const foreignArtworkId = await createArtwork(foreignTenantId);
    const foreignInquiryId = await createInquiry(foreignTenantId, foreignArtworkId);
    mockSession.tenantId = ownTenantId;

    // Action may throw "Inquiry not found." or silently no-op — either is correct.
    try {
      await setInquiryArchived(fd({ inquiryId: foreignInquiryId, archived: "true" }));
    } catch {
      // Expected: action rejects cross-tenant access.
    }

    const row = await db.query.inquiriesTable.findFirst({
      where: eq(inquiriesTable.id, foreignInquiryId),
    });
    // Either way, the foreign inquiry must remain unarchived.
    expect(row?.archivedAt).toBeNull();
  });

  // ── bulkSetInquiriesArchived ──────────────────────────────────────────────

  it("bulk archive: own inquiries → all archivedAt set", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const inq1 = await createInquiry(tenantId, artworkId);
    const inq2 = await createInquiry(tenantId, artworkId);

    await bulkSetInquiriesArchived([inq1, inq2], true);

    for (const id of [inq1, inq2]) {
      const row = await db.query.inquiriesTable.findFirst({
        where: eq(inquiriesTable.id, id),
      });
      expect(row?.archivedAt).not.toBeNull();
    }
  });

  it("bulk archive: foreign inquiry in batch → remains null", async () => {
    const ownTenantId = await createTenant();
    const foreignTenantId = uid();
    await db.insert(tenantsTable).values({
      id: foreignTenantId, slug: foreignTenantId,
      businessName: "Foreign 2", type: "ARTIST",
    } as any);
    createdTenantIds.push(foreignTenantId);
    const ownArtworkId = await createArtwork(ownTenantId);
    const foreignArtworkId = await createArtwork(foreignTenantId);
    const ownInq = await createInquiry(ownTenantId, ownArtworkId);
    const foreignInq = await createInquiry(foreignTenantId, foreignArtworkId);
    mockSession.tenantId = ownTenantId;

    await bulkSetInquiriesArchived([ownInq, foreignInq], true);

    const foreign = await db.query.inquiriesTable.findFirst({
      where: eq(inquiriesTable.id, foreignInq),
    });
    expect(foreign?.archivedAt).toBeNull();
  });

  it("bulk archive: mixed batch → only own inquiry updated", async () => {
    const ownTenantId = await createTenant();
    const foreignTenantId = uid();
    await db.insert(tenantsTable).values({
      id: foreignTenantId, slug: foreignTenantId,
      businessName: "Foreign 3", type: "ARTIST",
    } as any);
    createdTenantIds.push(foreignTenantId);
    const ownArtworkId = await createArtwork(ownTenantId);
    const foreignArtworkId = await createArtwork(foreignTenantId);
    const ownInq = await createInquiry(ownTenantId, ownArtworkId);
    const foreignInq = await createInquiry(foreignTenantId, foreignArtworkId);
    mockSession.tenantId = ownTenantId;

    await bulkSetInquiriesArchived([ownInq, foreignInq], true);

    const own = await db.query.inquiriesTable.findFirst({
      where: eq(inquiriesTable.id, ownInq),
    });
    const foreign = await db.query.inquiriesTable.findFirst({
      where: eq(inquiriesTable.id, foreignInq),
    });

    expect(own?.archivedAt).not.toBeNull();
    expect(foreign?.archivedAt).toBeNull();
  });
});
