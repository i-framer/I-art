/**
 * Task #1031 — Confirm replying to an inquiry can't expose another gallery's
 * buyer messages.
 *
 * Background:
 *   replyToInquiry fetches the inquiry scoped by both inquiryId AND the session
 *   tenantId before sending any email or inserting a reply record.  A cross-
 *   tenant caller therefore hits the "Inquiry not found." guard and the buyer's
 *   contact details are never read, no email is dispatched, and no row is
 *   written to inquiry_replies.
 *
 * Scenarios:
 *  1. Tenant B calling replyToInquiry(idA) returns an error, sends NO email,
 *     and leaves inquiry_replies empty for idA.
 *  2. After the cross-tenant attempt, inquiry A's own reply list is still empty
 *     (direct DB assertion).
 *  3. Same-tenant call succeeds — confirms the guard is scoped to tenantId, not
 *     a blanket no-op.
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

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockSession = {
  userId: "u-1031-test",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test-1031",
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/base-url", () => ({
  getTenantUrl: (_tenant: unknown, path: string) =>
    `https://gallery.test${path}`,
  getPlatformBaseUrl: () => "https://platform.test",
}));

vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
}));

// Email spy — hoisted so we can assert it was never called.
const sendInquiryReply = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return { ...actual, sendInquiryReply };
});

// ── Imports after mocks ───────────────────────────────────────────────────────

import { replyToInquiry } from "@/app/(admin)/(gated)/inquiries/actions";

// ── Helpers ───────────────────────────────────────────────────────────────────

const RUN = randomUUID().slice(0, 8);
let seq = 0;
const CREATED_TENANT_IDS: string[] = [];
const CREATED_USER_IDS: string[] = [];
const CREATED_ARTWORK_IDS: string[] = [];
const CREATED_INQUIRY_IDS: string[] = [];

function makeId(label: string) {
  return `t1031-${RUN}-${++seq}-${label}`;
}

async function insertUser(id: string, tenantId: string): Promise<void> {
  CREATED_USER_IDS.push(id);
  await db.insert(usersTable).values({
    id,
    email: `${id}@gallery.test`,
    passwordHash: "hash",
  } as any);
  await db.insert(tenantUsersTable).values({
    userId: id,
    tenantId,
    role: "owner",
  } as any);
}

async function insertTenant(id: string): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Tenant Isolation Test Gallery 1031",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: null,
    contactEmail: "owner-1031@gallery.test",
  } as any);
}

async function insertArtwork(id: string, tenantId: string): Promise<void> {
  CREATED_ARTWORK_IDS.push(id);
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork 1031",
    sku: `sku-1031-${RUN}-${id.slice(-6)}`,
    status: "AVAILABLE",
  } as any);
}

async function insertInquiry(
  id: string,
  tenantId: string,
  artworkId: string,
): Promise<void> {
  CREATED_INQUIRY_IDS.push(id);
  await db.insert(inquiriesTable).values({
    id,
    tenantId,
    artworkId,
    artworkTitle: "Test Artwork 1031",
    buyerName: "Cross-Tenant Reply Test Buyer",
    buyerEmail: "buyer-1031@example.com",
    message: "Is this available?",
    status: "NEW",
  } as any);
}

function replyFormData(inquiryId: string, replyMessage: string): FormData {
  const fd = new FormData();
  fd.set("inquiryId", inquiryId);
  fd.set("replyMessage", replyMessage);
  return fd;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describeIntegration(
  "replyToInquiry — cross-tenant isolation — real DB",
  () => {
    afterEach(() => {
      sendInquiryReply.mockReset();
    });

    afterAll(async () => {
      // Clean up in dependency order.
      for (const id of CREATED_INQUIRY_IDS) {
        await db
          .delete(inquiryRepliesTable)
          .where(eq(inquiryRepliesTable.inquiryId, id))
          .catch(() => {});
      }
      for (const id of CREATED_INQUIRY_IDS.splice(0)) {
        await db
          .delete(inquiriesTable)
          .where(eq(inquiriesTable.id, id))
          .catch(() => {});
      }
      for (const id of CREATED_ARTWORK_IDS.splice(0)) {
        await db
          .delete(artworksTable)
          .where(eq(artworksTable.id, id))
          .catch(() => {});
      }
      for (const id of CREATED_USER_IDS.splice(0)) {
        await db
          .delete(usersTable)
          .where(eq(usersTable.id, id))
          .catch(() => {});
      }
      for (const id of CREATED_TENANT_IDS.splice(0)) {
        await db
          .delete(tenantsTable)
          .where(eq(tenantsTable.id, id))
          .catch(() => {});
      }
    });

    // ── Scenario 1 & 2 ───────────────────────────────────────────────────────
    // Tenant B attempts to reply to Tenant A's inquiry.  The action must return
    // an error, send no email, and leave inquiry_replies empty for idA.

    it(
      "cross-tenant replyToInquiry returns error, sends no email, and inserts no reply row",
      { timeout: 30_000 },
      async () => {
        const tenantIdA = makeId("tenantA-s1");
        const tenantIdB = makeId("tenantB-s1");
        await insertTenant(tenantIdA);
        await insertTenant(tenantIdB);

        const artworkIdA = makeId("artworkA-s1");
        await insertArtwork(artworkIdA, tenantIdA);

        const inqIdA = makeId("inqA-s1");
        await insertInquiry(inqIdA, tenantIdA, artworkIdA);

        // Pre-condition: no replies exist for this inquiry.
        const repliesBefore = await db.query.inquiryRepliesTable.findMany({
          where: eq(inquiryRepliesTable.inquiryId, inqIdA),
        });
        expect(repliesBefore).toHaveLength(0);

        // Tenant B attempts to reply to Tenant A's inquiry.
        mockSession.tenantId = tenantIdB;
        const result = await replyToInquiry(
          { status: "idle", message: "" },
          replyFormData(inqIdA, "Cross-tenant reply attempt"),
        );

        // The action must reject — never "sent".
        expect(result.status).toBe("error");
        expect(result.message).toMatch(/inquiry not found/i);

        // No email should have been dispatched.
        expect(sendInquiryReply).not.toHaveBeenCalled();

        // DB assertion: inquiry_replies for idA is still empty.
        const repliesAfter = await db.query.inquiryRepliesTable.findMany({
          where: eq(inquiryRepliesTable.inquiryId, inqIdA),
        });
        expect(repliesAfter).toHaveLength(0);
      },
    );

    // ── Scenario 3 ───────────────────────────────────────────────────────────
    // Confirms the guard lives in the tenantId WHERE clause, not a blanket
    // no-op: the same action succeeds when called by the owning tenant.

    it(
      "same-tenant replyToInquiry succeeds, sends email, and persists a reply row",
      { timeout: 30_000 },
      async () => {
        const tenantIdA = makeId("tenantA-s3");
        await insertTenant(tenantIdA);

        const userId = makeId("user-s3");
        await insertUser(userId, tenantIdA);

        const artworkIdA = makeId("artworkA-s3");
        await insertArtwork(artworkIdA, tenantIdA);

        const inqIdA = makeId("inqA-s3");
        await insertInquiry(inqIdA, tenantIdA, artworkIdA);

        // Owner replies to their own inquiry.
        mockSession.tenantId = tenantIdA;
        mockSession.userId = userId;
        const result = await replyToInquiry(
          { status: "idle", message: "" },
          replyFormData(inqIdA, "Thanks for your interest!"),
        );

        // Action must succeed.
        expect(result.status).toBe("sent");

        // Email must have been sent exactly once.
        expect(sendInquiryReply).toHaveBeenCalledOnce();

        // A reply row must exist in inquiry_replies.
        const replyRow = await db.query.inquiryRepliesTable.findFirst({
          where: eq(inquiryRepliesTable.inquiryId, inqIdA),
        });
        expect(replyRow).toBeDefined();
        expect(replyRow?.tenantId).toBe(tenantIdA);
        expect(replyRow?.inquiryId).toBe(inqIdA);
        expect(replyRow?.message).toBe("Thanks for your interest!");
      },
    );
  },
);
