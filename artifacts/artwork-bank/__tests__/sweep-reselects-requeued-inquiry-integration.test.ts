/**
 * sweepUnsentInquiryEmails — re-selects requeued inquiry — real-DB integration.
 *
 * Closes the end-to-end retry loop:
 *
 *  Task 904 confirmed that requeueNoContactEmailInquiries leaves emailError
 *  intact (non-null) after resetting emailAttempts → 0.  This test confirms
 *  the complementary side: sweepUnsentInquiryEmails actually picks the
 *  requeued row up on its next run and makes a delivery attempt.
 *
 * Scenario:
 *  1. An inquiry is exhausted: emailAttempts = MAX_EMAIL_ATTEMPTS,
 *     emailError = NO_CONTACT_EMAIL_ERROR, emailLastAttemptAt is set.
 *  2. The gallery owner adds a contact email and requeueNoContactEmailInquiries
 *     is called.  The row is now at emailAttempts=0, emailLastAttemptAt=null,
 *     emailError still non-null — exactly the state the sweep candidate WHERE
 *     clause requires.
 *  3. sweepUnsentInquiryEmails runs scoped to the test tenant.  It must:
 *     a. Select the requeued row (scanned ≥ 1).
 *     b. Increment emailAttempts from 0 → 1.
 *     c. Set emailLastAttemptAt to a non-null Date, proving an attempt happened.
 *
 * Assertions deliberately avoid assuming a successful send (the email mock
 * returns true, but what matters is the sweep *selected* the row — not
 * whether the transport succeeded).  Both the "sent" and "failed" paths
 * increment emailAttempts and set emailLastAttemptAt, so either outcome
 * confirms re-selection.
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
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Module mocks (must be declared before any imports from the mocked modules) ──

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
// URL included in the notification email.  Return a stable fake URL so tests
// don't depend on the real domain-resolution logic.
vi.mock("@/lib/base-url", () => ({
  getTenantUrl: (_tenant: unknown, path = "") =>
    `https://gallery.test${path}`,
}));

// ── Imports after mocks ────────────────────────────────────────────────────────

import {
  sweepUnsentInquiryEmails,
  requeueNoContactEmailInquiries,
  MAX_EMAIL_ATTEMPTS,
  NO_CONTACT_EMAIL_ERROR,
} from "@/lib/email-sweep";

// ── DB-row trackers for cleanup ────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdInquiryIds: string[] = [];

function uid() {
  return `${randomUUID()}-srri-${RUN}-${++seq}`;
}

/**
 * Create a tenant.  Pass `contactEmail` to pre-configure the gallery address
 * the sweep needs to route the notification.
 */
async function createTenant(contactEmail: string | null = null) {
  const id = uid();
  const userId = uid();
  await db
    .insert(usersTable)
    .values({ id: userId, email: `u-${userId}@test.com`, passwordHash: "x" } as any);
  createdUserIds.push(userId);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Reselect Requeued Inquiry Test Gallery",
    type: "ARTIST",
    contactEmail,
  } as any);
  createdTenantIds.push(id);
  await db
    .insert(tenantUsersTable)
    .values({ tenantId: id, userId, role: "owner" } as any);
  return { tenantId: id, userId };
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Reselect Test Artwork",
    sku: `sku-${id}`,
    status: "AVAILABLE",
    showInGallery: true,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

/**
 * Insert an exhausted no-contact-email inquiry — mirrors the state produced
 * by MAX_EMAIL_ATTEMPTS worth of sweep runs on a gallery without a contact
 * address.
 */
async function createExhaustedNoEmailInquiry(tenantId: string, artworkId: string) {
  const id = uid();
  await db.insert(inquiriesTable).values({
    id,
    tenantId,
    artworkId,
    artworkTitle: "Reselect Test Artwork",
    buyerName: "Interested Buyer",
    buyerEmail: `buyer-${id}@test.com`,
    message: "Is this available?",
    emailError: NO_CONTACT_EMAIL_ERROR,
    emailAttempts: MAX_EMAIL_ATTEMPTS,
    emailLastAttemptAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 hours ago
  } as any);
  createdInquiryIds.push(id);
  return id;
}

async function inquiryRow(id: string) {
  return db.query.inquiriesTable.findFirst({
    where: eq(inquiriesTable.id, id),
  });
}

async function cleanup() {
  for (const id of createdInquiryIds.splice(0)) {
    await db.delete(inquiriesTable).where(eq(inquiriesTable.id, id)).catch(() => {});
  }
  for (const id of createdArtworkIds.splice(0)) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db
      .delete(tenantUsersTable)
      .where(eq(tenantUsersTable.tenantId, id))
      .catch(() => {});
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
  for (const id of createdUserIds.splice(0)) {
    await db.delete(usersTable).where(eq(usersTable.id, id)).catch(() => {});
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
  "sweepUnsentInquiryEmails — re-selects requeued inquiry — real-DB integration",
  () => {
    it(
      "sweep re-selects the requeued row: emailAttempts increments and emailLastAttemptAt is set",
      async () => {
        // ── Arrange ──────────────────────────────────────────────────────────
        // Tenant starts WITHOUT a contact email — mirroring the original
        // broken state that caused the inquiry to exhaust its attempts.
        const { tenantId } = await createTenant(null);
        const artworkId = await createArtwork(tenantId);
        const inquiryId = await createExhaustedNoEmailInquiry(tenantId, artworkId);

        // Confirm the row starts in the fully-exhausted state that the sweep
        // candidate query (emailAttempts < MAX_EMAIL_ATTEMPTS) excludes.
        const before = await inquiryRow(inquiryId);
        expect(before?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
        expect(before?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);

        // Pre-flight: sweep with no contactEmail must not select the row
        // (it is exhausted at MAX_EMAIL_ATTEMPTS).
        const preFlight = await sweepUnsentInquiryEmails(new Date(), tenantId);
        expect(preFlight.scanned).toBe(0);

        // ── Act — step 1: gallery owner adds a contact email and requeues ──
        // Update the tenant so the sweep can deliver on the next run.
        await db
          .update(tenantsTable)
          .set({ contactEmail: "gallery@test.com" } as any)
          .where(eq(tenantsTable.id, tenantId));

        // requeueNoContactEmailInquiries resets emailAttempts → 0 and
        // emailLastAttemptAt → null while keeping emailError non-null.
        await requeueNoContactEmailInquiries(tenantId);

        const afterRequeue = await inquiryRow(inquiryId);
        // Requeue must have reset both fields so the sweep can select the row.
        expect(afterRequeue?.emailAttempts).toBe(0);
        expect(afterRequeue?.emailLastAttemptAt).toBeNull();
        // emailError must still be non-null — the sweep's WHERE clause is
        // isNotNull(emailError).  Nulling it would silently drop the row.
        expect(afterRequeue?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);

        // ── Act — step 2: next sweep run ──────────────────────────────────
        const sweepResult = await sweepUnsentInquiryEmails(new Date(), tenantId);

        // ── Assert — sweep selected and processed the requeued row ──────────
        // scanned must be at least 1: the sweep found our requeued row.
        expect(sweepResult.scanned).toBeGreaterThanOrEqual(1);

        // The row must now have emailAttempts = 1 (incremented from 0).
        // Both the success and failure paths increment emailAttempts, so this
        // assertion holds regardless of which transport branch ran.
        const afterSweep = await inquiryRow(inquiryId);
        expect(afterSweep?.emailAttempts).toBe(1);

        // emailLastAttemptAt must be set to a Date — proof the sweep did not
        // skip the row (e.g. due to backoff) but actually touched it.
        expect(afterSweep?.emailLastAttemptAt).toBeInstanceOf(Date);

        // sendArtworkInquiry must have been called exactly once: no duplicate
        // sends, no silent skip.
        expect(sendArtworkInquiry).toHaveBeenCalledOnce();

        // On successful delivery, emailError is cleared.
        expect(afterSweep?.emailError).toBeNull();
      },
    );

    it(
      "sweep re-selects requeued row even when the email transport fails: emailAttempts still increments",
      async () => {
        // Same flow as above but the email send throws — we want to confirm
        // that the sweep *selected* the row (evidenced by emailAttempts
        // incrementing) even when delivery fails.
        const { tenantId } = await createTenant("gallery@test.com");
        const artworkId = await createArtwork(tenantId);
        const inquiryId = await createExhaustedNoEmailInquiry(tenantId, artworkId);

        // Requeue (simulate gallery having contactEmail before this call —
        // tenant was created with contactEmail above).
        await requeueNoContactEmailInquiries(tenantId);

        const afterRequeue = await inquiryRow(inquiryId);
        expect(afterRequeue?.emailAttempts).toBe(0);
        expect(afterRequeue?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);

        // Simulate a transient transport error on this run.
        sendArtworkInquiry.mockRejectedValueOnce(new Error("SMTP timeout"));

        const sweepResult = await sweepUnsentInquiryEmails(new Date(), tenantId);

        // The sweep must have selected the row (scanned=1, failed=1).
        expect(sweepResult.scanned).toBeGreaterThanOrEqual(1);
        expect(sweepResult.failed).toBeGreaterThanOrEqual(1);

        // emailAttempts must be incremented even on failure.
        const afterSweep = await inquiryRow(inquiryId);
        expect(afterSweep?.emailAttempts).toBe(1);

        // emailLastAttemptAt must be set — the sweep reached the send stage.
        expect(afterSweep?.emailLastAttemptAt).toBeInstanceOf(Date);

        // emailError must still be set (non-null) so the row stays eligible
        // for the next retry cycle.
        expect(afterSweep?.emailError).not.toBeNull();
        expect(afterSweep?.emailError).toMatch(/SMTP timeout/);
      },
    );

    it(
      "exhausted no-email inquiry is NOT re-selected before requeue (sweep sees scanned=0)",
      async () => {
        // Control case: without calling requeueNoContactEmailInquiries the
        // row remains at MAX_EMAIL_ATTEMPTS and the sweep query must exclude it.
        const { tenantId } = await createTenant("gallery@test.com");
        const artworkId = await createArtwork(tenantId);
        await createExhaustedNoEmailInquiry(tenantId, artworkId);

        const sweepResult = await sweepUnsentInquiryEmails(new Date(), tenantId);

        expect(sweepResult.scanned).toBe(0);
        expect(sendArtworkInquiry).not.toHaveBeenCalled();
      },
    );
  },
);
