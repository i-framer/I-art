/**
 * sweepUnsentInquiryEmails — real-DB integration.
 *
 * Every sweep call is scoped to the test's own tenant ID, so no other rows in
 * the shared dev database are touched or mutated.
 *
 * Verifies against a live PostgreSQL database that:
 *  1. Successful retry clears emailError and increments emailAttempts.
 *  2. Failed retry (throw) records the error and increments emailAttempts.
 *  3. Failed retry (false return) records the error and increments emailAttempts.
 *  4. Inquiry at MAX_EMAIL_ATTEMPTS is not selected — row stays untouched.
 *  5. Backoff window skips an inquiry whose last attempt was too recent.
 *  6. Inquiry is re-selected once the backoff window has passed.
 *  7. Atomic CAS claim prevents a second concurrent sweep from double-sending.
 *  8. Inquiry with no tenant contactEmail records a distinct error and bumps attempts so it is not retried forever.
 *  9. Missing artwork causes the sweep to skip without touching the row.
 * 10. Cross-tenant artwork mismatch writes a terminal state so the row is never re-selected.
 * 11. No-email inquiry is not re-selected once it reaches MAX_EMAIL_ATTEMPTS.
 * 11a. No-email inquiry is permanently excluded: second sweep run finds scanned=0 after first bump reaches MAX.
 * 12. requeueNoContactEmailInquiries resets exhausted rows → sweep delivers on next run.
 * 13. Requeue at MAX-1 (near-exhaustion interleave) still lets the sweep deliver.
 * 14. After an email-A → email-B change, the sweep does NOT re-select exhausted
 *     SMTP-error inquiries — their emailAttempts, emailError, and
 *     emailLastAttemptAt remain completely unchanged.
 * 15. retrySmtpErrorInquiries resets exhausted SMTP-error rows (but not the
 *     "no gallery contact email" sentinel rows) so the sweep delivers them on
 *     the next run.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  inquiriesTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Controlled sendArtworkInquiry mock — succeeds by default ──────────────────
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

vi.mock("@/lib/base-url", () => ({
  getTenantUrl: (_tenant: any, path = "") => `https://example.com${path}`,
}));

import {
  sweepUnsentInquiryEmails,
  requeueNoContactEmailInquiries,
  retrySmtpErrorInquiries,
  MAX_EMAIL_ATTEMPTS,
  BASE_BACKOFF_MS,
} from "@/lib/email-sweep";

// ── DB-row trackers for cleanup ───────────────────────────────────────────────
const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdInquiryIds: string[] = [];

function uid() {
  return `${randomUUID()}-ieswp-${RUN}-${++seq}`;
}

async function createTenant(contactEmail = "gallery@test.com") {
  const id = uid();
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Inquiry Sweep Test Gallery",
    type: "ARTIST",
    contactEmail,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Inquiry Sweep Artwork",
    sku: `sku-${id}`,
    status: "AVAILABLE",
    showInGallery: true,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

/**
 * Insert an inquiry that already has a failed first send attempt so it is
 * eligible for the sweep (emailError IS NOT NULL, emailAttempts < MAX).
 */
async function createFailedInquiry(
  tenantId: string,
  artworkId: string,
  opts: {
    emailAttempts?: number;
    emailLastAttemptAt?: Date | null;
    emailError?: string;
  } = {},
) {
  const id = uid();
  await db.insert(inquiriesTable).values({
    id,
    tenantId,
    artworkId,
    artworkTitle: "Inquiry Sweep Artwork",
    buyerName: "Test Buyer",
    buyerEmail: `buyer-${id}@test.com`,
    message: "Is this available?",
    emailError: opts.emailError ?? "smtp timeout",
    emailAttempts: opts.emailAttempts ?? 1,
    emailLastAttemptAt:
      opts.emailLastAttemptAt !== undefined ? opts.emailLastAttemptAt : null,
  } as any);
  createdInquiryIds.push(id);
  return id;
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
  "sweepUnsentInquiryEmails — real-DB integration",
  () => {
    it("successful retry clears emailError and increments emailAttempts", async () => {
      const tenantId = await createTenant();
      const artworkId = await createArtwork(tenantId);
      const inquiryId = await createFailedInquiry(tenantId, artworkId, {
        emailAttempts: 1,
      });

      sendArtworkInquiry.mockResolvedValueOnce(true);
      const result = await sweepUnsentInquiryEmails(new Date(), tenantId);

      // Scoped to this tenant — exactly one inquiry was eligible.
      expect(result).toEqual({ scanned: 1, sent: 1, failed: 0, skipped: 0 });

      const row = await db.query.inquiriesTable.findFirst({
        where: eq(inquiriesTable.id, inquiryId),
      });
      expect(row?.emailError).toBeNull();
      expect(row?.emailAttempts).toBe(2);
      expect(row?.emailLastAttemptAt).toBeInstanceOf(Date);
    });

    it("failed retry (throw) records error, increments attempts, retains emailError", async () => {
      const tenantId = await createTenant();
      const artworkId = await createArtwork(tenantId);
      const inquiryId = await createFailedInquiry(tenantId, artworkId, {
        emailAttempts: 1,
      });

      sendArtworkInquiry.mockRejectedValueOnce(
        new Error("SMTP connection refused"),
      );
      const result = await sweepUnsentInquiryEmails(new Date(), tenantId);

      expect(result).toEqual({ scanned: 1, sent: 0, failed: 1, skipped: 0 });

      const row = await db.query.inquiriesTable.findFirst({
        where: eq(inquiriesTable.id, inquiryId),
      });
      // emailError must still be set so the inquiry stays re-selectable.
      expect(row?.emailError).toMatch(/SMTP connection refused/);
      expect(row?.emailAttempts).toBe(2);
      expect(row?.emailLastAttemptAt).toBeInstanceOf(Date);
    });

    it("failed retry (false return) records error and increments attempts", async () => {
      const tenantId = await createTenant();
      const artworkId = await createArtwork(tenantId);
      const inquiryId = await createFailedInquiry(tenantId, artworkId, {
        emailAttempts: 1,
      });

      sendArtworkInquiry.mockResolvedValueOnce(false);
      const result = await sweepUnsentInquiryEmails(new Date(), tenantId);

      expect(result).toEqual({ scanned: 1, sent: 0, failed: 1, skipped: 0 });

      const row = await db.query.inquiriesTable.findFirst({
        where: eq(inquiriesTable.id, inquiryId),
      });
      expect(row?.emailError).toBeTruthy();
      expect(row?.emailAttempts).toBe(2);
    });

    it("inquiry at MAX_EMAIL_ATTEMPTS is not selected by the sweep", async () => {
      const tenantId = await createTenant();
      const artworkId = await createArtwork(tenantId);
      const inquiryId = await createFailedInquiry(tenantId, artworkId, {
        emailAttempts: MAX_EMAIL_ATTEMPTS, // already exhausted
      });

      const result = await sweepUnsentInquiryEmails(new Date(), tenantId);

      // Scoped to this tenant — exhausted row is filtered out by the query.
      expect(result).toEqual({ scanned: 0, sent: 0, failed: 0, skipped: 0 });

      const row = await db.query.inquiriesTable.findFirst({
        where: eq(inquiriesTable.id, inquiryId),
      });
      // Row must be completely untouched.
      expect(row?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
      expect(row?.emailError).not.toBeNull();
    });

    it("backoff window causes the inquiry to be skipped on the next immediate sweep", async () => {
      // emailAttempts=1 → backoff = BASE_BACKOFF_MS * 2^0 = 5 min.
      // Setting emailLastAttemptAt to right now places us deep inside the window.
      const tenantId = await createTenant();
      const artworkId = await createArtwork(tenantId);
      const inquiryId = await createFailedInquiry(tenantId, artworkId, {
        emailAttempts: 1,
        emailLastAttemptAt: new Date(), // just attempted — inside 5-min backoff
      });

      const result = await sweepUnsentInquiryEmails(new Date(), tenantId);

      expect(result).toEqual({ scanned: 1, sent: 0, failed: 0, skipped: 1 });

      // Backoff skip is read-only — attempts and error unchanged.
      const row = await db.query.inquiriesTable.findFirst({
        where: eq(inquiriesTable.id, inquiryId),
      });
      expect(row?.emailAttempts).toBe(1);
    });

    it("inquiry is re-selected once the backoff window has passed", async () => {
      // emailAttempts=1 → backoff = 5 min.  Last attempt was >10 min ago → eligible.
      const tenantId = await createTenant();
      const artworkId = await createArtwork(tenantId);
      const longAgo = new Date(Date.now() - BASE_BACKOFF_MS * 2); // well outside window
      const inquiryId = await createFailedInquiry(tenantId, artworkId, {
        emailAttempts: 1,
        emailLastAttemptAt: longAgo,
      });

      sendArtworkInquiry.mockResolvedValueOnce(true);
      const result = await sweepUnsentInquiryEmails(new Date(), tenantId);

      expect(result).toEqual({ scanned: 1, sent: 1, failed: 0, skipped: 0 });

      const row = await db.query.inquiriesTable.findFirst({
        where: eq(inquiriesTable.id, inquiryId),
      });
      expect(row?.emailError).toBeNull();
      expect(row?.emailAttempts).toBe(2);
    });

    it("atomic CAS claim prevents a second concurrent sweep from double-sending", async () => {
      // One inquiry in the DB; two sweep invocations with the same `now` timestamp
      // and the same tenant scope. The first to commit its CAS UPDATE wins; the
      // second finds a different emailLastAttemptAt in the DB and is skipped.
      const tenantId = await createTenant();
      const artworkId = await createArtwork(tenantId);
      const inquiryId = await createFailedInquiry(tenantId, artworkId, {
        emailAttempts: 1,
        emailLastAttemptAt: null,
      });

      sendArtworkInquiry.mockResolvedValue(true);

      const now = new Date();
      const [r1, r2] = await Promise.all([
        sweepUnsentInquiryEmails(now, tenantId),
        sweepUnsentInquiryEmails(now, tenantId),
      ]);

      // Combined: one sweep sent, the other skipped — exactly one email delivered.
      expect(r1.sent + r2.sent).toBe(1);
      expect(r1.skipped + r2.skipped).toBe(1);
      expect(sendArtworkInquiry).toHaveBeenCalledTimes(1);

      // DB row must show attempts incremented exactly once.
      const row = await db.query.inquiriesTable.findFirst({
        where: eq(inquiriesTable.id, inquiryId),
      });
      expect(row?.emailAttempts).toBe(2);
      expect(row?.emailError).toBeNull();
    });

    it("inquiry with no tenant contactEmail records a distinct error and bumps attempts", async () => {
      // Tenant has a blank contactEmail — the sweep must not leave the row
      // completely untouched (which would cause it to be scanned indefinitely).
      // Instead it writes emailError="no gallery contact email", increments
      // emailAttempts, and sets emailLastAttemptAt so back-off applies.
      const tenantId = await createTenant(""); // blank contactEmail
      const artworkId = await createArtwork(tenantId);
      const inquiryId = await createFailedInquiry(tenantId, artworkId, {
        emailAttempts: 1,
      });

      const now = new Date();
      const result = await sweepUnsentInquiryEmails(now, tenantId);

      expect(result).toEqual({ scanned: 1, sent: 0, failed: 0, skipped: 1 });
      expect(sendArtworkInquiry).not.toHaveBeenCalled();

      // Row must be updated with the distinct error so back-off applies and
      // the inquiry is not scanned on every sweep run forever.
      const row = await db.query.inquiriesTable.findFirst({
        where: eq(inquiriesTable.id, inquiryId),
      });
      expect(row?.emailAttempts).toBe(2);
      expect(row?.emailError).toBe("no gallery contact email");
      expect(row?.emailLastAttemptAt).toBeInstanceOf(Date);
    });

    it("no-email inquiry is not re-selected once it reaches MAX_EMAIL_ATTEMPTS", async () => {
      // When the inquiry has already been bumped to MAX_EMAIL_ATTEMPTS by
      // repeated no-contact-email skips it must fall out of the candidate set
      // entirely so the sweep never touches it again.
      const tenantId = await createTenant(""); // blank contactEmail
      const artworkId = await createArtwork(tenantId);
      await createFailedInquiry(tenantId, artworkId, {
        emailAttempts: MAX_EMAIL_ATTEMPTS,
        emailError: "no gallery contact email",
      });

      const result = await sweepUnsentInquiryEmails(new Date(), tenantId);

      expect(result).toEqual({ scanned: 0, sent: 0, failed: 0, skipped: 0 });
      expect(sendArtworkInquiry).not.toHaveBeenCalled();
    });

    it("no-email inquiry is permanently excluded: second sweep finds scanned=0 after first bump reaches MAX", async () => {
      // First sweep: inquiry is at MAX_EMAIL_ATTEMPTS-1 with no contactEmail
      // configured on the tenant.  The sweep bumps emailAttempts to MAX and
      // writes "no gallery contact email" — the row is now at the terminal
      // threshold.  Second sweep: the candidate query excludes rows at MAX so
      // scanned must be 0 and the row must remain untouched.
      const tenantId = await createTenant(""); // blank contactEmail throughout
      const artworkId = await createArtwork(tenantId);
      const inquiryId = await createFailedInquiry(tenantId, artworkId, {
        emailAttempts: MAX_EMAIL_ATTEMPTS - 1,
        emailError: "no gallery contact email",
        emailLastAttemptAt: null,
      });

      // First sweep — no contactEmail → bumps emailAttempts to MAX.
      const result1 = await sweepUnsentInquiryEmails(new Date(), tenantId);
      expect(result1).toEqual({ scanned: 1, sent: 0, failed: 0, skipped: 1 });
      expect(sendArtworkInquiry).not.toHaveBeenCalled();

      const afterFirst = await db.query.inquiriesTable.findFirst({
        where: eq(inquiriesTable.id, inquiryId),
      });
      expect(afterFirst?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
      expect(afterFirst?.emailError).toBe("no gallery contact email");

      // Second sweep — row is at MAX_EMAIL_ATTEMPTS so the candidate query
      // must not select it at all.
      sendArtworkInquiry.mockClear();
      const result2 = await sweepUnsentInquiryEmails(new Date(), tenantId);

      expect(result2).toEqual({ scanned: 0, sent: 0, failed: 0, skipped: 0 });
      expect(sendArtworkInquiry).not.toHaveBeenCalled();

      // Row must remain at the terminal state written by the first sweep.
      const afterSecond = await db.query.inquiriesTable.findFirst({
        where: eq(inquiriesTable.id, inquiryId),
      });
      expect(afterSecond?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
      expect(afterSecond?.emailError).toBe("no gallery contact email");
    });

    it("missing artwork writes terminal state so the inquiry is never retried", async () => {
      // Use a real valid inquiry (satisfies FK) but make the artwork lookup
      // return undefined via a spy — simulating an artwork that was deleted
      // after the inquiry was recorded.  The sweep must write emailAttempts=MAX
      // and emailError="artwork deleted" so the row is excluded from every
      // future scan.
      const tenantId = await createTenant();
      const artworkId = await createArtwork(tenantId);
      const inquiryId = await createFailedInquiry(tenantId, artworkId, {
        emailAttempts: 1,
        emailLastAttemptAt: null,
      });

      const artworkSpy = vi
        .spyOn(db.query.artworksTable, "findFirst")
        .mockResolvedValueOnce(undefined as any);

      let result: Awaited<ReturnType<typeof sweepUnsentInquiryEmails>>;
      try {
        result = await sweepUnsentInquiryEmails(new Date(), tenantId);
      } finally {
        artworkSpy.mockRestore();
      }

      // The sweep sees the inquiry (scanned=1) but skips it because the artwork
      // lookup returns nothing — no email is sent.
      expect(result!).toEqual({ scanned: 1, sent: 0, failed: 0, skipped: 1 });
      expect(sendArtworkInquiry).not.toHaveBeenCalled();

      // The inquiry row must be updated to the terminal state so that it is
      // excluded from all future sweeps.
      const row = await db.query.inquiriesTable.findFirst({
        where: eq(inquiriesTable.id, inquiryId),
      });
      expect(row?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
      expect(row?.emailError).toBe("artwork deleted");
      expect(row?.emailLastAttemptAt).toBeInstanceOf(Date);
    });

    it("cross-tenant artwork guard: inquiry is skipped and permanently marked so it is never re-scanned", async () => {
      // Simulate a cross-tenant data-integrity bug: the artwork exists in the DB
      // but its tenantId belongs to a *different* tenant than the inquiry.
      // The mismatch is permanent, so the sweep must write a terminal error
      // (emailAttempts = MAX_EMAIL_ATTEMPTS) rather than leaving the row
      // silently re-selectable forever.
      const inquiryTenantId = await createTenant("gallery-a@test.com");
      const artworkTenantId = await createTenant("gallery-b@test.com");

      // Artwork belongs to tenantB — mismatched with the inquiry's tenantA.
      const artworkId = uid();
      await db.insert(artworksTable).values({
        id: artworkId,
        tenantId: artworkTenantId,
        title: "Cross-Tenant Artwork",
        sku: `sku-${artworkId}`,
        status: "AVAILABLE",
        showInGallery: true,
      } as any);
      createdArtworkIds.push(artworkId);

      // Inquiry owned by tenantA but referencing the artworkB id.
      const inquiryId = uid();
      await db.insert(inquiriesTable).values({
        id: inquiryId,
        tenantId: inquiryTenantId,
        artworkId,
        artworkTitle: "Cross-Tenant Artwork",
        buyerName: "Test Buyer",
        buyerEmail: `buyer-${inquiryId}@test.com`,
        message: "Is this available?",
        emailError: "smtp timeout",
        emailAttempts: 1,
        emailLastAttemptAt: null,
      } as any);
      createdInquiryIds.push(inquiryId);

      // Sweep scoped to inquiryTenantId — it will find the inquiry, look up the
      // artwork, detect the tenantId mismatch, and write a terminal state.
      const result = await sweepUnsentInquiryEmails(new Date(), inquiryTenantId);

      expect(result).toEqual({ scanned: 1, sent: 0, failed: 0, skipped: 1 });
      expect(sendArtworkInquiry).not.toHaveBeenCalled();

      // The row must have been stamped with the terminal cross-tenant error so
      // it is excluded from every future scan (emailAttempts = MAX_EMAIL_ATTEMPTS).
      const row = await db.query.inquiriesTable.findFirst({
        where: eq(inquiriesTable.id, inquiryId),
      });
      expect(row?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
      expect(row?.emailError).toBe("cross-tenant artwork mismatch");
      expect(row?.emailLastAttemptAt).not.toBeNull();
    });

    it("cross-tenant artwork mismatch: inquiry is not re-selected on a subsequent sweep run", async () => {
      // First sweep: cross-tenant mismatch is detected → terminal state written.
      // Second sweep: the row is now at MAX_EMAIL_ATTEMPTS and must not appear
      // in the candidate set at all.
      const inquiryTenantId = await createTenant("gallery-a2@test.com");
      const artworkTenantId = await createTenant("gallery-b2@test.com");

      const artworkId = uid();
      await db.insert(artworksTable).values({
        id: artworkId,
        tenantId: artworkTenantId,
        title: "Cross-Tenant Artwork 2",
        sku: `sku-${artworkId}`,
        status: "AVAILABLE",
        showInGallery: true,
      } as any);
      createdArtworkIds.push(artworkId);

      const inquiryId = uid();
      await db.insert(inquiriesTable).values({
        id: inquiryId,
        tenantId: inquiryTenantId,
        artworkId,
        artworkTitle: "Cross-Tenant Artwork 2",
        buyerName: "Test Buyer",
        buyerEmail: `buyer-${inquiryId}@test.com`,
        message: "Is this available?",
        emailError: "smtp timeout",
        emailAttempts: 1,
        emailLastAttemptAt: null,
      } as any);
      createdInquiryIds.push(inquiryId);

      // First sweep — detects mismatch and writes terminal state.
      const result1 = await sweepUnsentInquiryEmails(new Date(), inquiryTenantId);
      expect(result1).toEqual({ scanned: 1, sent: 0, failed: 0, skipped: 1 });

      // Second sweep — the row is at MAX_EMAIL_ATTEMPTS so the query must not
      // select it at all.
      sendArtworkInquiry.mockClear();
      const result2 = await sweepUnsentInquiryEmails(new Date(), inquiryTenantId);

      expect(result2).toEqual({ scanned: 0, sent: 0, failed: 0, skipped: 0 });
      expect(sendArtworkInquiry).not.toHaveBeenCalled();

      // Row remains in the terminal state from the first sweep.
      const row = await db.query.inquiriesTable.findFirst({
        where: eq(inquiriesTable.id, inquiryId),
      });
      expect(row?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
      expect(row?.emailError).toBe("cross-tenant artwork mismatch");
    });

    it("inquiry with deleted artwork is not re-selected on a subsequent sweep run", async () => {
      // First sweep: artwork spy returns nothing → terminal state is written.
      // Second sweep (no spy): the row is now at MAX_EMAIL_ATTEMPTS and must
      // not appear in the candidate set at all.
      const tenantId = await createTenant();
      const artworkId = await createArtwork(tenantId);
      const inquiryId = await createFailedInquiry(tenantId, artworkId, {
        emailAttempts: 1,
        emailLastAttemptAt: null,
      });

      // First sweep — simulate deleted artwork.
      const artworkSpy = vi
        .spyOn(db.query.artworksTable, "findFirst")
        .mockResolvedValueOnce(undefined as any);
      try {
        await sweepUnsentInquiryEmails(new Date(), tenantId);
      } finally {
        artworkSpy.mockRestore();
      }

      // Second sweep — artwork spy is gone; the row is at MAX_EMAIL_ATTEMPTS
      // so the query must not select it.
      sendArtworkInquiry.mockClear();
      const result2 = await sweepUnsentInquiryEmails(new Date(), tenantId);

      expect(result2).toEqual({ scanned: 0, sent: 0, failed: 0, skipped: 0 });
      expect(sendArtworkInquiry).not.toHaveBeenCalled();

      // Row remains at the terminal state written by the first sweep.
      const row = await db.query.inquiriesTable.findFirst({
        where: eq(inquiriesTable.id, inquiryId),
      });
      expect(row?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
      expect(row?.emailError).toBe("artwork deleted");
    });

    it("requeueNoContactEmailInquiries resets exhausted rows so the sweep delivers on next run", async () => {
      // Simulate the full exhaustion → gallery adds email → delivered cycle:
      //  1. Tenant starts with no contactEmail.
      //  2. Inquiry is bumped to MAX_EMAIL_ATTEMPTS with "no gallery contact email"
      //     and is therefore excluded from the sweep candidate set.
      //  3. Gallery owner saves a contact email — requeueNoContactEmailInquiries
      //     resets emailAttempts to 0 (keeping emailError non-null).
      //  4. Next sweep run re-selects the row and delivers the email.
      const tenantId = await createTenant(""); // starts with no contactEmail
      const artworkId = await createArtwork(tenantId);
      const inquiryId = await createFailedInquiry(tenantId, artworkId, {
        emailAttempts: MAX_EMAIL_ATTEMPTS,
        emailError: "no gallery contact email",
      });

      // Step 2: confirm the row is excluded while email is still absent.
      const beforeRequeue = await sweepUnsentInquiryEmails(new Date(), tenantId);
      expect(beforeRequeue).toEqual({ scanned: 0, sent: 0, failed: 0, skipped: 0 });
      expect(sendArtworkInquiry).not.toHaveBeenCalled();

      // Step 3: gallery owner adds a contact email — update the tenant row and
      // call the requeue helper (mirrors what updateTenantSettings does).
      await db
        .update(tenantsTable)
        .set({ contactEmail: "gallery@test.com" } as any)
        .where(eq(tenantsTable.id, tenantId));
      await requeueNoContactEmailInquiries(tenantId);

      // The inquiry row must be reset so the sweep re-selects it.
      const afterRequeue = await db.query.inquiriesTable.findFirst({
        where: eq(inquiriesTable.id, inquiryId),
      });
      expect(afterRequeue?.emailAttempts).toBe(0);
      expect(afterRequeue?.emailError).toBe("no gallery contact email"); // still non-null → eligible
      expect(afterRequeue?.emailLastAttemptAt).toBeNull();

      // Step 4: next sweep run delivers the email.
      const deliveryResult = await sweepUnsentInquiryEmails(new Date(), tenantId);
      expect(deliveryResult).toEqual({ scanned: 1, sent: 1, failed: 0, skipped: 0 });
      expect(sendArtworkInquiry).toHaveBeenCalledOnce();

      // Row is now marked as successfully delivered.
      const delivered = await db.query.inquiriesTable.findFirst({
        where: eq(inquiriesTable.id, inquiryId),
      });
      expect(delivered?.emailError).toBeNull();
      expect(delivered?.emailAttempts).toBe(1);
    });

    it("requeue at MAX-1 invalidates the sweep CAS so the inquiry is still delivered", async () => {
      // Models the race where a sweep reads the row at emailAttempts=MAX-1 with
      // no contact email, then the gallery owner saves an email (requeue runs),
      // and finally the sweep's stale CAS fires.
      //
      // requeueNoContactEmailInquiries resets emailAttempts → 0.  The sweep's
      // CAS condition checks emailAttempts = MAX-1; after the reset that
      // snapshot no longer matches, so the stale bump to MAX is a no-op.  The
      // next sweep sees emailAttempts=0 < MAX, finds the contact email, and
      // delivers.
      const tenantId = await createTenant(""); // starts with no contactEmail
      const artworkId = await createArtwork(tenantId);
      const inquiryId = await createFailedInquiry(tenantId, artworkId, {
        emailAttempts: MAX_EMAIL_ATTEMPTS - 1,
        emailError: "no gallery contact email",
      });

      // Simulate settings save: add contact email and requeue (this runs
      // before the in-flight sweep CAS, invalidating the snapshot).
      await db
        .update(tenantsTable)
        .set({ contactEmail: "gallery@test.com" } as any)
        .where(eq(tenantsTable.id, tenantId));
      await requeueNoContactEmailInquiries(tenantId);

      // Now simulate the stale sweep CAS firing: it tries to bump emailAttempts
      // from MAX-1 → MAX, but the requeue already changed emailAttempts to 0,
      // so the CAS where-clause (emailAttempts = MAX-1) matches nothing.
      const { rowCount } = await db
        .update(inquiriesTable)
        .set({
          emailError: "no gallery contact email",
          emailAttempts: MAX_EMAIL_ATTEMPTS,
          emailLastAttemptAt: new Date(),
        })
        .where(
          and(
            eq(inquiriesTable.id, inquiryId),
            eq(inquiriesTable.emailAttempts, MAX_EMAIL_ATTEMPTS - 1),
          ),
        );
      // CAS must find zero matching rows — the stale bump is a no-op.
      expect(rowCount).toBe(0);

      // Row is at emailAttempts=0 — eligible for the next sweep.
      const afterStale = await db.query.inquiriesTable.findFirst({
        where: eq(inquiriesTable.id, inquiryId),
      });
      expect(afterStale?.emailAttempts).toBe(0);

      // Next sweep delivers the email now that the contact email is set.
      const deliveryResult = await sweepUnsentInquiryEmails(new Date(), tenantId);
      expect(deliveryResult).toEqual({ scanned: 1, sent: 1, failed: 0, skipped: 0 });
      expect(sendArtworkInquiry).toHaveBeenCalledOnce();

      const delivered = await db.query.inquiriesTable.findFirst({
        where: eq(inquiriesTable.id, inquiryId),
      });
      expect(delivered?.emailError).toBeNull();
    });

    it("retrySmtpErrorInquiries resets exhausted SMTP-error rows so the sweep delivers on the next run", async () => {
      // Simulate the full stuck → admin retry → delivered cycle:
      //  1. Tenant has a contact email configured from the start.
      //  2. Two inquiries are exhausted with genuine SMTP errors (not the
      //     "no gallery contact email" sentinel) — they are excluded from the
      //     sweep candidate set because emailAttempts = MAX_EMAIL_ATTEMPTS.
      //  3. Admin triggers retrySmtpErrorInquiries → both rows are reset.
      //  4. One additional inquiry with the "no gallery contact email" sentinel
      //     must NOT be reset by this call (that sentinel is owned by the
      //     automatic email-change requeue path).
      //  5. Next sweep run delivers both SMTP-error inquiries.
      const tenantId = await createTenant("gallery@test.com");
      const artworkId = await createArtwork(tenantId);

      // Inquiry A: exhausted with a permanent bounce error.
      const smtpBounceId = await createFailedInquiry(tenantId, artworkId, {
        emailAttempts: MAX_EMAIL_ATTEMPTS,
        emailError: "550 mailbox not found",
        emailLastAttemptAt: new Date(Date.now() - 60_000),
      });

      // Inquiry B: exhausted with a transient timeout error.
      const smtpTimeoutId = await createFailedInquiry(tenantId, artworkId, {
        emailAttempts: MAX_EMAIL_ATTEMPTS,
        emailError: "SMTP connection timeout",
        emailLastAttemptAt: new Date(Date.now() - 60_000),
      });

      // Inquiry C: exhausted with the "no gallery contact email" sentinel —
      // must NOT be touched by retrySmtpErrorInquiries.
      const noContactId = await createFailedInquiry(tenantId, artworkId, {
        emailAttempts: MAX_EMAIL_ATTEMPTS,
        emailError: "no gallery contact email",
        emailLastAttemptAt: new Date(Date.now() - 60_000),
      });

      // Confirm all three are excluded from the sweep before the retry action.
      const beforeRetry = await sweepUnsentInquiryEmails(new Date(), tenantId);
      expect(beforeRetry).toEqual({ scanned: 0, sent: 0, failed: 0, skipped: 0 });
      expect(sendArtworkInquiry).not.toHaveBeenCalled();

      // Admin triggers the retry action.
      const resetCount = await retrySmtpErrorInquiries(tenantId);

      // Only the two SMTP-error rows should have been reset.
      expect(resetCount).toBe(2);

      // SMTP-error rows are reset: attempts back to 0, lastAttemptAt cleared.
      const [afterA, afterB] = await Promise.all([
        db.query.inquiriesTable.findFirst({ where: eq(inquiriesTable.id, smtpBounceId) }),
        db.query.inquiriesTable.findFirst({ where: eq(inquiriesTable.id, smtpTimeoutId) }),
      ]);
      expect(afterA?.emailAttempts).toBe(0);
      expect(afterA?.emailLastAttemptAt).toBeNull();
      expect(afterA?.emailError).toBe("550 mailbox not found"); // non-null → still eligible
      expect(afterB?.emailAttempts).toBe(0);
      expect(afterB?.emailLastAttemptAt).toBeNull();
      expect(afterB?.emailError).toBe("SMTP connection timeout");

      // "no gallery contact email" row must be completely untouched.
      const afterC = await db.query.inquiriesTable.findFirst({
        where: eq(inquiriesTable.id, noContactId),
      });
      expect(afterC?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
      expect(afterC?.emailError).toBe("no gallery contact email");

      // Next sweep run delivers both SMTP-error inquiries (gallery has a
      // contact email, artwork exists, backoff windows are cleared).
      sendArtworkInquiry.mockResolvedValue(true);
      const deliveryResult = await sweepUnsentInquiryEmails(new Date(), tenantId);

      // scanned=2 (the two SMTP-error rows); the "no gallery contact email"
      // row is still at MAX_EMAIL_ATTEMPTS and is not selected.
      expect(deliveryResult).toEqual({ scanned: 2, sent: 2, failed: 0, skipped: 0 });
      expect(sendArtworkInquiry).toHaveBeenCalledTimes(2);

      // Both SMTP-error rows are now delivered.
      const [deliveredA, deliveredB] = await Promise.all([
        db.query.inquiriesTable.findFirst({ where: eq(inquiriesTable.id, smtpBounceId) }),
        db.query.inquiriesTable.findFirst({ where: eq(inquiriesTable.id, smtpTimeoutId) }),
      ]);
      expect(deliveredA?.emailError).toBeNull();
      expect(deliveredA?.emailAttempts).toBe(1);
      expect(deliveredB?.emailError).toBeNull();
      expect(deliveredB?.emailAttempts).toBe(1);
    });

    it("exhausted-mid-sweep: row at MAX_EMAIL_ATTEMPTS is not scanned on the second sweep pass", async () => {
      // Scenario: during a multi-row sweep one inquiry is driven from
      // MAX-1 to MAX by a transport failure.  The test verifies that a
      // subsequent sweep invocation excludes that now-exhausted row entirely —
      // the candidate query's lt(emailAttempts, MAX) guard must filter it out
      // before sendArtworkInquiry is ever called again.
      //
      // Steps:
      //  1. Seed the inquiry at emailAttempts = MAX-1 (one attempt away from
      //     exhaustion) with an SMTP error already recorded.
      //  2. First sweep: mock sendArtworkInquiry to reject → the sweep bumps
      //     emailAttempts to MAX and records the new error.
      //  3. Second sweep: assert scanned=0 and sendArtworkInquiry was never
      //     called for this inquiry.
      const tenantId = await createTenant("gallery@test.com");
      const artworkId = await createArtwork(tenantId);
      const inquiryId = await createFailedInquiry(tenantId, artworkId, {
        emailAttempts: MAX_EMAIL_ATTEMPTS - 1,
        emailError: "smtp timeout",
        emailLastAttemptAt: null, // no backoff — eligible immediately
      });

      // First sweep: mock rejects so the sweep bumps emailAttempts to MAX.
      sendArtworkInquiry.mockRejectedValueOnce(new Error("SMTP server unavailable"));
      const result1 = await sweepUnsentInquiryEmails(new Date(), tenantId);

      // The inquiry was scanned and the send failed — one row processed.
      expect(result1).toEqual({ scanned: 1, sent: 0, failed: 1, skipped: 0 });
      expect(sendArtworkInquiry).toHaveBeenCalledTimes(1);

      // Confirm the row is now at MAX_EMAIL_ATTEMPTS in the DB.
      const afterFirst = await db.query.inquiriesTable.findFirst({
        where: eq(inquiriesTable.id, inquiryId),
      });
      expect(afterFirst?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
      expect(afterFirst?.emailError).toMatch(/SMTP server unavailable/);

      // Second sweep: the exhausted row must not appear in the candidate set.
      sendArtworkInquiry.mockClear();
      const result2 = await sweepUnsentInquiryEmails(new Date(), tenantId);

      // scanned=0 proves the lt(emailAttempts, MAX) guard excluded the row.
      expect(result2).toEqual({ scanned: 0, sent: 0, failed: 0, skipped: 0 });
      expect(sendArtworkInquiry).not.toHaveBeenCalled();

      // Row must remain exactly as the first sweep left it — untouched.
      const afterSecond = await db.query.inquiriesTable.findFirst({
        where: eq(inquiriesTable.id, inquiryId),
      });
      expect(afterSecond?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
      expect(afterSecond?.emailError).toMatch(/SMTP server unavailable/);
    });

    it("sweep does not re-select exhausted SMTP-error inquiries after a gallery email-A → email-B change", async () => {
      // Arrange: tenant starts with a real contact email (email A).
      // Two inquiries were filed and their delivery attempts exhausted with
      // genuine SMTP errors — errors that are tied to the buyer's address or
      // the mail-server path, NOT to the gallery having no contact email.
      // These rows have emailAttempts = MAX_EMAIL_ATTEMPTS and an SMTP error
      // string (not the "no gallery contact email" sentinel).
      const tenantId = await createTenant("gallery-a@test.com"); // email A

      const artworkId = await createArtwork(tenantId);

      // Inquiry 1: "550 mailbox not found" — a permanent SMTP bounce.
      const smtpBounceId = await createFailedInquiry(tenantId, artworkId, {
        emailAttempts: MAX_EMAIL_ATTEMPTS,
        emailError: "550 mailbox not found",
        emailLastAttemptAt: new Date(Date.now() - 60_000),
      });

      // Inquiry 2: "SMTP connection timeout" — a transient but exhausted error.
      const smtpTimeoutId = await createFailedInquiry(tenantId, artworkId, {
        emailAttempts: MAX_EMAIL_ATTEMPTS,
        emailError: "SMTP connection timeout",
        emailLastAttemptAt: new Date(Date.now() - 60_000),
      });

      // Capture the timestamps before the email change so we can assert they
      // are not mutated by either the requeue step or the subsequent sweep.
      const [beforeBounce, beforeTimeout] = await Promise.all([
        db.query.inquiriesTable.findFirst({ where: eq(inquiriesTable.id, smtpBounceId) }),
        db.query.inquiriesTable.findFirst({ where: eq(inquiriesTable.id, smtpTimeoutId) }),
      ]);
      expect(beforeBounce?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
      expect(beforeTimeout?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);

      // Act step 1: gallery owner changes contact email to email B.
      // Mirror exactly what updateTenantSettings does: update the tenant row
      // then call requeueNoContactEmailInquiries (which is a no-op here because
      // neither inquiry has the "no gallery contact email" sentinel).
      await db
        .update(tenantsTable)
        .set({ contactEmail: "gallery-b@test.com" } as any)
        .where(eq(tenantsTable.id, tenantId));
      await requeueNoContactEmailInquiries(tenantId);

      // Act step 2: run the sweep for this tenant.  The sweep's candidate query
      // filters on lt(emailAttempts, MAX_EMAIL_ATTEMPTS), so exhausted rows
      // (emailAttempts = MAX) must not be selected at all.
      const result = await sweepUnsentInquiryEmails(new Date(), tenantId);

      // The sweep must find zero candidates for this tenant — both rows are
      // excluded by the lt(emailAttempts, MAX_EMAIL_ATTEMPTS) guard.
      expect(result).toEqual({ scanned: 0, sent: 0, failed: 0, skipped: 0 });
      expect(sendArtworkInquiry).not.toHaveBeenCalled();

      // Assert: every field on both SMTP-error rows is completely unchanged.
      const [afterBounce, afterTimeout] = await Promise.all([
        db.query.inquiriesTable.findFirst({ where: eq(inquiriesTable.id, smtpBounceId) }),
        db.query.inquiriesTable.findFirst({ where: eq(inquiriesTable.id, smtpTimeoutId) }),
      ]);

      // emailAttempts must still be MAX — not reset and not incremented.
      expect(afterBounce?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
      expect(afterBounce?.emailError).toBe("550 mailbox not found");
      // emailLastAttemptAt must be exactly the value written at insert time.
      expect(afterBounce?.emailLastAttemptAt?.getTime()).toBe(
        beforeBounce?.emailLastAttemptAt?.getTime(),
      );

      expect(afterTimeout?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
      expect(afterTimeout?.emailError).toBe("SMTP connection timeout");
      expect(afterTimeout?.emailLastAttemptAt?.getTime()).toBe(
        beforeTimeout?.emailLastAttemptAt?.getTime(),
      );
    });
  },
);
