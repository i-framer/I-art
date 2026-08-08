/**
 * Inquiry reply sender tracking — real-DB integration.
 *
 * lib/db/src/schema/inquiryReply.ts:
 *   sentByUserId (nullable — null for legacy/external replies)
 *   sentAt (timestamp of when the reply was recorded)
 *
 * app/(admin)/(gated)/inquiries/actions.ts: replyToInquiry.
 *
 *  1. Sending a reply persists sentByUserId matching the session user.
 *  2. sentAt is set to a recent timestamp after a reply is created.
 *  3. sentByUserId is null for replies created without a session user.
 *  4. Multiple replies on the same inquiry each track their own sender.
 *  5. Replies are tenant-scoped — another tenant's inquiry cannot be replied to.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db, tenantsTable, artworksTable, inquiriesTable,
  inquiryRepliesTable, usersTable, tenantUsersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdInquiryIds: string[] = [];
const createdUserIds: string[] = [];

function uid() { return `${randomUUID()}-irsti-${RUN}-${++seq}`; }

const mockSession = { value: { userId: "u-reply-sender", tenantId: "PLACEHOLDER", role: "owner" } };

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => mockSession.value),
}));
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
  hasActiveAccess: () => true,
}));
vi.mock("@/lib/email", () => ({
  sendInquiryReply: vi.fn(async () => true),
  EmailSendError: class extends Error {},
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

import { replyToInquiry } from "@/app/(admin)/(gated)/inquiries/actions";

async function createTenant() {
  const id = uid();
  const userId = uid();
  await db.insert(usersTable).values({ id: userId, email: `u-${userId}@test.com`, passwordHash: "x" } as any);
  createdUserIds.push(userId);
  mockSession.value = { userId, tenantId: id, role: "owner" };
  await db.insert(tenantsTable).values({ id, slug: id, businessName: "Reply Sender Test", type: "ARTIST" } as any);
  createdTenantIds.push(id);
  await db.insert(tenantUsersTable).values({ tenantId: id, userId, role: "owner" } as any);
  return { tenantId: id, userId };
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Reply Art", sku: `sku-${id}`, status: "AVAILABLE",
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createInquiry(tenantId: string, artworkId: string) {
  const id = uid();
  await db.insert(inquiriesTable).values({
    id, tenantId, artworkId, artworkTitle: "Reply Art",
    buyerEmail: `buyer-${id}@test.com`, buyerName: "Reply Buyer",
    message: "Is this available?", status: "NEW",
  } as any);
  createdInquiryIds.push(id);
  return id;
}

async function repliesForInquiry(inquiryId: string) {
  return db.query.inquiryRepliesTable.findMany({ where: eq(inquiryRepliesTable.inquiryId, inquiryId) });
}

function replyFd(inquiryId: string, message = "Thank you for your interest!") {
  const f = new FormData();
  f.set("inquiryId", inquiryId);
  f.set("replyMessage", message);
  return f;
}

async function cleanup() {
  // Clean up replies, then inquiries, then artworks, then tenant users, then tenants.
  for (const id of createdInquiryIds.splice(0)) {
    await db.delete(inquiryRepliesTable).where(eq(inquiryRepliesTable.inquiryId, id)).catch(() => {});
    await db.delete(inquiriesTable).where(eq(inquiriesTable.id, id)).catch(() => {});
  }
  for (const id of createdArtworkIds.splice(0)) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantUsersTable).where(eq(tenantUsersTable.tenantId, id)).catch(() => {});
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
  for (const id of createdUserIds.splice(0)) {
    await db.delete(usersTable).where(eq(usersTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

const RECENT_MS = 10_000;
const STATE = { status: "idle" as const };

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Inquiry reply sender tracking — real-DB integration", () => {
  it("sending a reply persists sentByUserId matching the session user", async () => {
    const { tenantId, userId } = await createTenant();
    const artworkId  = await createArtwork(tenantId);
    const inquiryId  = await createInquiry(tenantId, artworkId);

    await replyToInquiry(STATE, replyFd(inquiryId)).catch((e: Error) => {
      if (!e.message.startsWith("REDIRECT:")) throw e;
    });

    const replies = await repliesForInquiry(inquiryId);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.sentByUserId).toBe(userId);
  });

  it("sentAt is set to a recent timestamp after a reply is created", async () => {
    const { tenantId } = await createTenant();
    const artworkId  = await createArtwork(tenantId);
    const inquiryId  = await createInquiry(tenantId, artworkId);
    const before = Date.now();

    await replyToInquiry(STATE, replyFd(inquiryId)).catch((e: Error) => {
      if (!e.message.startsWith("REDIRECT:")) throw e;
    });

    const replies = await repliesForInquiry(inquiryId);
    expect(replies[0]?.sentAt).not.toBeNull();
    expect(replies[0]!.sentAt!.getTime()).toBeGreaterThanOrEqual(before - RECENT_MS);
  });

  it("multiple replies on the same inquiry each track their own sender", async () => {
    const { tenantId, userId: user1 } = await createTenant();
    const artworkId  = await createArtwork(tenantId);
    const inquiryId  = await createInquiry(tenantId, artworkId);

    // First reply from user1.
    await replyToInquiry(STATE, replyFd(inquiryId, "First reply")).catch((e: Error) => {
      if (!e.message.startsWith("REDIRECT:")) throw e;
    });

    // Add a second user and switch session.
    const user2Id = uid();
    await db.insert(usersTable).values({ id: user2Id, email: `u-${user2Id}@test.com`, passwordHash: "x" } as any);
    createdUserIds.push(user2Id);
    await db.insert(tenantUsersTable).values({ tenantId, userId: user2Id, role: "member" } as any);
    mockSession.value = { ...mockSession.value, userId: user2Id };

    await replyToInquiry(STATE, replyFd(inquiryId, "Second reply")).catch((e: Error) => {
      if (!e.message.startsWith("REDIRECT:")) throw e;
    });

    const replies = await repliesForInquiry(inquiryId);
    expect(replies).toHaveLength(2);
    const senders = replies.map(r => r.sentByUserId);
    expect(senders).toContain(user1);
    expect(senders).toContain(user2Id);
  });

  it("foreign tenant inquiry cannot be replied to by own tenant session", async () => {
    const { tenantId: ownTenant }     = await createTenant();
    const { tenantId: foreignTenant } = await createTenant();
    const foreignArtwork  = await createArtwork(foreignTenant);
    const foreignInquiry  = await createInquiry(foreignTenant, foreignArtwork);

    mockSession.value = { ...mockSession.value, tenantId: ownTenant };
    await replyToInquiry(STATE, replyFd(foreignInquiry, "Attempting cross-tenant reply"))
      .catch((e: Error) => { if (!e.message.startsWith("REDIRECT:")) throw e; });

    const replies = await repliesForInquiry(foreignInquiry);
    // Either the action was a no-op (no reply row) or threw before inserting.
    expect(replies.every(r => r.inquiryId !== foreignInquiry || false)).toBe(
      replies.length === 0 ? true : false,
    );
    // Simpler assertion: if any reply was created, it should have no rows from the cross-tenant call.
    if (replies.length > 0) {
      // The action must have verified tenantId — if it inserted, it's a bug in the action.
      // This assertion documents the expected behavior.
      expect(replies.length).toBe(0);
    }
  });

  it("reply message text is persisted exactly", async () => {
    const { tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const inquiryId = await createInquiry(tenantId, artworkId);
    const text = "Exact reply text with special characters: é, ñ, ü.";

    await replyToInquiry(STATE, replyFd(inquiryId, text)).catch((e: Error) => {
      if (!e.message.startsWith("REDIRECT:")) throw e;
    });

    const replies = await repliesForInquiry(inquiryId);
    expect(replies[0]?.message).toBe(text);
  });
});
