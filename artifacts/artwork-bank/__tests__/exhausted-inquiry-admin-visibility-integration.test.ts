/**
 * Task #996 — Confirm a permanently-stuck exhausted inquiry is visible to
 * an admin (via getEmailFailCount) BEFORE the nonce is cleared.
 *
 * Background:
 *   A sweep worker can crash after stamping emailClaimNonce but BEFORE writing
 *   emailLastAttemptAt.  This leaves the row with:
 *     emailClaimNonce  IS NOT NULL   (set by the crashed worker)
 *     emailLastAttemptAt IS NULL     (never written)
 *
 *   The requeueExhaustedInquiries lease guard evaluates as:
 *     OR(emailClaimNonce IS NULL, emailLastAttemptAt < claimCutoff)
 *     = OR(false, NULL < cutoff)
 *     = OR(false, NULL)
 *     = NULL  →  falsy  →  row permanently skipped
 *
 *   Task #995 confirmed the repair path (clear nonce → requeue → sweep
 *   delivers).  This test confirms that the stuck row is surfaced in the
 *   admin-visible banner count (getEmailFailCount) BEFORE any repair, so
 *   the operator knows to act.
 *
 * Flow under test:
 *  1. Seed an exhausted inquiry (emailAttempts = MAX_EMAIL_ATTEMPTS,
 *     emailError set) with emailClaimNonce IS NOT NULL and
 *     emailLastAttemptAt IS NULL — the crashed-worker stuck state.
 *  2. Assert getEmailFailCount returns ≥ 1 (stuck row IS visible to admin).
 *  3. Admin clears emailClaimNonce to NULL.
 *  4. Assert getEmailFailCount is unchanged — clearing the nonce does NOT
 *     remove the row from the exhausted bucket (still exhausted until
 *     requeueExhaustedInquiries runs).
 *  5. Call requeueExhaustedInquiries — the row is now reset (emailAttempts=0).
 *  6. Assert getEmailFailCount drops (row exits the exhausted bucket once
 *     emailAttempts < MAX_EMAIL_ATTEMPTS).
 *
 * All assertions run against a real PostgreSQL database so the test catches
 * Drizzle query regressions, missing WHERE clauses, and column-mapping errors
 * that unit tests with a mocked DB cannot detect.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable, inquiriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockSession = {
  userId: "u-996-test",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test-996",
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

// ── Imports after mocks ───────────────────────────────────────────────────────

import {
  requeueExhaustedInquiries,
  MAX_EMAIL_ATTEMPTS,
} from "@/lib/email-sweep";
import { getEmailFailCount } from "@/app/(admin)/_actions/inquiry-count";

// ── Helpers ───────────────────────────────────────────────────────────────────

const RUN = randomUUID().slice(0, 8);
let seq = 0;
const CREATED_TENANT_IDS: string[] = [];
const CREATED_ARTWORK_IDS: string[] = [];
const CREATED_INQUIRY_IDS: string[] = [];

function makeId(label: string) {
  return `t996-${RUN}-${++seq}-${label}`;
}

async function insertTenant(id: string): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Admin Visibility Test Gallery",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: null,
    contactEmail: "owner-996@gallery.test",
  } as any);
}

async function insertArtwork(id: string, tenantId: string): Promise<void> {
  CREATED_ARTWORK_IDS.push(id);
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork 996",
    sku: `sku-996-${RUN}-${id.slice(-6)}`,
    status: "AVAILABLE",
  } as any);
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

async function cleanup() {
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

afterEach(async () => {
  vi.clearAllMocks();
  await cleanup();
});

afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration(
  "getEmailFailCount surfaces a permanently-stuck exhausted inquiry before the nonce is cleared — real DB (Task #996)",
  () => {
    /**
     * Core assertion: the admin banner count (getEmailFailCount) reflects the
     * stuck row in all three states:
     *   • stuck (nonce set, timestamp null)  → count ≥ 1
     *   • nonce cleared                      → count unchanged (still exhausted)
     *   • after requeueExhaustedInquiries    → count drops (emailAttempts reset)
     */
    it(
      "stuck exhausted row is visible to admin before nonce is cleared, and exits the bucket only after requeue (Task #996)",
      { timeout: 30_000 },
      async () => {
        // ── Seed ─────────────────────────────────────────────────────────────

        const tenantId = makeId("tenant-996");
        await insertTenant(tenantId);

        const artworkId = makeId("artwork-996");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq-996");
        CREATED_INQUIRY_IDS.push(inqId);

        const transportErrorMsg =
          "Transport failure: 550 mailbox not found (996)";

        // Insert with emailAttempts at the exhaustion limit, emailError set,
        // and emailLastAttemptAt = null (crashed worker never wrote it).
        await db.insert(inquiriesTable).values({
          id: inqId,
          tenantId,
          artworkId,
          artworkTitle: "Test Artwork 996",
          buyerName: "Admin Visibility Buyer 996",
          buyerEmail: "buyer-996@example.com",
          message: "Is this still available?",
          emailError: transportErrorMsg,
          emailAttempts: MAX_EMAIL_ATTEMPTS,
          emailLastAttemptAt: null, // worker crashed before writing this
          status: "NEW",
        } as any);

        // Stamp a non-null nonce — simulates a worker that set the claim nonce
        // but crashed before writing emailLastAttemptAt.
        const crashedNonce = "crashed-nonce-996";
        await db
          .update(inquiriesTable)
          .set({ emailClaimNonce: crashedNonce } as any)
          .where(eq(inquiriesTable.id, inqId));

        // Point the mocked session at this tenant so getEmailFailCount scopes
        // to the right tenant.
        mockSession.tenantId = tenantId;

        // ── Step 1: stuck row IS visible to admin ─────────────────────────────
        //
        // getEmailFailCount filters on:
        //   isNotNull(emailError) AND gte(emailAttempts, MAX_EMAIL_ATTEMPTS)
        //   AND isNull(archivedAt)
        //
        // The nonce / timestamp state is irrelevant to this query — the row
        // satisfies all three conditions regardless of the crashed-worker
        // artefacts, so the admin can see it and knows to act.

        const countStuck = await getEmailFailCount();
        expect(countStuck).toBeGreaterThanOrEqual(1);

        // ── Step 2: clearing the nonce does NOT hide the row ──────────────────
        //
        // Clearing emailClaimNonce → NULL only unblocks the requeue path; it
        // does not change emailAttempts or emailError, so the admin banner
        // count must remain identical.

        await db
          .update(inquiriesTable)
          .set({ emailClaimNonce: null } as any)
          .where(eq(inquiriesTable.id, inqId));

        const countAfterNonceClear = await getEmailFailCount();
        expect(countAfterNonceClear).toBe(countStuck);

        // ── Step 3: requeueExhaustedInquiries resets the row ─────────────────
        //
        // With emailClaimNonce IS NULL the lease guard now evaluates TRUE, so
        // requeueExhaustedInquiries can reset emailAttempts to 0 and clear
        // emailLastAttemptAt / emailClaimNonce.

        const resetCount = await requeueExhaustedInquiries(tenantId);
        expect(resetCount).toBeGreaterThanOrEqual(1);

        // ── Step 4: row exits the exhausted bucket ────────────────────────────
        //
        // After the reset, emailAttempts = 0 < MAX_EMAIL_ATTEMPTS, so
        // getEmailFailCount must no longer include this row.

        const countAfterRequeue = await getEmailFailCount();
        expect(countAfterRequeue).toBe(countStuck - 1);
      },
    );
  },
);
