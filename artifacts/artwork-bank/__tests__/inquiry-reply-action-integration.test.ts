/**
 * replyToInquiry action — real-DB integration.
 *
 * app/(admin)/(gated)/inquiries/actions.ts:143
 *
 * The action:
 *  1. Verifies inquiry belongs to the session tenant.
 *  2. Sends the reply email.
 *  3. Persists the reply record with sentByUserId = session.userId.
 *  4. Updates the inquiry status to HANDLED.
 *  5. If the DB write fails after email send, returns status="sent_not_saved".
 *
 * This suite verifies the DB persistence contract:
 *
 *  1. Reply row is persisted with correct inquiryId, tenantId, sentByUserId, message.
 *  2. Inquiry status is set to HANDLED after a successful reply.
 *  3. Foreign-tenant inquiry returns an error — no DB row written.
 *  4. Empty message returns error — no DB row written.
 *  5. sentByUserId matches the authenticated user's ID.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  inquiriesTable,
  inquiryRepliesTable,
  usersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdInquiryIds: string[] = [];
const createdUserIds: string[] = [];

function uid() { return `${randomUUID()}-ira-${RUN}-${++seq}`; }

// ── Auth / billing / next ────────────────────────────────────────────────────
const mockSession = { value: { userId: "u-reply-test", tenantId: "PLACEHOLDER" } };

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

// ── Email ────────────────────────────────────────────────────────────────────
const sendInquiryReply = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/email", () => ({
  sendInquiryReply,
  EmailSendError: class extends Error {},
}));

import { replyToInquiry } from "@/app/(admin)/(gated)/inquiries/actions";

// ── DB helpers ───────────────────────────────────────────────────────────────
async function createUser() {
  const id = uid();
  await db.insert(usersTable).values({ id, email: `user-${id}@test.com`, passwordHash: "x" } as any);
  createdUserIds.push(id);
  return id;
}

async function createTenant() {
  const id = uid();
  const userId = await createUser();
  mockSession.value = { userId, tenantId: id };
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Reply Action Test Gallery", type: "ARTIST",
    contactEmail: "gallery@test.com",
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id, userId };
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Reply Test Art", sku: `sku-${id}`, status: "AVAILABLE",
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createInquiry(tenantId: string, artworkId: string) {
  const id = uid();
  await db.insert(inquiriesTable).values({
    id, tenantId, artworkId, artworkTitle: "Reply Test Art",
    buyerName: "Test Buyer", buyerEmail: "buyer@test.com",
    message: "I would like to buy this.", status: "NEW",
  } as any);
  createdInquiryIds.push(id);
  return id;
}

function fd(entries: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

async function cleanup() {
  // Reply rows are deleted via cascade (FK to inquiriesTable).
  for (const id of createdInquiryIds.splice(0)) {
    await db.delete(inquiryRepliesTable)
      .where(eq(inquiryRepliesTable.inquiryId, id)).catch(() => {});
    await db.delete(inquiriesTable).where(eq(inquiriesTable.id, id)).catch(() => {});
  }
  for (const id of createdArtworkIds.splice(0)) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
  for (const id of createdUserIds.splice(0)) {
    await db.delete(usersTable).where(eq(usersTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("replyToInquiry action — real-DB integration", () => {
  it("reply row is persisted with correct inquiryId, tenantId, sentByUserId, and message", async () => {
    const { tenantId, userId } = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const inquiryId = await createInquiry(tenantId, artworkId);

    sendInquiryReply.mockResolvedValueOnce(undefined);
    const result = await replyToInquiry(
      { status: "idle" },
      fd({ inquiryId, replyMessage: "Thank you for your interest!" }),
    );

    expect(result.status).toBe("sent");

    const reply = await db.query.inquiryRepliesTable.findFirst({
      where: eq(inquiryRepliesTable.inquiryId, inquiryId),
    });
    expect(reply).toBeDefined();
    expect(reply?.inquiryId).toBe(inquiryId);
    expect(reply?.tenantId).toBe(tenantId);
    expect(reply?.sentByUserId).toBe(userId);
    expect(reply?.message).toBe("Thank you for your interest!");
  });

  it("inquiry status is set to HANDLED after successful reply", async () => {
    const { tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const inquiryId = await createInquiry(tenantId, artworkId);

    sendInquiryReply.mockResolvedValueOnce(undefined);
    await replyToInquiry(
      { status: "idle" },
      fd({ inquiryId, replyMessage: "Your artwork will ship tomorrow." }),
    );

    const inquiry = await db.query.inquiriesTable.findFirst({
      where: eq(inquiriesTable.id, inquiryId),
    });
    expect(inquiry?.status).toBe("HANDLED");
  });

  it("foreign-tenant inquiry returns error — no reply row written", async () => {
    await createTenant();
    // Create a foreign tenant and inquiry.
    const foreignTenantId = uid();
    await db.insert(tenantsTable).values({
      id: foreignTenantId, slug: foreignTenantId,
      businessName: "Foreign Gallery", type: "ARTIST",
    } as any);
    createdTenantIds.push(foreignTenantId);
    const foreignArtworkId = uid();
    await db.insert(artworksTable).values({
      id: foreignArtworkId, tenantId: foreignTenantId,
      title: "Foreign Art", sku: `sku-${foreignArtworkId}`, status: "AVAILABLE",
    } as any);
    createdArtworkIds.push(foreignArtworkId);
    const foreignInquiryId = uid();
    await db.insert(inquiriesTable).values({
      id: foreignInquiryId, tenantId: foreignTenantId,
      artworkId: foreignArtworkId, artworkTitle: "Foreign Art",
      buyerName: "Foreign Buyer", buyerEmail: "foreign@test.com",
      message: "Hello", status: "NEW",
    } as any);
    createdInquiryIds.push(foreignInquiryId);

    // Session is still own tenant.
    const result = await replyToInquiry(
      { status: "idle" },
      fd({ inquiryId: foreignInquiryId, replyMessage: "Trying to reply to foreign inquiry." }),
    );

    expect(result.status).toBe("error");

    // No reply row should have been written.
    const replies = await db.query.inquiryRepliesTable.findMany({
      where: eq(inquiryRepliesTable.inquiryId, foreignInquiryId),
    });
    expect(replies).toHaveLength(0);
  });

  it("empty message returns error — no reply row written", async () => {
    const { tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const inquiryId = await createInquiry(tenantId, artworkId);

    const result = await replyToInquiry(
      { status: "idle" },
      fd({ inquiryId, replyMessage: "" }),
    );

    expect(result.status).toBe("error");
    expect(result.message).toMatch(/empty/i);

    const replies = await db.query.inquiryRepliesTable.findMany({
      where: eq(inquiryRepliesTable.inquiryId, inquiryId),
    });
    expect(replies).toHaveLength(0);
  });

  it("sentByUserId matches the authenticated user's session ID", async () => {
    const { tenantId, userId } = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const inquiryId = await createInquiry(tenantId, artworkId);

    sendInquiryReply.mockResolvedValueOnce(undefined);
    await replyToInquiry(
      { status: "idle" },
      fd({ inquiryId, replyMessage: "We'll arrange delivery." }),
    );

    const reply = await db.query.inquiryRepliesTable.findFirst({
      where: eq(inquiryRepliesTable.inquiryId, inquiryId),
    });
    expect(reply?.sentByUserId).toBe(userId);
  });
});
