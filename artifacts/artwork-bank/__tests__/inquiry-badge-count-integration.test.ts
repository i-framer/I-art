/**
 * getNewInquiryCount — real-DB integration.
 *
 * Task #36: "New-inquiry badge without refresh."
 *
 * The badge component polls this action every 30s.  This suite verifies the
 * count query against real PostgreSQL:
 *
 *  1. Only NEW + unarchived inquiries for the session tenant are counted.
 *  2. HANDLED inquiries are not counted.
 *  3. Archived (archivedAt non-null) inquiries are not counted.
 *  4. Inquiries from another tenant are not counted.
 *  5. Unauthenticated session returns 0.
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
const mockSession: { userId: string | null; tenantId: string } = {
  userId: "u-badge-owner",
  tenantId: "PLACEHOLDER",
};
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
}));

import { getNewInquiryCount } from "@/app/(admin)/_actions/inquiry-count";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdInquiryIds: string[] = [];

function uid() { return `${randomUUID()}-bdg-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id,
    businessName: "Badge Test Gallery",
    type: "ARTIST",
    billingExempt: true,
  } as any);
  createdTenantIds.push(id);
  mockSession.tenantId = id;
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Badge Artwork", sku: `sku-${id}`, status: "AVAILABLE",
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createInquiry(
  tenantId: string,
  artworkId: string,
  opts: { status?: string; archivedAt?: Date | null } = {},
) {
  const id = uid();
  await db.insert(inquiriesTable).values({
    id, tenantId, artworkId,
    artworkTitle: "Badge Artwork",
    buyerName: "Buyer", buyerEmail: "buyer@example.com",
    message: "Available?",
    status: opts.status ?? "NEW",
    archivedAt: opts.archivedAt ?? null,
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

describeIntegration("getNewInquiryCount — real-DB integration", () => {
  it("counts only NEW + unarchived inquiries for the session tenant", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);

    // 2 qualifying: NEW + unarchived
    await createInquiry(tenantId, artworkId, { status: "NEW", archivedAt: null });
    await createInquiry(tenantId, artworkId, { status: "NEW", archivedAt: null });
    // Not counted: HANDLED
    await createInquiry(tenantId, artworkId, { status: "HANDLED", archivedAt: null });
    // Not counted: archived
    await createInquiry(tenantId, artworkId, { status: "NEW", archivedAt: new Date() });

    const count = await getNewInquiryCount();

    expect(count).toBe(2);
  });

  it("HANDLED inquiries are not counted", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);

    await createInquiry(tenantId, artworkId, { status: "HANDLED", archivedAt: null });
    await createInquiry(tenantId, artworkId, { status: "HANDLED", archivedAt: null });

    const count = await getNewInquiryCount();

    expect(count).toBe(0);
  });

  it("archived inquiries (archivedAt non-null) are not counted", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);

    await createInquiry(tenantId, artworkId, { status: "NEW", archivedAt: new Date(Date.now() - 1000) });

    const count = await getNewInquiryCount();

    expect(count).toBe(0);
  });

  it("inquiries from another tenant are not counted", async () => {
    const ownTenantId = await createTenant();
    const ownArtworkId = await createArtwork(ownTenantId);
    // 1 own qualifying inquiry.
    await createInquiry(ownTenantId, ownArtworkId, { status: "NEW", archivedAt: null });

    // Create a foreign tenant with its own inquiries.
    const foreignTenantId = uid();
    await db.insert(tenantsTable).values({
      id: foreignTenantId, slug: foreignTenantId,
      businessName: "Foreign Gallery", type: "ARTIST",
    } as any);
    createdTenantIds.push(foreignTenantId);
    const foreignArtworkId = uid();
    await db.insert(artworksTable).values({
      id: foreignArtworkId, tenantId: foreignTenantId,
      title: "Foreign", sku: `sku-${foreignArtworkId}`, status: "AVAILABLE",
    } as any);
    createdArtworkIds.push(foreignArtworkId);
    await createInquiry(foreignTenantId, foreignArtworkId, { status: "NEW", archivedAt: null });
    await createInquiry(foreignTenantId, foreignArtworkId, { status: "NEW", archivedAt: null });

    // Session is still on ownTenantId.
    mockSession.tenantId = ownTenantId;
    const count = await getNewInquiryCount();

    expect(count).toBe(1);
  });

  it("unauthenticated session returns 0", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    await createInquiry(tenantId, artworkId, { status: "NEW" });

    mockSession.userId = null;
    const count = await getNewInquiryCount();
    mockSession.userId = "u-badge-owner";

    expect(count).toBe(0);
  });
});
