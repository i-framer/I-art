/**
 * Task #1009 / Task #1011 / Task #1014 — Confirm the retry-failed-notifications action can't
 * be triggered by a caller who shouldn't have access.
 *
 * Verifies the two access guards on the destructive admin actions in the
 * inquiries panel (app/(admin)/(gated)/inquiries/actions.ts):
 *
 *  1. retryFailedInquiryNotifications — unauthenticated caller → redirects to /login
 *  2. clearStuckInquiryNonces         — unauthenticated caller → redirects to /login
 *  3. retryFailedInquiryNotifications — tenant without active billing (null) →
 *       throws "Subscription required" before any DB write
 *  4. clearStuckInquiryNonces         — tenant without active billing (null) →
 *       throws "Subscription required" before any DB write
 *  5. retryFailedInquiryNotifications — tenant with canceled subscription →
 *       throws "Subscription required" before any DB write  (Task #1011)
 *  6. clearStuckInquiryNonces         — tenant with canceled subscription →
 *       throws "Subscription required" before any DB write  (Task #1011)
 *  7. A tenant with past_due billing and no exemption can call both actions
 *       while Stripe retries its card, and each action performs its mutation
 *       (Task #1014)
 *  8. A tenant with billingExempt=true and a canceled subscription can call
 *       both actions, proving the exemption bypasses subscription status
 *       (Task #1015)
 *
 * Mirrors the pattern used in exhausted-inquiry-banner-live-update-integration.test.ts.
 * Billing-gate assertions run against a real PostgreSQL database so the
 * requireActiveBillingAccess DB read is exercised on real tenant rows.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable, inquiriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockSession = {
  userId: "u-1009-test",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test-1009",
}));

// Capture redirect() as a thrown error so we can assert on the URL without
// actually navigating.
const redirectCalls: string[] = [];
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    redirectCalls.push(url);
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

import { MAX_EMAIL_ATTEMPTS } from "@/lib/email-sweep";
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
  return `t1009-${RUN}-${++seq}-${label}`;
}

/**
 * Insert a tenant that has NO active billing — billingExempt is false and
 * subscriptionStatus is null — so requireActiveBillingAccess will reject it.
 */
async function insertUnsubscribedTenant(id: string): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Unsubscribed Access Guard Test Gallery",
    type: "ARTIST",
    billingExempt: false,
    subscriptionStatus: null,
    contactEmail: "owner-1009@gallery.test",
  } as any);
}

/**
 * Insert a tenant whose subscription is explicitly 'canceled' — billingExempt
 * is false and subscriptionStatus is 'canceled', which is NOT in ACTIVE_STATUSES
 * — so requireActiveBillingAccess will reject it.
 */
async function insertCanceledTenant(id: string): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Canceled Subscription Access Guard Test Gallery",
    type: "ARTIST",
    billingExempt: false,
    subscriptionStatus: "canceled",
    contactEmail: "owner-1011@gallery.test",
  } as any);
}

/**
 * Insert a tenant that is explicitly billing-exempt despite a canceled
 * subscription. The exemption must take precedence over subscription status.
 */
async function insertBillingExemptCanceledTenant(id: string): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Billing Exempt Canceled Access Guard Test Gallery",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: "canceled",
    contactEmail: "owner-1015@gallery.test",
  } as any);
}

/**
 * Insert a tenant whose subscription is past_due. This status is intentionally
 * granted access during Stripe's card-retry grace period, even without a
 * billing exemption.
 */
async function insertPastDueTenant(id: string): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Past Due Access Guard Test Gallery",
    type: "ARTIST",
    billingExempt: false,
    subscriptionStatus: "past_due",
    contactEmail: "owner-1014@gallery.test",
  } as any);
}

async function insertArtwork(id: string, tenantId: string): Promise<void> {
  CREATED_ARTWORK_IDS.push(id);
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork 1009",
    sku: `sku-1009-${RUN}-${id.slice(-6)}`,
    status: "AVAILABLE",
  } as any);
}

async function insertExhaustedInquiry(
  id: string,
  tenantId: string,
  artworkId: string,
): Promise<void> {
  CREATED_INQUIRY_IDS.push(id);
  await db.insert(inquiriesTable).values({
    id,
    tenantId,
    artworkId,
    artworkTitle: "Test Artwork 1009",
    buyerName: "Access Guard Test Buyer",
    buyerEmail: "buyer-1009@example.com",
    message: "Is this available?",
    emailError: "smtp: connection refused (1009)",
    emailAttempts: MAX_EMAIL_ATTEMPTS,
    emailLastAttemptAt: new Date(Date.now() - 60_000),
    emailClaimNonce: null,
    status: "NEW",
  } as any);
}

/** Run a server action and return the REDIRECT url, or rethrow any other error. */
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
  "retry-failed-notifications access guards — real DB (Tasks #1009, #1011, #1014, #1015)",
  () => {
    // ── Scenario 1 ───────────────────────────────────────────────────────────

    it(
      "retryFailedInquiryNotifications — unauthenticated caller is redirected to /login",
      { timeout: 30_000 },
      async () => {
        // Arrange: session with no userId (unauthenticated)
        mockSession.userId = "";
        mockSession.tenantId = "unused-1009a";

        // Act
        const redirectUrl = await runAction(retryFailedInquiryNotifications);

        // Assert: auth guard fires before any other logic
        expect(redirectUrl).toBe("/login");
      },
    );

    // ── Scenario 2 ───────────────────────────────────────────────────────────

    it(
      "clearStuckInquiryNonces — unauthenticated caller is redirected to /login",
      { timeout: 30_000 },
      async () => {
        // Arrange: session with no userId (unauthenticated)
        mockSession.userId = "";
        mockSession.tenantId = "unused-1009b";

        // Act
        const redirectUrl = await runAction(clearStuckInquiryNonces);

        // Assert: auth guard fires before any other logic
        expect(redirectUrl).toBe("/login");
      },
    );

    // ── Scenario 3 ───────────────────────────────────────────────────────────

    it(
      "retryFailedInquiryNotifications — tenant without active billing throws before any DB write",
      { timeout: 30_000 },
      async () => {
        const tenantId = makeId("tenant-1009c");
        await insertUnsubscribedTenant(tenantId);

        const artworkId = makeId("artwork-1009c");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq-1009c");
        await insertExhaustedInquiry(inqId, tenantId, artworkId);

        // Restore a valid userId so the auth guard passes; billing guard fires.
        mockSession.userId = "u-1009-test";
        mockSession.tenantId = tenantId;

        // Act — billing gate should throw, not redirect
        await expect(retryFailedInquiryNotifications()).rejects.toThrow(
          "Subscription required",
        );

        // The inquiry row must be completely untouched — no requeue happened.
        const row = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, inqId),
        });
        expect(row?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
        expect(row?.emailLastAttemptAt).not.toBeNull();
        expect(row?.emailError).toBe("smtp: connection refused (1009)");
      },
    );

    // ── Scenario 4 ───────────────────────────────────────────────────────────

    it(
      "clearStuckInquiryNonces — tenant without active billing throws before any DB write",
      { timeout: 30_000 },
      async () => {
        const tenantId = makeId("tenant-1009d");
        await insertUnsubscribedTenant(tenantId);

        const artworkId = makeId("artwork-1009d");
        await insertArtwork(artworkId, tenantId);

        // Insert a stuck-nonce inquiry (emailClaimNonce IS NOT NULL AND
        // emailLastAttemptAt IS NULL) — the kind clearStuckInquiryNonces targets.
        const inqId = makeId("inq-1009d");
        CREATED_INQUIRY_IDS.push(inqId);
        await db.insert(inquiriesTable).values({
          id: inqId,
          tenantId,
          artworkId,
          artworkTitle: "Test Artwork 1009",
          buyerName: "Access Guard Test Buyer",
          buyerEmail: "buyer-1009d@example.com",
          message: "Is this available?",
          emailError: "smtp: connection refused (1009d)",
          emailAttempts: MAX_EMAIL_ATTEMPTS,
          emailLastAttemptAt: null,
          emailClaimNonce: randomUUID(),
          status: "NEW",
        } as any);

        // Restore a valid userId so the auth guard passes; billing guard fires.
        mockSession.userId = "u-1009-test";
        mockSession.tenantId = tenantId;

        // Act — billing gate should throw, not redirect
        await expect(clearStuckInquiryNonces()).rejects.toThrow(
          "Subscription required",
        );

        // The inquiry row must be completely untouched — nonce must still be set.
        const row = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, inqId),
        });
        expect(row?.emailClaimNonce).not.toBeNull();
        expect(row?.emailLastAttemptAt).toBeNull();
        expect(row?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
      },
    );

    // ── Scenario 5 (Task #1011) ───────────────────────────────────────────────

    it(
      "retryFailedInquiryNotifications — tenant with canceled subscription throws before any DB write",
      { timeout: 30_000 },
      async () => {
        const tenantId = makeId("tenant-1011a");
        await insertCanceledTenant(tenantId);

        const artworkId = makeId("artwork-1011a");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq-1011a");
        await insertExhaustedInquiry(inqId, tenantId, artworkId);

        // Restore a valid userId so the auth guard passes; billing guard fires.
        mockSession.userId = "u-1009-test";
        mockSession.tenantId = tenantId;

        // Act — 'canceled' is not in ACTIVE_STATUSES, so the billing gate throws.
        await expect(retryFailedInquiryNotifications()).rejects.toThrow(
          "Subscription required",
        );

        // The inquiry row must be completely untouched — no requeue happened.
        const row = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, inqId),
        });
        expect(row?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
        expect(row?.emailLastAttemptAt).not.toBeNull();
        expect(row?.emailError).toBe("smtp: connection refused (1009)");
      },
    );

    // ── Scenario 6 (Task #1011) ───────────────────────────────────────────────

    it(
      "clearStuckInquiryNonces — tenant with canceled subscription throws before any DB write",
      { timeout: 30_000 },
      async () => {
        const tenantId = makeId("tenant-1011b");
        await insertCanceledTenant(tenantId);

        const artworkId = makeId("artwork-1011b");
        await insertArtwork(artworkId, tenantId);

        // Insert a stuck-nonce inquiry (emailClaimNonce IS NOT NULL AND
        // emailLastAttemptAt IS NULL) — the kind clearStuckInquiryNonces targets.
        const inqId = makeId("inq-1011b");
        CREATED_INQUIRY_IDS.push(inqId);
        await db.insert(inquiriesTable).values({
          id: inqId,
          tenantId,
          artworkId,
          artworkTitle: "Test Artwork 1011",
          buyerName: "Access Guard Test Buyer",
          buyerEmail: "buyer-1011b@example.com",
          message: "Is this available?",
          emailError: "smtp: connection refused (1011b)",
          emailAttempts: MAX_EMAIL_ATTEMPTS,
          emailLastAttemptAt: null,
          emailClaimNonce: randomUUID(),
          status: "NEW",
        } as any);

        // Restore a valid userId so the auth guard passes; billing guard fires.
        mockSession.userId = "u-1009-test";
        mockSession.tenantId = tenantId;

        // Act — 'canceled' is not in ACTIVE_STATUSES, so the billing gate throws.
        await expect(clearStuckInquiryNonces()).rejects.toThrow(
          "Subscription required",
        );

        // The inquiry row must be completely untouched — nonce must still be set.
        const row = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, inqId),
        });
        expect(row?.emailClaimNonce).not.toBeNull();
        expect(row?.emailLastAttemptAt).toBeNull();
        expect(row?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
      },
    );

    // ── Scenario 7 (Task #1014) ──────────────────────────────────────────────

    it(
      "past_due tenant without billing exemption can retry failures and clear stuck nonces",
      { timeout: 30_000 },
      async () => {
        const tenantId = makeId("tenant-1014");
        await insertPastDueTenant(tenantId);

        const artworkId = makeId("artwork-1014");
        await insertArtwork(artworkId, tenantId);

        // Use separate rows because each action targets a different recovery
        // state: retry handles exhausted SMTP errors, while clear handles a
        // claim that was recorded before the worker could stamp an attempt.
        const retryInquiryId = makeId("inq-1014-retry");
        await insertExhaustedInquiry(retryInquiryId, tenantId, artworkId);

        const stuckInquiryId = makeId("inq-1014-stuck");
        CREATED_INQUIRY_IDS.push(stuckInquiryId);
        await db.insert(inquiriesTable).values({
          id: stuckInquiryId,
          tenantId,
          artworkId,
          artworkTitle: "Test Artwork 1014",
          buyerName: "Past Due Access Guard Test Buyer",
          buyerEmail: "buyer-1014@example.com",
          message: "Is this available?",
          emailError: "smtp: connection refused (1014)",
          emailAttempts: MAX_EMAIL_ATTEMPTS,
          emailLastAttemptAt: null,
          emailClaimNonce: randomUUID(),
          status: "NEW",
        } as any);

        mockSession.userId = "u-1009-test";
        mockSession.tenantId = tenantId;

        // The past_due grace period must pass the billing guard, so the
        // actions reach their normal redirect paths instead of throwing
        // "Subscription required".
        await expect(
          runAction(retryFailedInquiryNotifications),
        ).resolves.toBe(`/inquiries?retry_result=1`);
        await expect(runAction(clearStuckInquiryNonces)).resolves.toBe(
          `/inquiries?stuck_result=1`,
        );

        const retriedRow = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, retryInquiryId),
        });
        expect(retriedRow?.emailAttempts).toBe(0);
        expect(retriedRow?.emailLastAttemptAt).toBeNull();
        expect(retriedRow?.emailClaimNonce).toBeNull();
        expect(retriedRow?.emailError).toBe("smtp: connection refused (1009)");

        const clearedRow = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, stuckInquiryId),
        });
        expect(clearedRow?.emailClaimNonce).toBeNull();
        expect(clearedRow?.emailLastAttemptAt).toBeNull();
        expect(clearedRow?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
        expect(clearedRow?.emailError).toBe("smtp: connection refused (1014)");
      },
    );

    // ── Scenario 8 (Task #1015) ──────────────────────────────────────────────

    it(
      "billing-exempt tenant with canceled subscription can retry failures and clear stuck nonces",
      { timeout: 30_000 },
      async () => {
        const tenantId = makeId("tenant-1015");
        await insertBillingExemptCanceledTenant(tenantId);

        const artworkId = makeId("artwork-1015");
        await insertArtwork(artworkId, tenantId);

        const retryInquiryId = makeId("inq-1015-retry");
        await insertExhaustedInquiry(retryInquiryId, tenantId, artworkId);

        const stuckInquiryId = makeId("inq-1015-stuck");
        CREATED_INQUIRY_IDS.push(stuckInquiryId);
        await db.insert(inquiriesTable).values({
          id: stuckInquiryId,
          tenantId,
          artworkId,
          artworkTitle: "Test Artwork 1015",
          buyerName: "Billing Exempt Access Guard Test Buyer",
          buyerEmail: "buyer-1015@example.com",
          message: "Is this available?",
          emailError: "smtp: connection refused (1015)",
          emailAttempts: MAX_EMAIL_ATTEMPTS,
          emailLastAttemptAt: null,
          emailClaimNonce: randomUUID(),
          status: "NEW",
        } as any);

        mockSession.userId = "u-1009-test";
        mockSession.tenantId = tenantId;

        // billingExempt must bypass the canceled subscription status, allowing
        // both actions to reach their normal mutation and redirect paths.
        await expect(
          runAction(retryFailedInquiryNotifications),
        ).resolves.toBe(`/inquiries?retry_result=1`);
        await expect(runAction(clearStuckInquiryNonces)).resolves.toBe(
          `/inquiries?stuck_result=1`,
        );

        const retriedRow = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, retryInquiryId),
        });
        expect(retriedRow?.emailAttempts).toBe(0);
        expect(retriedRow?.emailLastAttemptAt).toBeNull();
        expect(retriedRow?.emailClaimNonce).toBeNull();

        const clearedRow = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, stuckInquiryId),
        });
        expect(clearedRow?.emailClaimNonce).toBeNull();
        expect(clearedRow?.emailLastAttemptAt).toBeNull();
        expect(clearedRow?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
        expect(clearedRow?.emailError).toBe("smtp: connection refused (1015)");
      },
    );
  },
);
