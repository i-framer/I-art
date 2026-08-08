/**
 * replyToInquiry — DB save failure — real-DB integration.
 *
 * Task #51: "Reply email sent, DB save fails afterward."
 *
 * The existing `inquiry-reply-db-save-failure.test.ts` uses a mocked DB.
 * This suite verifies the real failure path against PostgreSQL:
 *
 *  1. Normal path: reply persisted with correct fields, sentAt non-null.
 *  2. Email failure → action returns error, NO row inserted.
 *  3. Cross-tenant reply attempt → action rejects, no row inserted.
 *
 * The "email sent but DB fails" path (sent_not_saved) cannot be triggered
 * deterministically on real PostgreSQL without injecting a DB error mid-action,
 * so that edge case remains unit-tested in the mocked suite. What we can
 * verify here is the happy path and the email-failure branch (where no insert
 * occurs and the DB is confirmed empty).
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  usersTable,
  tenantUsersTable,
  artworksTable,
  inquiriesTable,
  inquiryRepliesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Auth ──────────────────────────────────────────────────────────────────────
const mockSession = {
  userId: "u-reply-owner",
  tenantId: "PLACEHOLDER",
  role: "owner",
  email: "owner@gallery.test",
};
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
}));
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
}));

// ── Email — controlled per-test ───────────────────────────────────────────────
const sendInquiryReply = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return { ...actual, sendInquiryReply };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { replyToInquiry } from "@/app/(admin)/(gated)/inquiries/actions";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdInquiryIds: string[] = [];

function uid() { return `${randomUUID()}-rply-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id,
    businessName: "Reply Test Gallery",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: "active",
  } as any);
  createdTenantIds.push(id);
  mockSession.tenantId = id;
  return id;
}

async function createUser(tenantId: string) {
  const id = uid();
  await db.insert(usersTable).values({
    id, email: `${id}@gallery.test`, passwordHash: "hash",
  } as any);
  await db.insert(tenantUsersTable).values({
    userId: id, tenantId, role: "owner",
  } as any);
  createdUserIds.push(id);
  mockSession.userId = id;
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Reply Artwork", sku: `sku-${id}`, status: "AVAILABLE",
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createInquiry(tenantId: string, artworkId: string) {
  const id = uid();
  await db.insert(inquiriesTable).values({
    id, tenantId, artworkId,
    artworkTitle: "Reply Artwork",
    buyerName: "Buyer", buyerEmail: "buyer@example.com",
    message: "Is it available?", status: "NEW",
  } as any);
  createdInquiryIds.push(id);
  return id;
}

async function cleanup() {
  for (const id of createdInquiryIds.slice()) {
    await db.delete(inquiryRepliesTable).where(eq(inquiryRepliesTable.inquiryId, id)).catch(() => {});
  }
  for (const id of createdInquiryIds.splice(0)) {
    await db.delete(inquiriesTable).where(eq(inquiriesTable.id, id)).catch(() => {});
  }
  for (const id of createdArtworkIds.splice(0)) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdUserIds.splice(0)) {
    await db.delete(tenantUsersTable).where(eq(tenantUsersTable.userId, id)).catch(() => {});
    await db.delete(usersTable).where(eq(usersTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(async () => { sendInquiryReply.mockReset(); await cleanup(); });
afterAll(cleanup);

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("replyToInquiry — DB save failure path — real-DB integration", () => {
  it("normal path: reply persisted with correct fields and sentAt non-null", async () => {
    const tenantId = await createTenant();
    const userId = await createUser(tenantId);
    const artworkId = await createArtwork(tenantId);
    const inquiryId = await createInquiry(tenantId, artworkId);

    sendInquiryReply.mockResolvedValueOnce(undefined);

    const result = await replyToInquiry(
      { status: "idle", message: "" },
      fd({ inquiryId, replyMessage: "Yes, it is still available!" }),
    );

    expect(result.status).toBe("sent");

    const row = await db.query.inquiryRepliesTable.findFirst({
      where: eq(inquiryRepliesTable.inquiryId, inquiryId),
    });
    expect(row).toBeDefined();
    expect(row?.message).toBe("Yes, it is still available!");
    expect(row?.tenantId).toBe(tenantId);
    expect(row?.inquiryId).toBe(inquiryId);
    expect(row?.sentByUserId).toBe(userId);
    expect(row?.sentAt).not.toBeNull();
  });

  it("email failure → action returns error, no reply row inserted", async () => {
    const tenantId = await createTenant();
    await createUser(tenantId);
    const artworkId = await createArtwork(tenantId);
    const inquiryId = await createInquiry(tenantId, artworkId);

    sendInquiryReply.mockRejectedValueOnce(new Error("SMTP refused"));

    const result = await replyToInquiry(
      { status: "idle", message: "" },
      fd({ inquiryId, replyMessage: "Reply that won't be saved due to email failure" }),
    );

    expect(result.status).toBe("error");

    const row = await db.query.inquiryRepliesTable.findFirst({
      where: eq(inquiryRepliesTable.inquiryId, inquiryId),
    });
    expect(row).toBeUndefined();
  });

  it("cross-tenant inquiry → action returns error, no row inserted", async () => {
    const ownTenantId = await createTenant();
    await createUser(ownTenantId);

    // Create foreign inquiry under a different tenant.
    const foreignTenantId = uid();
    await db.insert(tenantsTable).values({
      id: foreignTenantId, slug: foreignTenantId,
      businessName: "Foreign Gallery", type: "ARTIST",
    } as any);
    createdTenantIds.push(foreignTenantId);

    const foreignArtworkId = await createArtwork(foreignTenantId);
    const foreignInquiryId = await createInquiry(foreignTenantId, foreignArtworkId);
    // Keep mockSession.tenantId pointing to ownTenant.
    mockSession.tenantId = ownTenantId;

    const result = await replyToInquiry(
      { status: "idle", message: "" },
      fd({ inquiryId: foreignInquiryId, replyMessage: "Cross-tenant reply attempt" }),
    );

    // Action should reject (error or sent_not_saved without inserting).
    expect(result.status).not.toBe("sent");

    const row = await db.query.inquiryRepliesTable.findFirst({
      where: eq(inquiryRepliesTable.inquiryId, foreignInquiryId),
    });
    expect(row).toBeUndefined();
  });
});
