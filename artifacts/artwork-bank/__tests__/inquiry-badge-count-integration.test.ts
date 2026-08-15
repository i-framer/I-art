/**
 * getNewInquiryCount / getEmailFailCount — real-DB integration.
 *
 * Task #36: "New-inquiry badge without refresh."
 * Task #834: "Failed-email warning banner disappears after inquiry is archived."
 *
 * The badge component polls getNewInquiryCount every 30s.  The warning banner
 * on the Inquiries page uses getEmailFailCount.  This suite verifies both
 * count queries against real PostgreSQL:
 *
 * getNewInquiryCount:
 *  1. Only NEW + unarchived inquiries for the session tenant are counted.
 *  2. HANDLED inquiries are not counted.
 *  3. Archived (archivedAt non-null) inquiries are not counted.
 *  4. Inquiries from another tenant are not counted.
 *  5. Unauthenticated session returns 0.
 *
 * getEmailFailCount:
 *  6. Only non-archived inquiries with emailError set are counted.
 *  7. Archived inquiries with emailError are excluded (banner disappears).
 *  8. Non-archived inquiries without emailError are excluded.
 *  9. Inquiries from another tenant are not counted.
 * 10. Unauthenticated session returns 0.
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
import { MAX_EMAIL_ATTEMPTS } from "@/lib/email-sweep";

// ── Auth ──────────────────────────────────────────────────────────────────────
const mockSession: { userId: string | null; tenantId: string } = {
  userId: "u-badge-owner",
  tenantId: "PLACEHOLDER",
};
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
}));

import {
  getNewInquiryCount,
  getEmailFailCount,
} from "@/app/(admin)/_actions/inquiry-count";

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
  opts: {
    status?: string;
    archivedAt?: Date | null;
    emailError?: string | null;
    /** Set to MAX_EMAIL_ATTEMPTS (or higher) to simulate a permanently-failed inquiry. */
    emailAttempts?: number;
  } = {},
) {
  const id = uid();
  await db.insert(inquiriesTable).values({
    id, tenantId, artworkId,
    artworkTitle: "Badge Artwork",
    buyerName: "Buyer", buyerEmail: "buyer@example.com",
    message: "Available?",
    status: opts.status ?? "NEW",
    archivedAt: opts.archivedAt ?? null,
    emailError: opts.emailError ?? null,
    emailAttempts: opts.emailAttempts ?? 0,
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
    // 2 qualifying
    await createInquiry(tenantId, artworkId, { status: "NEW" });
    await createInquiry(tenantId, artworkId, { status: "NEW" });
    // Not counted: HANDLED
    await createInquiry(tenantId, artworkId, { status: "HANDLED" });
    // Not counted: archived
    await createInquiry(tenantId, artworkId, { status: "NEW", archivedAt: new Date() });

    const count = await getNewInquiryCount();

    expect(count).toBe(2);
  });

  it("HANDLED inquiries are not counted", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    await createInquiry(tenantId, artworkId, { status: "HANDLED" });

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
    const _ownArtworkId = await createArtwork(ownTenantId);
    // Foreign tenant with its own NEW inquiries
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
    mockSession.userId = "u-badge-owner";

    expect(count).toBe(0);
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

  // ── getEmailFailCount ────────────────────────────────────────────────────────

  it("counts only non-archived inquiries with emailError set", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);

    // 2 qualifying: emailError set, attempts exhausted, not archived
    await createInquiry(tenantId, artworkId, { emailError: "SMTP timeout", archivedAt: null, emailAttempts: MAX_EMAIL_ATTEMPTS });
    await createInquiry(tenantId, artworkId, { emailError: "550 rejected", archivedAt: null, emailAttempts: MAX_EMAIL_ATTEMPTS });
    // Not counted: no emailError
    await createInquiry(tenantId, artworkId, { emailError: null, archivedAt: null });
    // Not counted: archived (even though emailError is set)
    await createInquiry(tenantId, artworkId, { emailError: "SMTP timeout", archivedAt: new Date(), emailAttempts: MAX_EMAIL_ATTEMPTS });

    const failCount = await getEmailFailCount();

    expect(failCount).toBe(2);
  });

  it("archived inquiry with emailError is excluded — banner disappears after archiving", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);

    // The inquiry had a failed email but has since been archived (lead resolved).
    await createInquiry(tenantId, artworkId, {
      emailError: "Connection refused",
      archivedAt: new Date(Date.now() - 1000),
      emailAttempts: MAX_EMAIL_ATTEMPTS,
    });

    const failCount = await getEmailFailCount();

    expect(failCount).toBe(0);
  });

  it("non-archived inquiries without emailError are not counted", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);

    await createInquiry(tenantId, artworkId, { emailError: null, archivedAt: null });
    await createInquiry(tenantId, artworkId, { emailError: null, archivedAt: null });

    const failCount = await getEmailFailCount();

    expect(failCount).toBe(0);
  });

  it("getEmailFailCount does not count another tenant's failed-email inquiries", async () => {
    const ownTenantId = await createTenant();
    const ownArtworkId = await createArtwork(ownTenantId);
    // 1 own failing inquiry (all attempts exhausted)
    await createInquiry(ownTenantId, ownArtworkId, { emailError: "SMTP timeout", archivedAt: null, emailAttempts: MAX_EMAIL_ATTEMPTS });

    // Foreign tenant with its own permanently-failed inquiries
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
    await createInquiry(foreignTenantId, foreignArtworkId, { emailError: "550 rejected", archivedAt: null, emailAttempts: MAX_EMAIL_ATTEMPTS });
    await createInquiry(foreignTenantId, foreignArtworkId, { emailError: "550 rejected", archivedAt: null, emailAttempts: MAX_EMAIL_ATTEMPTS });

    // Session remains on ownTenantId
    mockSession.tenantId = ownTenantId;
    const failCount = await getEmailFailCount();

    expect(failCount).toBe(1);
  });

  it("getEmailFailCount returns 0 for unauthenticated session", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    await createInquiry(tenantId, artworkId, { emailError: "SMTP timeout", archivedAt: null, emailAttempts: MAX_EMAIL_ATTEMPTS });

    mockSession.userId = null;
    const failCount = await getEmailFailCount();
    mockSession.userId = "u-badge-owner";

    expect(failCount).toBe(0);
  });
});
