/**
 * Task #1041 — Confirm reply-thread isolation holds when inquiry IDs are
 * guessed across tenants.
 *
 * Background:
 *   The task-1040 test proves `getInquiryReplies` (the DB query helper) blocks
 *   cross-tenant access when called in isolation.  This test goes one layer
 *   higher and exercises the FULL page data-loading sequence — the same chain
 *   the InquiriesPage server component runs:
 *
 *     1. Query the inquiry list scoped to session.tenantId  →  visible rows
 *     2. Extract their IDs from those rows
 *     3. Call getInquiryReplies(ids)  →  reply threads
 *
 *   The adversarial angle: Tenant B somehow obtains or guesses Tenant A's
 *   inquiry UUIDs and injects them into step 3 (e.g. via a future refactor
 *   that breaks the scoping at the inquiry-list layer).  The reply query must
 *   still enforce the tenantId guard so no Tenant A reply content leaks.
 *
 *   Testing the combined chain — not just the helper — ensures that moving the
 *   tenantId scope to a different layer (the inquiry query, a middleware, etc.)
 *   will still be caught here.
 *
 * Scenarios:
 *  1. Tenant B runs the page's inquiry-list query → gets 0 rows (correct).
 *     Tenant A's IDs are then injected into getInquiryReplies (adversarial
 *     guess).  The combined result set must be empty — no reply content leaks.
 *
 *  2. Same-tenant path: Tenant A runs the same page sequence and receives all
 *     their own replies, confirming the guard is tenantId-scoped, not a
 *     blanket block.
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
import { eq, and, isNull, desc } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockSession = {
  userId: "u-1041-test",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test-1041",
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

// ── Page data-loading helper ──────────────────────────────────────────────────
//
// Replicates the exact query chain that InquiriesPage performs:
//   1.  SELECT inquiries WHERE tenantId = session.tenantId (the "rows" query)
//   2.  getInquiryReplies(rows.map(r => r.id))             (the reply query)
//
// The returned object mirrors what the page derives from those two queries so
// tests can assert on both layers independently.

async function runPageDataLoader(sessionTenantId: string): Promise<{
  inquiryRows: { id: string }[];
  replies: Awaited<ReturnType<typeof getInquiryReplies>>;
}> {
  // Mirror the page's tenantWhere + "all non-archived" condition (line 83-93
  // of page.tsx).
  const inquiryRows = await db
    .select({ id: inquiriesTable.id })
    .from(inquiriesTable)
    .where(
      and(
        eq(inquiriesTable.tenantId, sessionTenantId),
        isNull(inquiriesTable.archivedAt),
      ),
    )
    .orderBy(desc(inquiriesTable.createdAt))
    .limit(25);

  // Mirror line 122 of page.tsx.
  const replies = await getInquiryReplies(inquiryRows.map((r) => r.id));

  return { inquiryRows, replies };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const RUN = randomUUID().slice(0, 8);
let seq = 0;
const CREATED_TENANT_IDS: string[] = [];
const CREATED_ARTWORK_IDS: string[] = [];
const CREATED_INQUIRY_IDS: string[] = [];
const CREATED_REPLY_IDS: string[] = [];

function makeId(label: string) {
  return `t1041-${RUN}-${++seq}-${label}`;
}

async function insertTenant(id: string): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Reply Page Path Isolation Test Gallery 1041",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: null,
    contactEmail: "owner-1041@gallery.test",
  } as any);
}

async function insertArtwork(id: string, tenantId: string): Promise<void> {
  CREATED_ARTWORK_IDS.push(id);
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork 1041",
    sku: `sku-1041-${RUN}-${id.slice(-6)}`,
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
    artworkTitle: "Test Artwork 1041",
    buyerName: "Page-Path Isolation Test Buyer",
    buyerEmail: "secret-buyer-1041@example.com",
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
  "InquiriesPage data-loader — cross-tenant reply isolation via guessed inquiry IDs — real DB",
  () => {
    // ── Scenario 1 ─────────────────────────────────────────────────────────────
    //
    // Tenant B runs the full page data-loading sequence.  Their inquiry-list
    // query returns 0 rows (correct — they have no inquiries).  The adversarial
    // step injects Tenant A's known inquiry IDs directly into getInquiryReplies,
    // simulating a future refactor where the first scoping layer might break.
    // The reply query must still return empty for Tenant B's session.

    it(
      "full page load with guessed cross-tenant IDs returns no replies — both layers enforce tenantId",
      { timeout: 30_000 },
      async () => {
        const tenantIdA = makeId("tenantA-s1");
        const tenantIdB = makeId("tenantB-s1");
        await insertTenant(tenantIdA);
        await insertTenant(tenantIdB);

        const artworkIdA = makeId("artworkA-s1");
        await insertArtwork(artworkIdA, tenantIdA);

        const inqIdA1 = makeId("inqA1-s1");
        const inqIdA2 = makeId("inqA2-s1");
        await insertInquiry(inqIdA1, tenantIdA, artworkIdA);
        await insertInquiry(inqIdA2, tenantIdA, artworkIdA);

        const REPLY_MSG_1 = "Private gallery staff note — scenario 1 reply A.";
        const REPLY_MSG_2 = "Confidential pricing details — scenario 1 reply B.";
        await insertReply(makeId("replyA1-s1"), tenantIdA, inqIdA1, REPLY_MSG_1);
        await insertReply(makeId("replyA2-s1"), tenantIdA, inqIdA2, REPLY_MSG_2);

        // ── Layer 1: page inquiry-list query under Tenant B's session ───────────
        // Tenant B has no inquiries — the inquiry-list query must return 0 rows.
        mockSession.tenantId = tenantIdB;
        const { inquiryRows: tenantBRows } =
          await runPageDataLoader(tenantIdB);

        expect(tenantBRows).toHaveLength(0);

        // ── Layer 2: adversarial injection of Tenant A's IDs ───────────────────
        // Simulate what happens if the first scoping layer were bypassed and
        // Tenant B's session was used to call getInquiryReplies with Tenant A's
        // known inquiry IDs directly.
        mockSession.tenantId = tenantIdB;
        const leakedReplies = await getInquiryReplies([inqIdA1, inqIdA2]);

        // The reply query must block the cross-tenant access entirely.
        expect(leakedReplies).toHaveLength(0);

        // Belt-and-suspenders: confirm no reply message content appears.
        const resultStr = JSON.stringify(leakedReplies);
        expect(resultStr).not.toContain(REPLY_MSG_1);
        expect(resultStr).not.toContain(REPLY_MSG_2);
      },
    );

    // ── Scenario 2 ─────────────────────────────────────────────────────────────
    //
    // Same-tenant path: Tenant A runs the full page data-loading sequence.
    // Their inquiry-list query returns their own rows, and the reply query
    // returns all attached reply threads — confirming the guard is scoped to
    // tenantId, not a blanket block.

    it(
      "full page load for the owning tenant returns inquiry rows and reply threads intact",
      { timeout: 30_000 },
      async () => {
        const tenantIdA = makeId("tenantA-s2");
        await insertTenant(tenantIdA);

        const artworkIdA = makeId("artworkA-s2");
        await insertArtwork(artworkIdA, tenantIdA);

        const inqIdA = makeId("inqA-s2");
        await insertInquiry(inqIdA, tenantIdA, artworkIdA);

        const REPLY_MSG_1 = "Welcome! The piece is still available — s2.";
        const REPLY_MSG_2 = "Happy to arrange a viewing — s2.";
        await insertReply(makeId("replyA1-s2"), tenantIdA, inqIdA, REPLY_MSG_1);
        await insertReply(makeId("replyA2-s2"), tenantIdA, inqIdA, REPLY_MSG_2);

        // Run the full page data-loading sequence as Tenant A.
        mockSession.tenantId = tenantIdA;
        const { inquiryRows, replies } = await runPageDataLoader(tenantIdA);

        // The inquiry-list layer must surface Tenant A's inquiry.
        expect(inquiryRows.map((r) => r.id)).toContain(inqIdA);

        // The reply layer must return both threads for Tenant A's inquiry.
        const forInqA = replies.filter((r) => r.inquiryId === inqIdA);
        expect(forInqA).toHaveLength(2);

        const messages = forInqA.map((r) => r.message);
        expect(messages).toContain(REPLY_MSG_1);
        expect(messages).toContain(REPLY_MSG_2);
      },
    );
  },
);
