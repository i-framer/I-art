/**
 * Task #997 — Confirm requeueExhaustedInquiries skips an active-claim row for
 * the same tenant.
 *
 * requeueExhaustedInquiries uses an OR(emailClaimNonce IS NULL,
 * emailLastAttemptAt < claimCutoff) lease guard — identical to the guard in
 * retrySmtpErrorInquiries (covered by Tasks #990 / #991).  A regression in
 * that guard could allow a live sweep's row to be double-reset, producing a
 * double-send to an exhausted inquiry.
 *
 * Flow under test:
 *  1. Seed two exhausted inquiries under the same tenant, both with
 *     emailAttempts = MAX_EMAIL_ATTEMPTS and emailError set:
 *       Inquiry A — expired claim  (emailLastAttemptAt older than CLAIM_LEASE_MS,
 *                                   emailClaimNonce IS NOT NULL)
 *       Inquiry B — active claim   (emailLastAttemptAt within CLAIM_LEASE_MS,
 *                                   emailClaimNonce IS NOT NULL)
 *  2. Call requeueExhaustedInquiries → confirm resetCount === 1 (only A).
 *  3. Assert Inquiry A is fully reset:
 *       emailAttempts → 0, emailLastAttemptAt → null, emailClaimNonce → null.
 *  4. Assert Inquiry B is completely untouched.
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
  userId: "u-997-test",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test-997",
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
  MAX_EMAIL_ATTEMPTS,
  CLAIM_LEASE_MS,
} from "@/lib/email-sweep";

// ── Helpers ───────────────────────────────────────────────────────────────────

const RUN = randomUUID().slice(0, 8);
let seq = 0;
const CREATED_TENANT_IDS: string[] = [];
const CREATED_ARTWORK_IDS: string[] = [];
const CREATED_INQUIRY_IDS: string[] = [];

function makeId(label: string) {
  return `t997-${RUN}-${++seq}-${label}`;
}

async function insertTenant(id: string): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Active Claim Requeue Test Gallery",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: null,
    contactEmail: "owner-997@gallery.test",
  } as any);
}

async function insertArtwork(id: string, tenantId: string): Promise<void> {
  CREATED_ARTWORK_IDS.push(id);
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork 997",
    sku: `sku-997-${RUN}-${id.slice(-6)}`,
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
  "requeueExhaustedInquiries skips an active-claim row for the same tenant — real DB (Task #997)",
  () => {
    /**
     * Two exhausted inquiries under the same tenant:
     *   A — expired claim  → must be reset
     *   B — active claim   → must be skipped
     *
     * Only Inquiry A should be returned by requeueExhaustedInquiries and
     * Inquiry B must remain completely untouched.
     */
    it(
      "resets only the expired-claim inquiry and leaves the active-claim inquiry untouched (Task #997)",
      { timeout: 30_000 },
      async () => {
        // ── Seed ─────────────────────────────────────────────────────────────

        const tenantId = makeId("tenant-997");
        await insertTenant(tenantId);

        const artworkIdA = makeId("artwork-997-a");
        await insertArtwork(artworkIdA, tenantId);

        const artworkIdB = makeId("artwork-997-b");
        await insertArtwork(artworkIdB, tenantId);

        const inqIdA = makeId("inq-997-a");
        const inqIdB = makeId("inq-997-b");
        CREATED_INQUIRY_IDS.push(inqIdA, inqIdB);

        const errorMsg = "Transport failure: 550 mailbox not found (997)";

        // Inquiry A — expired claim:
        //   emailLastAttemptAt set to more than CLAIM_LEASE_MS in the past so
        //   the lease guard's second branch (emailLastAttemptAt < claimCutoff)
        //   evaluates to TRUE.
        const expiredAt = new Date(Date.now() - CLAIM_LEASE_MS - 60_000);

        await db.insert(inquiriesTable).values({
          id: inqIdA,
          tenantId,
          artworkId: artworkIdA,
          artworkTitle: "Test Artwork 997",
          buyerName: "Expired Claim Buyer 997",
          buyerEmail: "buyer-a-997@example.com",
          message: "Is artwork A available?",
          emailError: errorMsg,
          emailAttempts: MAX_EMAIL_ATTEMPTS,
          emailLastAttemptAt: expiredAt,
          status: "NEW",
        } as any);

        // Stamp a non-null nonce so the lease guard's first branch is FALSE and
        // only the timestamp branch can unlock the row.
        const nonceA = "expired-claim-nonce-997-a";
        await db
          .update(inquiriesTable)
          .set({ emailClaimNonce: nonceA } as any)
          .where(eq(inquiriesTable.id, inqIdA));

        // Inquiry B — active claim:
        //   emailLastAttemptAt within CLAIM_LEASE_MS, so both branches of the
        //   lease guard evaluate to FALSE/falsy and the row must be skipped.
        const activeAt = new Date(Date.now() - 1_000); // 1 second ago

        await db.insert(inquiriesTable).values({
          id: inqIdB,
          tenantId,
          artworkId: artworkIdB,
          artworkTitle: "Test Artwork 997",
          buyerName: "Active Claim Buyer 997",
          buyerEmail: "buyer-b-997@example.com",
          message: "Is artwork B available?",
          emailError: errorMsg,
          emailAttempts: MAX_EMAIL_ATTEMPTS,
          emailLastAttemptAt: activeAt,
          status: "NEW",
        } as any);

        const nonceB = "active-claim-nonce-997-b";
        await db
          .update(inquiriesTable)
          .set({ emailClaimNonce: nonceB } as any)
          .where(eq(inquiriesTable.id, inqIdB));

        mockSession.tenantId = tenantId;

        // ── Pre-conditions ────────────────────────────────────────────────────

        const rowABefore = await fetchRow(inqIdA);
        expect(rowABefore?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
        expect(rowABefore?.emailLastAttemptAt?.getTime()).toBe(
          expiredAt.getTime(),
        );
        expect((rowABefore as any)?.emailClaimNonce).toBe(nonceA);
        expect(rowABefore?.emailError).toBe(errorMsg);

        const rowBBefore = await fetchRow(inqIdB);
        expect(rowBBefore?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
        expect(rowBBefore?.emailLastAttemptAt?.getTime()).toBe(
          activeAt.getTime(),
        );
        expect((rowBBefore as any)?.emailClaimNonce).toBe(nonceB);
        expect(rowBBefore?.emailError).toBe(errorMsg);

        // ── Call under test ───────────────────────────────────────────────────

        const resetCount = await requeueExhaustedInquiries(tenantId);

        // Only Inquiry A (expired claim) must be reset; Inquiry B is skipped.
        expect(resetCount).toBe(1);

        // ── Assert Inquiry A is fully reset ───────────────────────────────────

        const rowAAfter = await fetchRow(inqIdA);
        expect(rowAAfter?.emailAttempts).toBe(0);
        expect(rowAAfter?.emailLastAttemptAt).toBeNull();
        expect((rowAAfter as any)?.emailClaimNonce).toBeNull();
        // emailError is preserved so sweepUnsentInquiryEmails can still select
        // the row as a candidate.
        expect(rowAAfter?.emailError).toBe(errorMsg);

        // ── Assert Inquiry B is completely untouched ──────────────────────────

        const rowBAfter = await fetchRow(inqIdB);
        expect(rowBAfter?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
        expect(rowBAfter?.emailLastAttemptAt?.getTime()).toBe(
          activeAt.getTime(),
        );
        expect((rowBAfter as any)?.emailClaimNonce).toBe(nonceB);
        expect(rowBAfter?.emailError).toBe(errorMsg);
      },
    );
  },
);
