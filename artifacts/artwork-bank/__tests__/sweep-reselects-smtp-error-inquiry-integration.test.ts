/**
 * sweepUnsentInquiryEmails — re-selects SMTP-error inquiries after owner retry
 * — real-DB integration (Task #940).
 *
 * Closes the end-to-end retry loop for the SMTP-error bucket:
 *
 *  1. Inquiries are exhausted: emailAttempts = MAX_EMAIL_ATTEMPTS, emailError is
 *     a genuine SMTP error string (not the NO_CONTACT_EMAIL_ERROR sentinel),
 *     emailLastAttemptAt is set.  The sweep candidate WHERE clause excludes them
 *     because emailAttempts ≥ MAX_EMAIL_ATTEMPTS.
 *
 *  2. The gallery owner calls retryFailedInquiryNotifications (settings/actions.ts),
 *     which delegates to retrySmtpErrorInquiries.  That function resets
 *     emailAttempts → 0 and emailLastAttemptAt → null while leaving emailError
 *     non-null.
 *
 *  3. sweepUnsentInquiryEmails runs scoped to the test tenant.  It must:
 *     a. Select the reset rows (scanned ≥ 1).
 *     b. Increment emailAttempts from 0 → 1.
 *     c. Set emailLastAttemptAt to a non-null Date, proving an attempt happened.
 *
 * Assertions deliberately avoid assuming a successful send — both the "sent"
 * and "failed" paths increment emailAttempts and set emailLastAttemptAt, so
 * either outcome confirms re-selection.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  inquiriesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Module mocks (must be declared before any imports from the mocked modules) ──

// Session mock — will be updated per-test to supply the correct tenantId.
const mockSession = {
  userId: "u-940",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test-940",
}));

// redirect() throws a recognisable error so we can assert on the URL without
// the full Next.js runtime.
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// Intercept sendArtworkInquiry so no live SMTP/Resend call is made.
// Default: returns true (successful send).
const sendArtworkInquiry = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...actual,
    sendArtworkInquiry,
    sendOrderConfirmation: vi.fn(async () => {}),
    sendOrderStatusUpdate: vi.fn(async () => {}),
    sendConfirmationFailureNotice: vi.fn(async () => {}),
  };
});

// getTenantUrl is called inside sweepUnsentInquiryEmails to build the artwork
// URL included in the notification email.
vi.mock("@/lib/base-url", () => ({
  getTenantUrl: (_tenant: unknown, path = "") =>
    `https://gallery.test${path}`,
}));

// ── Imports after mocks ────────────────────────────────────────────────────────

import { retryFailedInquiryNotifications } from "@/app/(admin)/settings/actions";
import {
  sweepUnsentInquiryEmails,
  MAX_EMAIL_ATTEMPTS,
  NO_CONTACT_EMAIL_ERROR,
} from "@/lib/email-sweep";

// ── DB-row trackers for cleanup ────────────────────────────────────────────────

const RUN = randomUUID().slice(0, 8);
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdInquiryIds: string[] = [];

function uid(label: string) {
  return `test-940-${RUN}-${++seq}-${label}`;
}

/**
 * Create a tenant pre-configured with a contact email so the sweep's delivery
 * path can proceed all the way to sendArtworkInquiry.
 */
async function createTenant(contactEmail = "gallery@smtp-retry-940.test") {
  const id = uid("tenant");
  createdTenantIds.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "SMTP Retry Test Gallery 940",
    type: "ARTIST",
    contactEmail,
    billingExempt: true,
    subscriptionStatus: null,
  } as any);
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid("artwork");
  createdArtworkIds.push(id);
  // Use the full uid (which includes the monotonically-incrementing seq) so
  // two artworks created for the same tenant never share a SKU, even when
  // both ids have the same label suffix.
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "SMTP Retry Test Artwork 940",
    sku: `sku-${id}`,
    status: "AVAILABLE",
    showInGallery: true,
  } as any);
  return id;
}

/**
 * Insert an inquiry whose SMTP send has been exhausted with a genuine SMTP
 * error — NOT the NO_CONTACT_EMAIL_ERROR sentinel.  emailAttempts is set to
 * MAX_EMAIL_ATTEMPTS so the row is currently excluded from the sweep candidate
 * set.
 */
async function createExhaustedSmtpErrorInquiry(
  tenantId: string,
  artworkId: string,
  smtpError = "550 mailbox not found",
) {
  const id = uid("inquiry");
  createdInquiryIds.push(id);
  await db.insert(inquiriesTable).values({
    id,
    tenantId,
    artworkId,
    artworkTitle: "SMTP Retry Test Artwork 940",
    buyerName: "Test Buyer 940",
    buyerEmail: `buyer-${id}@example.com`,
    message: "Is this available?",
    emailError: smtpError,
    emailAttempts: MAX_EMAIL_ATTEMPTS,
    emailLastAttemptAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 h ago
  } as any);
  return id;
}

async function inquiryRow(id: string) {
  return db.query.inquiriesTable.findFirst({
    where: eq(inquiriesTable.id, id),
  });
}

async function cleanup() {
  for (const id of createdInquiryIds.splice(0)) {
    await db
      .delete(inquiriesTable)
      .where(eq(inquiriesTable.id, id))
      .catch(() => {});
  }
  for (const id of createdArtworkIds.splice(0)) {
    await db
      .delete(artworksTable)
      .where(eq(artworksTable.id, id))
      .catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db
      .delete(tenantsTable)
      .where(eq(tenantsTable.id, id))
      .catch(() => {});
  }
}

afterEach(async () => {
  sendArtworkInquiry.mockReset();
  sendArtworkInquiry.mockResolvedValue(true);
  await cleanup();
});
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration(
  "sweepUnsentInquiryEmails — re-selects SMTP-error inquiries after owner retry — real-DB",
  () => {
    it(
      "exhausted SMTP-error inquiry is NOT re-selected before the owner retry action",
      async () => {
        // Control case: the row is at MAX_EMAIL_ATTEMPTS so the sweep must
        // exclude it entirely, even when a contact email is present.
        const tenantId = await createTenant();
        const artworkId = await createArtwork(tenantId);
        await createExhaustedSmtpErrorInquiry(tenantId, artworkId);

        const result = await sweepUnsentInquiryEmails(new Date(), tenantId);

        expect(result.scanned).toBe(0);
        expect(sendArtworkInquiry).not.toHaveBeenCalled();
      },
      20_000,
    );

    it(
      "sweep re-selects row after owner retry: emailAttempts increments and emailLastAttemptAt is set",
      async () => {
        // ── Arrange ──────────────────────────────────────────────────────────
        const tenantId = await createTenant();
        const artworkId = await createArtwork(tenantId);
        const inquiryId = await createExhaustedSmtpErrorInquiry(
          tenantId,
          artworkId,
          "SMTP connection refused",
        );

        // Confirm baseline: row is exhausted and sweep excludes it.
        const before = await inquiryRow(inquiryId);
        expect(before?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
        expect(before?.emailError).toBe("SMTP connection refused");

        const preFlight = await sweepUnsentInquiryEmails(new Date(), tenantId);
        expect(preFlight.scanned).toBe(0);

        // ── Act — step 1: owner calls retryFailedInquiryNotifications ────────
        mockSession.tenantId = tenantId;
        mockSession.role = "owner";

        // The action always terminates with redirect(), which throws in the mock.
        const redirectError = await retryFailedInquiryNotifications().catch(
          (e) => e,
        );
        expect(redirectError).toBeInstanceOf(Error);
        // The redirect count must be 1 — exactly our seeded row.
        expect(redirectError.message).toBe("REDIRECT:/settings?retry_result=1");

        // ── Verify reset state ────────────────────────────────────────────────
        const afterReset = await inquiryRow(inquiryId);
        // emailAttempts → 0 re-enters the sweep candidate set.
        expect(afterReset?.emailAttempts).toBe(0);
        // emailLastAttemptAt → null removes any backoff delay.
        expect(afterReset?.emailLastAttemptAt).toBeNull();
        // emailError must remain non-null — the sweep's WHERE clause is
        // isNotNull(emailError).  Clearing it would silently drop the row.
        expect(afterReset?.emailError).toBe("SMTP connection refused");

        // ── Act — step 2: next sweep run ─────────────────────────────────────
        const sweepResult = await sweepUnsentInquiryEmails(new Date(), tenantId);

        // ── Assert — sweep selected and processed the re-queued row ───────────
        // scanned ≥ 1: the sweep found our reset row.
        expect(sweepResult.scanned).toBeGreaterThanOrEqual(1);

        const afterSweep = await inquiryRow(inquiryId);
        // emailAttempts must be 1 (incremented from 0).  Both the success and
        // failure paths increment it, so this holds regardless of transport outcome.
        expect(afterSweep?.emailAttempts).toBe(1);

        // emailLastAttemptAt must be set — the sweep reached the send stage.
        expect(afterSweep?.emailLastAttemptAt).toBeInstanceOf(Date);

        // sendArtworkInquiry must have been called exactly once — no double send.
        expect(sendArtworkInquiry).toHaveBeenCalledOnce();

        // On successful delivery, emailError is cleared.
        expect(afterSweep?.emailError).toBeNull();
      },
      20_000,
    );

    it(
      "sweep re-selects row even when email transport fails after owner retry: emailAttempts still increments",
      async () => {
        // Same owner-retry flow but the transport throws on this sweep run.
        // We want to confirm re-selection (emailAttempts increments) even when
        // delivery fails.
        const tenantId = await createTenant();
        const artworkId = await createArtwork(tenantId);
        const inquiryId = await createExhaustedSmtpErrorInquiry(
          tenantId,
          artworkId,
          "550 mailbox not found",
        );

        mockSession.tenantId = tenantId;
        mockSession.role = "owner";

        // Owner resets the row.
        const redirectError = await retryFailedInquiryNotifications().catch(
          (e) => e,
        );
        expect(redirectError.message).toBe("REDIRECT:/settings?retry_result=1");

        const afterReset = await inquiryRow(inquiryId);
        expect(afterReset?.emailAttempts).toBe(0);
        expect(afterReset?.emailLastAttemptAt).toBeNull();

        // Simulate a transient transport failure on this sweep run.
        sendArtworkInquiry.mockRejectedValueOnce(new Error("SMTP timeout"));

        const sweepResult = await sweepUnsentInquiryEmails(new Date(), tenantId);

        // Sweep must have selected the row (scanned ≥ 1, failed ≥ 1).
        expect(sweepResult.scanned).toBeGreaterThanOrEqual(1);
        expect(sweepResult.failed).toBeGreaterThanOrEqual(1);

        const afterSweep = await inquiryRow(inquiryId);
        // emailAttempts must increment even on failure.
        expect(afterSweep?.emailAttempts).toBe(1);

        // emailLastAttemptAt must be set — the sweep reached the send stage.
        expect(afterSweep?.emailLastAttemptAt).toBeInstanceOf(Date);

        // emailError must still be non-null so the row stays eligible for the
        // next retry cycle.
        expect(afterSweep?.emailError).not.toBeNull();
        expect(afterSweep?.emailError).toMatch(/SMTP timeout/);
      },
      20_000,
    );

    it(
      "owner retry resets multiple SMTP-error inquiries and sweep re-selects all of them",
      async () => {
        // Verify the sweep's candidate query does not inadvertently limit to
        // only the first reset row when multiple exist.
        const tenantId = await createTenant();
        const artworkId1 = await createArtwork(tenantId);
        const artworkId2 = await createArtwork(tenantId);
        const inquiryId1 = await createExhaustedSmtpErrorInquiry(
          tenantId,
          artworkId1,
          "SMTP connection refused",
        );
        const inquiryId2 = await createExhaustedSmtpErrorInquiry(
          tenantId,
          artworkId2,
          "550 mailbox not found",
        );

        mockSession.tenantId = tenantId;
        mockSession.role = "owner";

        const redirectError = await retryFailedInquiryNotifications().catch(
          (e) => e,
        );
        // Both rows reset.
        expect(redirectError.message).toBe("REDIRECT:/settings?retry_result=2");

        // Both rows must now be at emailAttempts = 0.
        const reset1 = await inquiryRow(inquiryId1);
        const reset2 = await inquiryRow(inquiryId2);
        expect(reset1?.emailAttempts).toBe(0);
        expect(reset2?.emailAttempts).toBe(0);

        // Run the sweep scoped to this tenant.
        const sweepResult = await sweepUnsentInquiryEmails(new Date(), tenantId);

        // Both rows must be scanned.
        expect(sweepResult.scanned).toBeGreaterThanOrEqual(2);

        // Both rows must have been processed (emailAttempts = 1 each).
        const after1 = await inquiryRow(inquiryId1);
        const after2 = await inquiryRow(inquiryId2);
        expect(after1?.emailAttempts).toBe(1);
        expect(after2?.emailAttempts).toBe(1);
        expect(after1?.emailLastAttemptAt).toBeInstanceOf(Date);
        expect(after2?.emailLastAttemptAt).toBeInstanceOf(Date);

        // sendArtworkInquiry called exactly once per row.
        expect(sendArtworkInquiry).toHaveBeenCalledTimes(2);
      },
      20_000,
    );

    it(
      "exhausted no-contact inquiry IS reset by owner retry and re-selected by the sweep",
      async () => {
        // requeueExhaustedInquiries resets ALL exhausted rows whose emailError is
        // non-null (emailAttempts >= MAX, archivedAt IS NULL) — including rows
        // with the NO_CONTACT_EMAIL_ERROR sentinel.  This matches the predicate
        // used by getEmailFailCount so the redirect count equals the banner count.
        //
        // After the reset (emailAttempts=0, emailLastAttemptAt=null) the sweep
        // re-selects the row, finds the tenant has a contact email, and attempts
        // delivery — exactly the same flow as a genuine SMTP-error retry.
        const tenantId = await createTenant(); // creates tenant WITH contactEmail
        const artworkId = await createArtwork(tenantId);
        const noContactId = uid("inquiry-nc");
        createdInquiryIds.push(noContactId);
        await db.insert(inquiriesTable).values({
          id: noContactId,
          tenantId,
          artworkId,
          artworkTitle: "SMTP Retry Test Artwork 940",
          buyerName: "Test Buyer NC",
          buyerEmail: `buyer-nc@example.com`,
          message: "Is this available?",
          emailError: NO_CONTACT_EMAIL_ERROR,
          emailAttempts: MAX_EMAIL_ATTEMPTS,
          emailLastAttemptAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        } as any);

        mockSession.tenantId = tenantId;
        mockSession.role = "owner";

        // retryFailedInquiryNotifications counts and resets the exhausted
        // no-contact row (same predicate as getEmailFailCount).
        const redirectError = await retryFailedInquiryNotifications().catch(
          (e) => e,
        );
        expect(redirectError.message).toBe("REDIRECT:/settings?retry_result=1");

        // Row is now reset — re-enters the sweep candidate set.
        const noContactAfter = await inquiryRow(noContactId);
        expect(noContactAfter?.emailAttempts).toBe(0);
        expect(noContactAfter?.emailLastAttemptAt).toBeNull();
        expect(noContactAfter?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);

        // The sweep re-selects the reset row and attempts delivery.
        // The tenant has a contactEmail so the sweep proceeds to sendArtworkInquiry.
        const sweepResult = await sweepUnsentInquiryEmails(new Date(), tenantId);
        expect(sweepResult.scanned).toBeGreaterThanOrEqual(1);
        expect(sendArtworkInquiry).toHaveBeenCalledOnce();
      },
      20_000,
    );
  },
);
