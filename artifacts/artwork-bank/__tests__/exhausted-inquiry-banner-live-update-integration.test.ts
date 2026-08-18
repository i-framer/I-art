/**
 * Task #1003 — Confirm the admin banner count updates live when a stuck
 * inquiry is unstuck.
 *
 * Background:
 *   Task #996 verified that getEmailFailCount includes the stuck row and that
 *   the count drops after requeueExhaustedInquiries resets it.  This test
 *   closes the remaining gap: confirming that the UI banner reflects the
 *   change *without a full page reload* by verifying two conditions:
 *
 *     (a) revalidatePath("/inquiries") is called by the admin action
 *         immediately after the requeue/clear succeeds, so Next.js purges
 *         the RSC cache for that route.
 *
 *     (b) getEmailFailCount queried *after* the action returns the updated
 *         count, proving no stale cache value is returned.
 *
 * Scenarios:
 *  1. retryFailedInquiryNotifications — exhausted row is requeued; banner
 *     count drops and revalidatePath("/inquiries") is called.
 *
 *  2. clearStuckInquiryNonces — stuck-nonce row is cleared; banner count is
 *     unchanged (the row is still exhausted) but revalidatePath("/inquiries")
 *     IS called so the stuck-nonce banner can hide.
 *
 *  3. retryFailedInquiryNotifications — revalidatePath("/', 'layout') is
 *     also called (keeps the nav badge in sync).
 *
 *  4. clearStuckInquiryNonces — revalidatePath("/", "layout") is also called.
 *
 *  5. Zero rows — both actions still call revalidatePath even when there is
 *     nothing to requeue/clear, ensuring the banner can render 0.
 *
 * All count assertions run against a real PostgreSQL database.
 * revalidatePath assertions use a vi.mock of next/cache so they are verified
 * without a live Next.js renderer.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable, inquiriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockSession = {
  userId: "u-1003-test",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test-1003",
}));

// Capture redirect calls as thrown errors so we can assert on the URL without
// actually navigating.
const redirectCalls: string[] = [];
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    redirectCalls.push(url);
    throw new Error(`REDIRECT:${url}`);
  }),
}));

// Track revalidatePath calls — the core assertion of this test.
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath }));

vi.mock("@/lib/base-url", () => ({
  getTenantUrl: (_tenant: unknown, path: string) =>
    `https://gallery.test${path}`,
  getPlatformBaseUrl: () => "https://platform.test",
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { MAX_EMAIL_ATTEMPTS } from "@/lib/email-sweep";
import { getEmailFailCount, getStuckNonceCount } from "@/app/(admin)/_actions/inquiry-count";
import {
  retryFailedInquiryNotifications,
  clearStuckInquiryNonces,
} from "@/app/(admin)/(gated)/inquiries/actions";

// ── Helpers ───────────────────────────────────────────────────────────────────

const RUN = randomUUID().slice(0, 8);
let seq = 0;
const CREATED_TENANT_IDS: string[] = [];
const CREATED_ARTWORK_IDS: string[] = [];
const CREATED_INQUIRY_IDS: string[] = [];

function makeId(label: string) {
  return `t1003-${RUN}-${++seq}-${label}`;
}

async function insertTenant(id: string): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Banner Live Update Test Gallery",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: null,
    contactEmail: "owner-1003@gallery.test",
  } as any);
}

async function insertArtwork(id: string, tenantId: string): Promise<void> {
  CREATED_ARTWORK_IDS.push(id);
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork 1003",
    sku: `sku-1003-${RUN}-${id.slice(-6)}`,
    status: "AVAILABLE",
  } as any);
}

/**
 * Insert an exhausted inquiry — all MAX_EMAIL_ATTEMPTS used, emailError set.
 * Optionally include a stuck nonce (emailLastAttemptAt = null).
 */
async function insertExhaustedInquiry(
  id: string,
  tenantId: string,
  artworkId: string,
  opts: { stuckNonce?: boolean } = {},
): Promise<void> {
  CREATED_INQUIRY_IDS.push(id);
  await db.insert(inquiriesTable).values({
    id,
    tenantId,
    artworkId,
    artworkTitle: "Test Artwork 1003",
    buyerName: "Banner Test Buyer",
    buyerEmail: "buyer-1003@example.com",
    message: "Is this available?",
    emailError: "smtp: connection refused (1003)",
    emailAttempts: MAX_EMAIL_ATTEMPTS,
    emailLastAttemptAt: opts.stuckNonce ? null : new Date(Date.now() - 60_000),
    emailClaimNonce: opts.stuckNonce ? randomUUID() : null,
    status: "NEW",
  } as any);
}

/** Run a server action and swallow the expected REDIRECT throw. */
async function runAction(fn: () => Promise<void>): Promise<string> {
  try {
    await fn();
    return "";
  } catch (err: any) {
    if (err?.message?.startsWith("REDIRECT:")) {
      return err.message.slice("REDIRECT:".length);
    }
    throw err;
  }
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
  redirectCalls.length = 0;
  await cleanup();
});

afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration(
  "Admin banner count updates live when a stuck inquiry is unstuck — real DB (Task #1003)",
  () => {
    // ── Scenario 1 ───────────────────────────────────────────────────────────

    it(
      "retryFailedInquiryNotifications drops getEmailFailCount immediately and calls revalidatePath('/inquiries')",
      { timeout: 30_000 },
      async () => {
        const tenantId = makeId("tenant-1003a");
        await insertTenant(tenantId);

        const artworkId = makeId("artwork-1003a");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq-1003a");
        await insertExhaustedInquiry(inqId, tenantId, artworkId);

        mockSession.tenantId = tenantId;

        // Pre-condition: banner shows the exhausted row.
        const countBefore = await getEmailFailCount();
        expect(countBefore).toBeGreaterThanOrEqual(1);

        // Admin triggers the "unstick" action.
        const redirectUrl = await runAction(retryFailedInquiryNotifications);

        // Action redirects to the inquiries page with result count.
        expect(redirectUrl).toMatch(/^\/inquiries\?retry_result=\d+$/);

        // revalidatePath is called for the inquiries route so the cached RSC
        // output is purged immediately — the banner can't serve a stale count.
        expect(revalidatePath).toHaveBeenCalledWith("/inquiries");

        // The DB itself reflects the reset — getEmailFailCount now returns a
        // lower value (the requeued row has emailAttempts = 0 < MAX_EMAIL_ATTEMPTS).
        const countAfter = await getEmailFailCount();
        expect(countAfter).toBe(countBefore - 1);
      },
    );

    // ── Scenario 2 ───────────────────────────────────────────────────────────

    it(
      "clearStuckInquiryNonces calls revalidatePath('/inquiries') and getStuckNonceCount drops to 0",
      { timeout: 30_000 },
      async () => {
        const tenantId = makeId("tenant-1003b");
        await insertTenant(tenantId);

        const artworkId = makeId("artwork-1003b");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq-1003b");
        // Stuck: nonce set, emailLastAttemptAt null.
        await insertExhaustedInquiry(inqId, tenantId, artworkId, {
          stuckNonce: true,
        });

        mockSession.tenantId = tenantId;

        // Pre-condition: one stuck-nonce row is visible.
        const stuckBefore = await getStuckNonceCount();
        expect(stuckBefore).toBeGreaterThanOrEqual(1);

        // Admin clears stuck nonces.
        const redirectUrl = await runAction(clearStuckInquiryNonces);

        // Action redirects with the clear count.
        expect(redirectUrl).toMatch(/^\/inquiries\?stuck_result=\d+$/);

        // revalidatePath purges the cached route so the stuck-nonce banner can
        // hide immediately — no stale count served to the next visitor.
        expect(revalidatePath).toHaveBeenCalledWith("/inquiries");

        // The stuck-nonce count drops to 0 after clearing.
        const stuckAfter = await getStuckNonceCount();
        expect(stuckAfter).toBe(0);

        // The exhausted-fail banner (getEmailFailCount) is unaffected — clearing
        // the nonce does NOT reset emailAttempts, so the row is still exhausted.
        const failCount = await getEmailFailCount();
        expect(failCount).toBeGreaterThanOrEqual(1);
      },
    );

    // ── Scenario 3 ───────────────────────────────────────────────────────────

    it(
      "retryFailedInquiryNotifications also calls revalidatePath('/', 'layout') to keep the nav badge in sync",
      { timeout: 30_000 },
      async () => {
        const tenantId = makeId("tenant-1003c");
        await insertTenant(tenantId);

        const artworkId = makeId("artwork-1003c");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq-1003c");
        await insertExhaustedInquiry(inqId, tenantId, artworkId);

        mockSession.tenantId = tenantId;

        await runAction(retryFailedInquiryNotifications);

        expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
      },
    );

    // ── Scenario 4 ───────────────────────────────────────────────────────────

    it(
      "clearStuckInquiryNonces also calls revalidatePath('/', 'layout') to keep the nav badge in sync",
      { timeout: 30_000 },
      async () => {
        const tenantId = makeId("tenant-1003d");
        await insertTenant(tenantId);

        const artworkId = makeId("artwork-1003d");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq-1003d");
        await insertExhaustedInquiry(inqId, tenantId, artworkId, {
          stuckNonce: true,
        });

        mockSession.tenantId = tenantId;

        await runAction(clearStuckInquiryNonces);

        expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
      },
    );

    // ── Scenario 5 ───────────────────────────────────────────────────────────

    it(
      "both actions call revalidatePath even when there are zero rows to process",
      { timeout: 30_000 },
      async () => {
        const tenantId = makeId("tenant-1003e");
        await insertTenant(tenantId);

        mockSession.tenantId = tenantId;

        // No inquiries seeded — both actions should still revalidate.
        await runAction(retryFailedInquiryNotifications);
        expect(revalidatePath).toHaveBeenCalledWith("/inquiries");
        expect(revalidatePath).toHaveBeenCalledWith("/", "layout");

        vi.clearAllMocks();

        await runAction(clearStuckInquiryNonces);
        expect(revalidatePath).toHaveBeenCalledWith("/inquiries");
        expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
      },
    );
  },
);
