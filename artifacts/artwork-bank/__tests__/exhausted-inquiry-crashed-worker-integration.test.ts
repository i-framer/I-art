/**
 * Task #995 — Confirm requeueExhaustedInquiries also unblocks a
 * crashed-worker row when the nonce is cleared.
 *
 * Background (mirrors Task #992 / #993 for retrySmtpErrorInquiries):
 *   requeueExhaustedInquiries uses an identical OR(emailClaimNonce IS NULL,
 *   emailLastAttemptAt < claimCutoff) lease guard.  When a sweep worker
 *   crashes after stamping emailClaimNonce but BEFORE writing
 *   emailLastAttemptAt, the row is left with:
 *     emailClaimNonce IS NOT NULL   (set by the worker)
 *     emailLastAttemptAt IS NULL    (never written)
 *
 *   In SQL the guard evaluates as:
 *     OR(emailClaimNonce IS NULL, emailLastAttemptAt < claimCutoff)
 *     = OR(false, NULL < cutoff)
 *     = OR(false, NULL)
 *     = NULL  →  falsy
 *
 *   The row is permanently excluded because there is no timestamp anchor.
 *   Unlike the expired-claim path (covered by Task #969), there is no
 *   self-healing: the claim can never time out.
 *
 * Repair path tested here:
 *   An operator (or an admin action) clears emailClaimNonce to NULL.
 *   This makes OR(emailClaimNonce IS NULL, …) evaluate to TRUE so the
 *   row is treated as unclaimed and requeueExhaustedInquiries can reset it.
 *
 * Flow under test:
 *  1. Seed an exhausted inquiry (emailAttempts = MAX_EMAIL_ATTEMPTS,
 *     emailError set) with emailClaimNonce IS NOT NULL and
 *     emailLastAttemptAt IS NULL — the crashed-worker stuck state.
 *  2. Call requeueExhaustedInquiries → confirm 0 rows are reset (stuck).
 *  3. Admin clears emailClaimNonce (sets it to NULL).
 *  4. Call requeueExhaustedInquiries → confirm the row is now reset:
 *       emailAttempts = 0, emailLastAttemptAt = null, emailClaimNonce = null,
 *       emailError preserved (so the sweep still selects the row).
 *  5. Run sweepUnsentInquiryEmails → confirm the email is delivered and
 *     emailError is cleared.
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
  userId: "u-995-test",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test-995",
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

// Email transport: capture calls without live SMTP/Resend.
const sendArtworkInquiry = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({
  sendArtworkInquiry: (...args: unknown[]) => sendArtworkInquiry(...args),
  sendOrderConfirmation: vi.fn(),
  sendOrderStatusUpdate: vi.fn(),
  sendConfirmationFailureNotice: vi.fn(),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import {
  requeueExhaustedInquiries,
  sweepUnsentInquiryEmails,
  MAX_EMAIL_ATTEMPTS,
} from "@/lib/email-sweep";

// ── Helpers ───────────────────────────────────────────────────────────────────

const RUN = randomUUID().slice(0, 8);
let seq = 0;
const CREATED_TENANT_IDS: string[] = [];
const CREATED_ARTWORK_IDS: string[] = [];
const CREATED_INQUIRY_IDS: string[] = [];

function makeId(label: string) {
  return `t995-${RUN}-${++seq}-${label}`;
}

async function insertTenant(
  id: string,
  opts: { contactEmail?: string } = {},
): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Exhausted Requeue Test Gallery",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: null,
    contactEmail: opts.contactEmail ?? null,
  } as any);
}

async function insertArtwork(id: string, tenantId: string): Promise<void> {
  CREATED_ARTWORK_IDS.push(id);
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork 995",
    sku: `sku-995-${RUN}-${id.slice(-6)}`,
    status: "AVAILABLE",
  } as any);
}

async function fetchRow(id: string) {
  return db.query.inquiriesTable.findFirst({
    where: eq(inquiriesTable.id, id),
  });
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
  "requeueExhaustedInquiries unblocks crashed-worker row after nonce is cleared — real DB (Task #995)",
  () => {
    /**
     * Confirm that requeueExhaustedInquiries permanently excludes a row that
     * has emailClaimNonce IS NOT NULL and emailLastAttemptAt IS NULL, and that
     * clearing the nonce to NULL makes the row retryable end-to-end.
     *
     * This is the parallel of Task #993 (which covers retrySmtpErrorInquiries)
     * for the requeueExhaustedInquiries function.
     */
    it(
      "crashed-worker exhausted row becomes retryable once the stale nonce is cleared (Task #995)",
      { timeout: 30_000 },
      async () => {
        // ── Seed ─────────────────────────────────────────────────────────────

        const tenantId = makeId("tenant-995");

        // Tenant has a contactEmail so the sweep can attempt delivery after
        // the row is unblocked.
        await insertTenant(tenantId, {
          contactEmail: "owner-995@gallery.test",
        });

        const artworkId = makeId("artwork-995");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq-995");
        CREATED_INQUIRY_IDS.push(inqId);

        const transportErrorMsg =
          "Transport failure: 550 mailbox not found (995)";

        // Seed the row at MAX_EMAIL_ATTEMPTS with emailError set and
        // emailLastAttemptAt = null (worker crashed before writing the timestamp).
        await db.insert(inquiriesTable).values({
          id: inqId,
          tenantId,
          artworkId,
          artworkTitle: "Test Artwork 995",
          buyerName: "Crashed Worker Buyer 995",
          buyerEmail: "buyer-995@example.com",
          message: "Is this available?",
          emailError: transportErrorMsg,
          emailAttempts: MAX_EMAIL_ATTEMPTS,
          emailLastAttemptAt: null, // worker crashed before writing this
          status: "NEW",
        } as any);

        // Stamp a non-null nonce — simulates a worker that set the claim
        // nonce but crashed before it could atomically write
        // emailLastAttemptAt.
        const crashedNonce = "crashed-nonce-995";
        await db
          .update(inquiriesTable)
          .set({ emailClaimNonce: crashedNonce } as any)
          .where(eq(inquiriesTable.id, inqId));

        mockSession.tenantId = tenantId;

        // ── Pre-conditions: confirm the row is in the stuck state ─────────────

        const rowBefore = await fetchRow(inqId);
        expect(rowBefore?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
        expect(rowBefore?.emailLastAttemptAt).toBeNull();
        expect((rowBefore as any)?.emailClaimNonce).toBe(crashedNonce);
        expect(rowBefore?.emailError).toBe(transportErrorMsg);

        // ── Step 1: confirm the row is excluded (stuck state) ─────────────────
        //
        // The lease guard in requeueExhaustedInquiries is:
        //   OR(emailClaimNonce IS NULL, emailLastAttemptAt < claimCutoff)
        //   = OR(false, NULL < cutoff)
        //   = OR(false, NULL)
        //   = NULL  →  falsy  →  row is skipped.

        const resetCountBefore = await requeueExhaustedInquiries(tenantId);
        expect(resetCountBefore).toBe(0);

        // Row must still be completely untouched.
        const rowStillStuck = await fetchRow(inqId);
        expect(rowStillStuck?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
        expect(rowStillStuck?.emailLastAttemptAt).toBeNull();
        expect((rowStillStuck as any)?.emailClaimNonce).toBe(crashedNonce);
        expect(rowStillStuck?.emailError).toBe(transportErrorMsg);

        // ── Step 2: admin clears the stale nonce ─────────────────────────────
        //
        // In production an admin action (or a manual DB fix) clears
        // emailClaimNonce to NULL.  This makes the lease guard's first branch
        // (emailClaimNonce IS NULL) evaluate to TRUE, so the row is treated
        // as unclaimed and eligible for requeueExhaustedInquiries.

        await db
          .update(inquiriesTable)
          .set({ emailClaimNonce: null } as any)
          .where(eq(inquiriesTable.id, inqId));

        const rowAfterClear = await fetchRow(inqId);
        expect((rowAfterClear as any)?.emailClaimNonce).toBeNull();
        expect(rowAfterClear?.emailLastAttemptAt).toBeNull(); // timestamp still null
        // emailAttempts must still be at MAX — the clear only touched the nonce.
        expect(rowAfterClear?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);

        // ── Step 3: requeueExhaustedInquiries now resets the row ──────────────
        //
        // With emailClaimNonce IS NULL the lease guard's first branch is TRUE,
        // so the row is included in the UPDATE regardless of emailLastAttemptAt.

        const resetCountAfter = await requeueExhaustedInquiries(tenantId);
        expect(resetCountAfter).toBe(1);

        // Row must be fully reset and retryable.
        const rowReset = await fetchRow(inqId);
        expect(rowReset?.emailAttempts).toBe(0);
        expect(rowReset?.emailLastAttemptAt).toBeNull();
        expect((rowReset as any)?.emailClaimNonce).toBeNull();
        // emailError is preserved — sweepUnsentInquiryEmails selects on
        // isNotNull(emailError), so the row must stay in the candidate set.
        expect(rowReset?.emailError).toBe(transportErrorMsg);

        // ── Step 4: sweep delivers the email end-to-end ───────────────────────
        //
        // With emailAttempts=0, emailLastAttemptAt=null, and emailError set,
        // the row is a first-class sweep candidate.  sweepUnsentInquiryEmails
        // should claim it, call sendArtworkInquiry, and clear emailError.

        sendArtworkInquiry.mockResolvedValueOnce(true);

        const sweepResult = await sweepUnsentInquiryEmails(
          new Date(),
          tenantId,
        );

        expect(sweepResult.sent).toBe(1);
        expect(sweepResult.failed).toBe(0);
        expect(sweepResult.scanned).toBeGreaterThanOrEqual(1);
        expect(sendArtworkInquiry).toHaveBeenCalledTimes(1);

        // emailError must be cleared — the row is no longer in a failure state.
        const rowDelivered = await fetchRow(inqId);
        expect(rowDelivered?.emailError).toBeNull();
        expect(rowDelivered?.emailAttempts).toBe(1);
        expect((rowDelivered as any)?.emailClaimNonce).toBeNull();
      },
    );
  },
);
