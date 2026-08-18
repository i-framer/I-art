/**
 * Task #1042 — Confirm reply threads stay hidden when the inquiry list query
 * is bypassed at the route layer.
 *
 * Background:
 *   Previous tests (Task #1031, Task #1041) confirm that `replyToInquiry` and
 *   `getInquiryReplies` both enforce tenantId scoping when called in isolation
 *   or as part of the page data-loading chain.
 *
 *   This test covers the complementary gap at the HTTP route / server-action
 *   entry point: an authenticated Tenant B session directly calls each server
 *   action that accepts an inquiryId parameter (`replyToInquiry`,
 *   `setInquiryStatus`, `setInquiryArchived`) using Tenant A's IDs — the same
 *   attack as crafting a POST with a foreign inquiryId.
 *
 * Scenarios:
 *  1. Tenant B calls replyToInquiry with Tenant A's inquiryId → returns error,
 *     sends no email, inserts no reply row.
 *  2. Tenant B calls setInquiryStatus with Tenant A's inquiryId → throws
 *     "Inquiry not found." and leaves Tenant A's inquiry status unchanged.
 *  3. Tenant B calls setInquiryArchived with Tenant A's inquiryId → throws
 *     "Inquiry not found." and leaves Tenant A's inquiry archivedAt unchanged.
 *  4. After all cross-tenant attempts, Tenant A's reply list remains empty
 *     (no rows were inserted by any action).
 *  5. Same-tenant sanity check: Tenant A can reply to their own inquiry,
 *     confirming the guard is scoped to tenantId, not a blanket block.
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
  userId: "u-1042-test",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test-1042",
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

import {
  replyToInquiry,
  setInquiryStatus,
  setInquiryArchived,
} from "@/app/(admin)/(gated)/inquiries/actions";

// ── Helpers ───────────────────────────────────────────────────────────────────

const RUN = randomUUID().slice(0, 8);
let seq = 0;
const CREATED_TENANT_IDS: string[] = [];
const CREATED_USER_IDS: string[] = [];
const CREATED_ARTWORK_IDS: string[] = [];
const CREATED_INQUIRY_IDS: string[] = [];

function makeId(label: string) {
  return `t1042-${RUN}-${++seq}-${label}`;
}

async function insertTenant(id: string): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Route Bypass Isolation Test Gallery 1042",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: null,
    contactEmail: "owner-1042@gallery.test",
  } as any);
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

async function insertArtwork(id: string, tenantId: string): Promise<void> {
  CREATED_ARTWORK_IDS.push(id);
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork 1042",
    sku: `sku-1042-${RUN}-${id.slice(-6)}`,
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
    artworkTitle: "Test Artwork 1042",
    buyerName: "Route Bypass Isolation Test Buyer",
    buyerEmail: "buyer-1042@example.com",
    message: "Is this artwork still available?",
    status: "NEW",
  } as any);
}

function replyFormData(inquiryId: string, replyMessage: string): FormData {
  const fd = new FormData();
  fd.set("inquiryId", inquiryId);
  fd.set("replyMessage", replyMessage);
  return fd;
}

function statusFormData(inquiryId: string, status: string): FormData {
  const fd = new FormData();
  fd.set("inquiryId", inquiryId);
  fd.set("status", status);
  return fd;
}

function archivedFormData(inquiryId: string, archived: string): FormData {
  const fd = new FormData();
  fd.set("inquiryId", inquiryId);
  fd.set("archived", archived);
  return fd;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describeIntegration(
  "Server actions — cross-tenant isolation via direct inquiryId parameter — real DB",
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

    // ── Scenario 1 ─────────────────────────────────────────────────────────────
    // Tenant B calls replyToInquiry with Tenant A's inquiryId.
    // The action must reject, never dispatch an email, and leave inquiry_replies
    // for Tenant A's inquiry empty.

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

        // Pre-condition: no replies exist for Tenant A's inquiry.
        const repliesBefore = await db.query.inquiryRepliesTable.findMany({
          where: eq(inquiryRepliesTable.inquiryId, inqIdA),
        });
        expect(repliesBefore).toHaveLength(0);

        // Tenant B directly calls the action with Tenant A's inquiryId.
        mockSession.tenantId = tenantIdB;
        const result = await replyToInquiry(
          { status: "idle", message: "" },
          replyFormData(inqIdA, "Cross-tenant reply attempt"),
        );

        // Must return an error — never "sent".
        expect(result.status).toBe("error");
        expect(result.message).toMatch(/inquiry not found/i);

        // No email must have been dispatched.
        expect(sendInquiryReply).not.toHaveBeenCalled();

        // DB assertion: inquiry_replies for Tenant A's inquiry is still empty.
        const repliesAfter = await db.query.inquiryRepliesTable.findMany({
          where: eq(inquiryRepliesTable.inquiryId, inqIdA),
        });
        expect(repliesAfter).toHaveLength(0);
      },
    );

    // ── Scenario 2 ─────────────────────────────────────────────────────────────
    // Tenant B calls setInquiryStatus with Tenant A's inquiryId.
    // The action must throw "Inquiry not found." and Tenant A's inquiry status
    // must remain "NEW".

    it(
      "cross-tenant setInquiryStatus throws and leaves the inquiry status unchanged",
      { timeout: 30_000 },
      async () => {
        const tenantIdA = makeId("tenantA-s2");
        const tenantIdB = makeId("tenantB-s2");
        await insertTenant(tenantIdA);
        await insertTenant(tenantIdB);

        const artworkIdA = makeId("artworkA-s2");
        await insertArtwork(artworkIdA, tenantIdA);

        const inqIdA = makeId("inqA-s2");
        await insertInquiry(inqIdA, tenantIdA, artworkIdA);

        // Tenant B directly calls the action with Tenant A's inquiryId.
        mockSession.tenantId = tenantIdB;
        await expect(
          setInquiryStatus(statusFormData(inqIdA, "HANDLED")),
        ).rejects.toThrow(/inquiry not found/i);

        // Tenant A's inquiry status must still be "NEW".
        const inqAfter = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, inqIdA),
        });
        expect(inqAfter).toBeDefined();
        expect(inqAfter?.status).toBe("NEW");
      },
    );

    // ── Scenario 3 ─────────────────────────────────────────────────────────────
    // Tenant B calls setInquiryArchived with Tenant A's inquiryId.
    // The action must throw "Inquiry not found." and Tenant A's inquiry
    // archivedAt must remain null.

    it(
      "cross-tenant setInquiryArchived throws and leaves the inquiry archivedAt unchanged",
      { timeout: 30_000 },
      async () => {
        const tenantIdA = makeId("tenantA-s3");
        const tenantIdB = makeId("tenantB-s3");
        await insertTenant(tenantIdA);
        await insertTenant(tenantIdB);

        const artworkIdA = makeId("artworkA-s3");
        await insertArtwork(artworkIdA, tenantIdA);

        const inqIdA = makeId("inqA-s3");
        await insertInquiry(inqIdA, tenantIdA, artworkIdA);

        // Tenant B directly calls the action with Tenant A's inquiryId.
        mockSession.tenantId = tenantIdB;
        await expect(
          setInquiryArchived(archivedFormData(inqIdA, "true")),
        ).rejects.toThrow(/inquiry not found/i);

        // Tenant A's inquiry must still be unarchived.
        const inqAfter = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, inqIdA),
        });
        expect(inqAfter).toBeDefined();
        expect(inqAfter?.archivedAt).toBeNull();
      },
    );

    // ── Scenario 4 ─────────────────────────────────────────────────────────────
    // After all cross-tenant attempts (all three actions), Tenant A's reply list
    // is confirmed empty — none of the actions inserted a reply row.

    it(
      "Tenant A reply list is unchanged (empty) after all cross-tenant action attempts",
      { timeout: 30_000 },
      async () => {
        const tenantIdA = makeId("tenantA-s4");
        const tenantIdB = makeId("tenantB-s4");
        await insertTenant(tenantIdA);
        await insertTenant(tenantIdB);

        const artworkIdA = makeId("artworkA-s4");
        await insertArtwork(artworkIdA, tenantIdA);

        const inqIdA = makeId("inqA-s4");
        await insertInquiry(inqIdA, tenantIdA, artworkIdA);

        // Tenant B attempts all three server actions with Tenant A's inquiryId.
        mockSession.tenantId = tenantIdB;

        const replyResult = await replyToInquiry(
          { status: "idle", message: "" },
          replyFormData(inqIdA, "Cross-tenant attempt"),
        );
        expect(replyResult.status).toBe("error");

        await expect(
          setInquiryStatus(statusFormData(inqIdA, "HANDLED")),
        ).rejects.toThrow(/inquiry not found/i);

        await expect(
          setInquiryArchived(archivedFormData(inqIdA, "true")),
        ).rejects.toThrow(/inquiry not found/i);

        // No emails dispatched across all attempts.
        expect(sendInquiryReply).not.toHaveBeenCalled();

        // Tenant A's reply list must still be empty — no row was inserted.
        const repliesAfter = await db.query.inquiryRepliesTable.findMany({
          where: eq(inquiryRepliesTable.inquiryId, inqIdA),
        });
        expect(repliesAfter).toHaveLength(0);
      },
    );

    // ── Scenario 5 ─────────────────────────────────────────────────────────────
    // Same-tenant sanity check: Tenant A can reply to their own inquiry,
    // confirming the guards are scoped to tenantId, not blanket blocks.

    it(
      "same-tenant replyToInquiry succeeds, sends email, and persists a reply row",
      { timeout: 30_000 },
      async () => {
        const tenantIdA = makeId("tenantA-s5");
        await insertTenant(tenantIdA);

        const userId = makeId("user-s5");
        await insertUser(userId, tenantIdA);

        const artworkIdA = makeId("artworkA-s5");
        await insertArtwork(artworkIdA, tenantIdA);

        const inqIdA = makeId("inqA-s5");
        await insertInquiry(inqIdA, tenantIdA, artworkIdA);

        // Tenant A replies to their own inquiry.
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
