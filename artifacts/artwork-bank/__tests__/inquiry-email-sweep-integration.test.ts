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
 *  8. Inquiry with no tenant contactEmail is skipped without crashing.
 *  9. Missing artwork causes the sweep to skip without touching the row.
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

    it("inquiry with no tenant contactEmail is skipped without crashing", async () => {
      // Tenant has a blank contactEmail — sweep must reach the skip branch without throwing.
      const tenantId = await createTenant(""); // blank contactEmail
      const artworkId = await createArtwork(tenantId);
      const inquiryId = await createFailedInquiry(tenantId, artworkId, {
        emailAttempts: 1,
      });

      const result = await sweepUnsentInquiryEmails(new Date(), tenantId);

      expect(result).toEqual({ scanned: 1, sent: 0, failed: 0, skipped: 1 });
      expect(sendArtworkInquiry).not.toHaveBeenCalled();

      // Row untouched — skipped path does not write to the DB.
      const row = await db.query.inquiriesTable.findFirst({
        where: eq(inquiriesTable.id, inquiryId),
      });
      expect(row?.emailAttempts).toBe(1);
      expect(row?.emailError).not.toBeNull();
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
  },
);
