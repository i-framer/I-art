/**
 * Task #1040 — Confirm a buyer's reply-thread can't be read by another gallery
 * on a real database.
 *
 * Background:
 *   The inquiries admin page fetches reply rows via getInquiryReplies(), which
 *   scopes the query by BOTH the session tenantId AND the supplied inquiry IDs.
 *   A regression that removes the tenantId WHERE clause would expose reply
 *   content (gallery staff names and messages) to other tenants who know or
 *   guess the inquiry IDs.
 *
 * Scenarios:
 *  1. Tenant B's session calling getInquiryReplies([idA]) returns an empty
 *     array — the reply content is not exposed across tenant boundaries.
 *  2. Tenant A's session calling getInquiryReplies([idA]) returns the expected
 *     reply rows — the guard is on tenantId, not a blanket block.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  inquiriesTable,
  inquiryRepliesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockSession = {
  userId: "u-1040-test",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test-1040",
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { getInquiryReplies } from "@/app/(admin)/(gated)/inquiries/actions";

// ── Helpers ───────────────────────────────────────────────────────────────────

const RUN = randomUUID().slice(0, 8);
let seq = 0;
const CREATED_TENANT_IDS: string[] = [];
const CREATED_ARTWORK_IDS: string[] = [];
const CREATED_INQUIRY_IDS: string[] = [];
const CREATED_REPLY_IDS: string[] = [];

function makeId(label: string) {
  return `t1040-${RUN}-${++seq}-${label}`;
}

async function insertTenant(id: string): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Reply Thread Isolation Test Gallery 1040",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: null,
    contactEmail: "owner-1040@gallery.test",
  } as any);
}

async function insertArtwork(id: string, tenantId: string): Promise<void> {
  CREATED_ARTWORK_IDS.push(id);
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork 1040",
    sku: `sku-1040-${RUN}-${id.slice(-6)}`,
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
    artworkTitle: "Test Artwork 1040",
    buyerName: "Cross-Tenant Reply Thread Test Buyer",
    buyerEmail: "secret-buyer-1040@example.com",
    message: "I am interested in this piece.",
    status: "NEW",
  } as any);
}

async function insertReply(
  id: string,
  tenantId: string,
  inquiryId: string,
  message: string,
): Promise<void> {
  CREATED_REPLY_IDS.push(id);
  await db.insert(inquiryRepliesTable).values({
    id,
    tenantId,
    inquiryId,
    sentByUserId: null,
    message,
  } as any);
}

// ── Teardown ──────────────────────────────────────────────────────────────────

async function cleanUp() {
  for (const id of CREATED_REPLY_IDS.splice(0)) {
    await db
      .delete(inquiryRepliesTable)
      .where(eq(inquiryRepliesTable.id, id))
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
  for (const id of CREATED_TENANT_IDS.splice(0)) {
    await db
      .delete(tenantsTable)
      .where(eq(tenantsTable.id, id))
      .catch(() => {});
  }
}

afterEach(cleanUp);
afterAll(cleanUp);

// ── Suite ─────────────────────────────────────────────────────────────────────

describeIntegration(
  "getInquiryReplies — cross-tenant reply-thread isolation — real DB",
  () => {
    // ── Scenario 1 ─────────────────────────────────────────────────────────────
    // Tenant B's session calls getInquiryReplies with Tenant A's inquiry ID.
    // The tenantId WHERE clause must exclude Tenant A's replies entirely.

    it(
      "cross-tenant getInquiryReplies returns no rows — reply content is not exposed",
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

        const replyId1 = makeId("replyA-s1a");
        const replyId2 = makeId("replyA-s1b");
        const REPLY_MSG_1 = "Thank you for reaching out to Gallery A staff!";
        const REPLY_MSG_2 = "Here is more private information from staff.";
        await insertReply(replyId1, tenantIdA, inqIdA, REPLY_MSG_1);
        await insertReply(replyId2, tenantIdA, inqIdA, REPLY_MSG_2);

        // Switch session to Tenant B — simulates another gallery's authenticated user.
        mockSession.tenantId = tenantIdB;

        const results = await getInquiryReplies([inqIdA]);

        // No rows must be returned — tenantId scoping blocks cross-tenant access.
        expect(results).toHaveLength(0);

        // Belt-and-suspenders: confirm neither reply message appears in the result.
        const resultStr = JSON.stringify(results);
        expect(resultStr).not.toContain(REPLY_MSG_1);
        expect(resultStr).not.toContain(REPLY_MSG_2);
      },
    );

    // ── Scenario 2 ─────────────────────────────────────────────────────────────
    // Confirms the guard lives in the tenantId WHERE clause, not a blanket
    // block: the owning tenant can still retrieve their own reply rows via the
    // same function.

    it(
      "same-tenant getInquiryReplies returns the expected reply rows intact",
      { timeout: 30_000 },
      async () => {
        const tenantIdA = makeId("tenantA-s2");
        await insertTenant(tenantIdA);

        const artworkIdA = makeId("artworkA-s2");
        await insertArtwork(artworkIdA, tenantIdA);

        const inqIdA = makeId("inqA-s2");
        await insertInquiry(inqIdA, tenantIdA, artworkIdA);

        const replyId1 = makeId("replyA-s2a");
        const replyId2 = makeId("replyA-s2b");
        const REPLY_MSG_1 = "Welcome! The piece is still available.";
        const REPLY_MSG_2 = "Happy to arrange a viewing.";
        await insertReply(replyId1, tenantIdA, inqIdA, REPLY_MSG_1);
        await insertReply(replyId2, tenantIdA, inqIdA, REPLY_MSG_2);

        // Switch session to the owning tenant.
        mockSession.tenantId = tenantIdA;

        const results = await getInquiryReplies([inqIdA]);

        expect(results).toHaveLength(2);

        // Every row must be scoped to Tenant A's inquiry.
        for (const row of results) {
          expect(row.inquiryId).toBe(inqIdA);
        }

        const messages = results.map((r) => r.message);
        expect(messages).toContain(REPLY_MSG_1);
        expect(messages).toContain(REPLY_MSG_2);
      },
    );
  },
);
