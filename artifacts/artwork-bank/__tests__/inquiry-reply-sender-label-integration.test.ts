/**
 * Task #66 — Label older replies sent before sender tracking existed.
 *
 * Integration tests against the real database: inserts inquiry replies with and
 * without sentByUserId and asserts the page query returns the expected
 * senderEmail values.
 *
 * Pure unit tests for senderDisplayName() live in
 * inquiry-reply-sender-label.unit.test.ts and run in the fast suite.
 */
import { it, expect, afterEach, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { randomUUID } from "node:crypto";
import { db, tenantsTable, artworksTable, inquiriesTable, inquiryRepliesTable, usersTable } from "@workspace/db";
import { eq, and, inArray, asc } from "drizzle-orm";

// Keep the real database query while making the authenticated viewer explicit.
// This lets the integration test prove that the reply sender is resolved from
// sentByUserId rather than from whoever is currently viewing the page.
const mockSession = {
  value: {
    userId: "",
    tenantId: "",
    role: "owner" as const,
  },
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => mockSession.value),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
}));

vi.mock("@/lib/email", () => ({
  sendInquiryReply: vi.fn(async () => true),
  EmailSendError: class extends Error {},
}));

vi.mock("@/lib/email-sweep", () => ({
  requeueExhaustedInquiries: vi.fn(async () => {}),
  clearStuckNonces: vi.fn(async () => {}),
}));

import { getInquiryReplies } from "@/app/(admin)/(gated)/inquiries/actions";

// ─── senderDisplayName ────────────────────────────────────────────────────────
// Copied verbatim from app/(admin)/(gated)/inquiries/page.tsx so it can be
// used inside the integration assertions without importing the Next.js page.

function senderDisplayName(email: string | null | undefined): string {
  if (!email) return "";
  const local = email.split("@")[0] ?? "";
  return local
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

// ─── Integration test: DB query returns null senderEmail for old replies ──────
// Replicates the exact query the inquiries page runs and confirms that a reply
// inserted WITHOUT sentByUserId comes back with senderEmail = null.

describeIntegration("inquiry reply — null senderEmail for pre-tracking rows (Task #66)", () => {
  const createdTenantIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdArtworkIds: string[] = [];
  const createdInquiryIds: string[] = [];
  const createdReplyIds: string[] = [];

  function uid() {
    return randomUUID();
  }

  async function createTenant(): Promise<string> {
    const id = uid();
    await db.insert(tenantsTable).values({
      id,
      type: "ARTIST",
      businessName: "Sender Label Test Gallery",
      slug: `sender-label-${id}`,
    } as any);
    createdTenantIds.push(id);
    return id;
  }

  async function createUser(email: string): Promise<string> {
    const id = uid();
    await db.insert(usersTable).values({
      id,
      email,
      passwordHash: "x",
    });
    createdUserIds.push(id);
    return id;
  }

  async function createArtwork(tenantId: string): Promise<string> {
    const id = uid();
    await db.insert(artworksTable).values({
      id,
      tenantId,
      title: "Test Artwork",
      sku: `test-sku-${id}`,
      price: 1000,
      status: "AVAILABLE",
      showInGallery: true,
    } as any);
    createdArtworkIds.push(id);
    return id;
  }

  async function createInquiry(tenantId: string): Promise<string> {
    const artworkId = await createArtwork(tenantId);
    const id = uid();
    await db.insert(inquiriesTable).values({
      id,
      tenantId,
      artworkId,
      artworkTitle: "Test Artwork",
      buyerName: "Art Buyer",
      buyerEmail: "buyer@example.com",
      message: "Is this available?",
    } as any);
    createdInquiryIds.push(id);
    return id;
  }

  async function createReply(opts: {
    tenantId: string;
    inquiryId: string;
    sentByUserId?: string;
    message?: string;
  }): Promise<string> {
    const id = uid();
    await db.insert(inquiryRepliesTable).values({
      id,
      tenantId: opts.tenantId,
      inquiryId: opts.inquiryId,
      sentByUserId: opts.sentByUserId ?? null,
      message: opts.message ?? "Thanks for your interest.",
    });
    createdReplyIds.push(id);
    return id;
  }

  // Replicates the exact SELECT the inquiries page uses.
  async function queryReplies(tenantId: string, inquiryIds: string[]) {
    return db
      .select({
        id: inquiryRepliesTable.id,
        inquiryId: inquiryRepliesTable.inquiryId,
        message: inquiryRepliesTable.message,
        sentAt: inquiryRepliesTable.sentAt,
        senderEmail: usersTable.email,
      })
      .from(inquiryRepliesTable)
      .leftJoin(usersTable, eq(inquiryRepliesTable.sentByUserId, usersTable.id))
      .where(
        and(
          eq(inquiryRepliesTable.tenantId, tenantId),
          inArray(inquiryRepliesTable.inquiryId, inquiryIds),
        ),
      )
      .orderBy(asc(inquiryRepliesTable.sentAt));
  }

  afterEach(async function () {
    // Delete in FK-safe order: replies → inquiries → artworks → users → tenants
    for (const id of createdReplyIds) {
      await db.delete(inquiryRepliesTable).where(eq(inquiryRepliesTable.id, id)).catch(() => {});
    }
    for (const id of createdInquiryIds) {
      await db.delete(inquiriesTable).where(eq(inquiriesTable.id, id)).catch(() => {});
    }
    for (const id of createdArtworkIds) {
      await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
    }
    for (const id of createdUserIds) {
      await db.delete(usersTable).where(eq(usersTable.id, id)).catch(() => {});
    }
    for (const id of createdTenantIds) {
      await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
    }
    createdReplyIds.length = 0;
    createdInquiryIds.length = 0;
    createdArtworkIds.length = 0;
    createdUserIds.length = 0;
    createdTenantIds.length = 0;
  });

  it("reply without sentByUserId returns senderEmail = null from the page query", async () => {
    const tenantId = await createTenant();
    const inquiryId = await createInquiry(tenantId);
    await createReply({ tenantId, inquiryId }); // no sentByUserId

    const replies = await queryReplies(tenantId, [inquiryId]);

    expect(replies).toHaveLength(1);
    // senderEmail is null — the page renders "staff (sender not recorded)".
    expect(replies[0]?.senderEmail).toBeNull();
    // senderDisplayName(null) returns "", confirming the fallback branch fires.
    expect(senderDisplayName(replies[0]?.senderEmail)).toBe("");
  });

  it("reply with sentByUserId returns the user's email from the page query", async () => {
    const tenantId = await createTenant();
    const userId = await createUser(`staff-${uid()}@gallery.com`);
    const inquiryId = await createInquiry(tenantId);
    await createReply({ tenantId, inquiryId, sentByUserId: userId });

    const replies = await queryReplies(tenantId, [inquiryId]);

    expect(replies).toHaveLength(1);
    // senderEmail is the user's registered email — display name is derived.
    expect(replies[0]?.senderEmail).toContain("@gallery.com");
    expect(senderDisplayName(replies[0]?.senderEmail)).toBeTruthy();
  });

  it("labels a staff reply with the stored sender when an owner views the inquiry", async () => {
    const tenantId = await createTenant();
    const ownerEmail = `gallery.owner@${uid()}.gallery.com`;
    const staffEmail = `staff.member@${uid()}.gallery.com`;
    const ownerId = await createUser(ownerEmail);
    const staffId = await createUser(staffEmail);
    const inquiryId = await createInquiry(tenantId);
    await createReply({
      tenantId,
      inquiryId,
      sentByUserId: staffId,
      message: "Reply sent by the staff member.",
    });

    // The page/query is called as the owner, but the reply was sent by staff.
    mockSession.value = { userId: ownerId, tenantId, role: "owner" };
    const replies = await getInquiryReplies([inquiryId]);

    expect(replies).toHaveLength(1);
    const reply = replies[0];
    expect(reply?.senderEmail).toBe(staffEmail);
    expect(senderDisplayName(reply?.senderEmail)).toBe("Staff Member");
    expect(senderDisplayName(reply?.senderEmail)).not.toBe("Gallery Owner");
  });

  it("mixed replies: old (null) and new (tracked) in the same inquiry", async () => {
    const tenantId = await createTenant();
    const userId = await createUser(`sender-${uid()}@gallery.com`);
    const inquiryId = await createInquiry(tenantId);

    await createReply({ tenantId, inquiryId, message: "Old reply — no sender" });
    await createReply({
      tenantId,
      inquiryId,
      sentByUserId: userId,
      message: "New reply — sender tracked",
    });

    const replies = await queryReplies(tenantId, [inquiryId]);

    expect(replies).toHaveLength(2);
    const [old, tracked] = replies;

    // Old reply: null sender → fallback label in UI.
    expect(old?.senderEmail).toBeNull();
    expect(senderDisplayName(old?.senderEmail)).toBe("");

    // New reply: email present → display name rendered.
    expect(tracked?.senderEmail).not.toBeNull();
    expect(senderDisplayName(tracked?.senderEmail)).toBeTruthy();
  });
});
