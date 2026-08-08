/**
 * replyToInquiry — real-DB integration.
 *
 * All existing tests for this action mock the database.  This suite verifies
 * the persistence and tenant-isolation invariants against real PostgreSQL:
 *
 *  1. A successful reply inserts a row into inquiry_reply and sets the inquiry
 *     status to HANDLED.
 *  2. A foreign-tenant inquiryId returns { status: "error" } without any
 *     DB insert or update.
 *  3. An empty replyMessage is rejected with a validation error before any DB
 *     write or email attempt.
 *  4. A second successful reply to an already-HANDLED inquiry keeps it HANDLED
 *     (idempotent status update).
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db, tenantsTable, artworksTable,
  inquiriesTable, inquiryRepliesTable, usersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Auth ──────────────────────────────────────────────────────────────────────
const mockSession = { userId: "PLACEHOLDER_USER", tenantId: "PLACEHOLDER" };
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
}));
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
  hasActiveAccess: () => true,
}));

// ── Email — success by default; controlled per test ───────────────────────────
const sendInquiryReply = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/email", () => ({
  sendInquiryReply: (...a: unknown[]) => sendInquiryReply(...a),
  sendOrderStatusUpdate: vi.fn(async () => {}),
  sendOrderConfirmation: vi.fn(async () => {}),
}));

vi.mock("@/lib/base-url", () => ({
  getTenantUrl: vi.fn(() => "https://test.example"),
  getPlatformBaseUrl: vi.fn(() => "https://platform.test"),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

import { replyToInquiry } from "@/app/(admin)/(gated)/inquiries/actions";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdUserIds: string[] = [];
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdInquiryIds: string[] = [];

function uid() {
  return `${randomUUID()}-qi-${RUN}-${++seq}`;
}

async function createUser() {
  const id = uid();
  await db.insert(usersTable).values({
    id,
    email: `test-reply-user-${id}@example.com`,
    passwordHash: "hash-not-used",
  } as any);
  createdUserIds.push(id);
  mockSession.userId = id;
  return id;
}

async function createTenant(opts: { contactEmail?: string } = {}) {
  const id = uid();
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Inquiry Reply Test Gallery",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: "active",
    contactEmail: opts.contactEmail ?? "gallery@example.com",
  } as any);
  createdTenantIds.push(id);
  mockSession.tenantId = id;
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Reply Test Artwork",
    sku: `sku-${id}`,
    status: "AVAILABLE",
    showInGallery: true,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createInquiry(
  tenantId: string,
  artworkId: string,
  status: "NEW" | "HANDLED" = "NEW",
) {
  const id = uid();
  await db.insert(inquiriesTable).values({
    id,
    tenantId,
    artworkId,
    artworkTitle: "Reply Test Artwork",
    buyerName: "Test Buyer",
    buyerEmail: "buyer@example.com",
    message: "Is this available?",
    status,
  } as any);
  createdInquiryIds.push(id);
  return id;
}

async function cleanup() {
  for (const id of createdInquiryIds.splice(0)) {
    await db.delete(inquiryRepliesTable)
      .where(eq(inquiryRepliesTable.inquiryId, id))
      .catch(() => {});
    await db.delete(inquiriesTable)
      .where(eq(inquiriesTable.id, id))
      .catch(() => {});
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

afterEach(async () => {
  sendInquiryReply.mockClear();
  await cleanup();
});

afterAll(async () => { await cleanup(); });

function fd(inquiryId: string, message: string) {
  const f = new FormData();
  f.set("inquiryId", inquiryId);
  f.set("replyMessage", message);
  return f;
}

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("replyToInquiry — real-DB integration", () => {
  it("inserts a reply row and sets inquiry status=HANDLED on success", async () => {
    await createUser();
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const inquiryId = await createInquiry(tenantId, artworkId, "NEW");

    const result = await replyToInquiry(null, fd(inquiryId, "Yes, it is available!"));

    expect(result.status).toBe("sent");

    // Inquiry must now be HANDLED.
    const inq = await db.query.inquiriesTable.findFirst({
      where: eq(inquiriesTable.id, inquiryId),
    });
    expect(inq?.status).toBe("HANDLED");

    // A reply row must have been inserted.
    const replies = await db.query.inquiryRepliesTable.findFirst({
      where: eq(inquiryRepliesTable.inquiryId, inquiryId),
    });
    expect(replies?.message).toBe("Yes, it is available!");
    expect(replies?.tenantId).toBe(tenantId);
  });

  it("returns { status: 'error' } for a foreign tenant's inquiryId — no DB writes", async () => {
    const tenantA = await createTenant();
    const artworkId = await createArtwork(tenantA);
    const inquiryId = await createInquiry(tenantA, artworkId, "NEW");

    // Switch session to tenant B.
    const tenantB = await createTenant();
    mockSession.tenantId = tenantB;

    const result = await replyToInquiry(null, fd(inquiryId, "Injected reply"));

    expect(result.status).toBe("error");
    expect(result.message).toMatch(/not found/i);

    // Inquiry must remain NEW (no update).
    const inq = await db.query.inquiriesTable.findFirst({
      where: eq(inquiriesTable.id, inquiryId),
    });
    expect(inq?.status).toBe("NEW");

    // No reply inserted.
    const replies = await db.query.inquiryRepliesTable.findFirst({
      where: eq(inquiryRepliesTable.inquiryId, inquiryId),
    });
    expect(replies).toBeUndefined();
  });

  it("rejects an empty replyMessage before any DB write or email", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const inquiryId = await createInquiry(tenantId, artworkId, "NEW");

    const result = await replyToInquiry(null, fd(inquiryId, "   "));

    expect(result.status).toBe("error");
    expect(sendInquiryReply).not.toHaveBeenCalled();

    // No DB writes.
    const inq = await db.query.inquiriesTable.findFirst({
      where: eq(inquiriesTable.id, inquiryId),
    });
    expect(inq?.status).toBe("NEW");
  });

  it("sets status=HANDLED even when inquiry was already HANDLED (idempotent update)", async () => {
    await createUser();
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    // Start with already-HANDLED inquiry (gallery is sending a follow-up).
    const inquiryId = await createInquiry(tenantId, artworkId, "HANDLED");

    const result = await replyToInquiry(null, fd(inquiryId, "Follow-up message"));

    expect(result.status).toBe("sent");

    const inq = await db.query.inquiriesTable.findFirst({
      where: eq(inquiriesTable.id, inquiryId),
    });
    // Still HANDLED — no regression.
    expect(inq?.status).toBe("HANDLED");
  });
});
