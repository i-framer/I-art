/**
 * Task #946 — Confirm a no-contact inquiry that exhausts all retries ends up
 * in the right banner.
 *
 * When a gallery has no contact email the sweep writes NO_CONTACT_EMAIL_ERROR
 * into emailError and bumps emailAttempts by 1 each cycle.  Once emailAttempts
 * reaches MAX_EMAIL_ATTEMPTS the row satisfies the predicate used by
 * getEmailFailCount (emailError IS NOT NULL AND emailAttempts >= MAX AND
 * archivedAt IS NULL) — so it is counted in the "permanently failed" banner
 * even though the root cause is a missing address, not an SMTP failure.
 *
 * At the same time getNoContactEmailInquiryCount uses only emailError =
 * NO_CONTACT_EMAIL_ERROR (no attempt-count gate), so the exhausted row also
 * sits in the "no contact email" banner simultaneously.
 *
 * When the gallery owner clicks the "retry" button on the "permanently failed"
 * banner, retryFailedInquiryNotifications calls requeueExhaustedInquiries,
 * which resets emailAttempts to 0 and emailLastAttemptAt to null for ALL
 * exhausted rows (including no-contact ones).  The row is then absent from
 * getEmailFailCount but still present in getNoContactEmailInquiryCount —
 * giving the owner the correct signal: "add a contact email" rather than
 * "SMTP permanently failed".
 *
 * Assertions:
 *  1. A no-contact inquiry at exactly MAX is counted by getEmailFailCount.
 *  2. The same row is also counted by getNoContactEmailInquiryCount (double-banner).
 *  3. requeueExhaustedInquiries resets it (emailAttempts→0, emailLastAttemptAt→null).
 *  4. After reset, getEmailFailCount drops to 0 (row no longer exhausted).
 *  5. After reset, getNoContactEmailInquiryCount stays at 1 (sentinel preserved).
 *  6. A no-contact inquiry below MAX is NOT in getEmailFailCount (only in the
 *     no-contact banner) — the attempt-count gate keeps it out until exhausted.
 *  7. requeueExhaustedInquiries redirect count matches the banner count before
 *     the action runs — owner never sees a count that surprises them.
 *  8. An archived exhausted no-contact inquiry is excluded from both banners
 *     and from the requeue action.
 */
import { afterAll, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable, inquiriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { MAX_EMAIL_ATTEMPTS, NO_CONTACT_EMAIL_ERROR } from "@/lib/email-sweep";

// ── Auth mock ─────────────────────────────────────────────────────────────────

const mockSession = {
  userId: "u-946-test",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test-946",
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// getEmailFailCount, getNoContactEmailInquiryCount and
// retryFailedInquiryNotifications must hit the real DB.
import {
  getEmailFailCount,
  getNoContactEmailInquiryCount,
} from "@/app/(admin)/_actions/inquiry-count";
import { retryFailedInquiryNotifications } from "@/app/(admin)/(gated)/inquiries/actions";

// ── Helpers ───────────────────────────────────────────────────────────────────

const RUN = randomUUID().slice(0, 8);
const CREATED_TENANT_IDS: string[] = [];
const CREATED_ARTWORK_IDS: string[] = [];
const CREATED_INQUIRY_IDS: string[] = [];

function makeId(label: string) {
  return `test-946-${RUN}-${label}`;
}

async function insertTenant(id: string): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "No-Contact Exhausted Banner Test Gallery",
    type: "ARTIST",
    contactEmail: "owner@banner-946.test",
    billingExempt: true,
    subscriptionStatus: null,
  } as any);
}

async function insertArtwork(id: string, tenantId: string): Promise<void> {
  CREATED_ARTWORK_IDS.push(id);
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork 946",
    sku: `sku-946-${RUN}-${id.slice(-6)}`,
    status: "AVAILABLE",
  } as any);
}

async function insertInquiry(
  id: string,
  tenantId: string,
  artworkId: string,
  overrides: {
    emailError?: string | null;
    emailAttempts?: number;
    emailLastAttemptAt?: Date | null;
    archivedAt?: Date | null;
  } = {},
): Promise<void> {
  CREATED_INQUIRY_IDS.push(id);
  const emailError =
    overrides.emailError !== undefined
      ? overrides.emailError
      : NO_CONTACT_EMAIL_ERROR;
  await db.insert(inquiriesTable).values({
    id,
    tenantId,
    artworkId,
    artworkTitle: "Test Artwork 946",
    buyerName: "Test Buyer",
    buyerEmail: "buyer@example.com",
    message: "Is this available?",
    emailError,
    emailAttempts: overrides.emailAttempts ?? 0,
    emailLastAttemptAt:
      overrides.emailLastAttemptAt !== undefined
        ? overrides.emailLastAttemptAt
        : new Date("2024-01-01"),
    archivedAt: overrides.archivedAt ?? null,
  });
}

async function fetchRow(id: string) {
  return db.query.inquiriesTable.findFirst({
    where: eq(inquiriesTable.id, id),
  });
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

afterAll(async () => {
  for (const id of CREATED_INQUIRY_IDS) {
    await db
      .delete(inquiriesTable)
      .where(eq(inquiriesTable.id, id))
      .catch(() => {});
  }
  for (const id of CREATED_ARTWORK_IDS) {
    await db
      .delete(artworksTable)
      .where(eq(artworksTable.id, id))
      .catch(() => {});
  }
  for (const id of CREATED_TENANT_IDS) {
    await db
      .delete(tenantsTable)
      .where(eq(tenantsTable.id, id))
      .catch(() => {});
  }
});

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration(
  "no-contact inquiry exhausted banner — real DB (Task #946)",
  () => {
    /**
     * Core scenario: a no-contact inquiry is driven to MAX_EMAIL_ATTEMPTS by
     * the sweep.  It now appears in BOTH the "permanently failed" banner
     * (getEmailFailCount) and the "no contact email" banner
     * (getNoContactEmailInquiryCount) simultaneously.
     *
     * When the owner clicks the "permanently failed" retry button,
     * requeueExhaustedInquiries resets the row.  Afterwards:
     *  - getEmailFailCount → 0 (row no longer exhausted)
     *  - getNoContactEmailInquiryCount → 1 (sentinel preserved, still needs email)
     */
    it(
      "exhausted no-contact inquiry appears in the permanently-failed banner and is reset by requeueExhaustedInquiries",
      async () => {
        const tenantId = makeId("tenant-exhausted");
        await insertTenant(tenantId);

        const artworkId = makeId("aw-exhausted");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq-exhausted");
        await insertInquiry(inqId, tenantId, artworkId, {
          emailError: NO_CONTACT_EMAIL_ERROR,
          emailAttempts: MAX_EMAIL_ATTEMPTS, // exactly at the cap
        });

        mockSession.tenantId = tenantId;
        mockSession.role = "owner";

        // ── Banner counts before action ───────────────────────────────────────

        const failCount = await getEmailFailCount();
        // The no-contact inquiry at MAX satisfies the permanently-failed
        // predicate (emailError IS NOT NULL AND emailAttempts >= MAX).
        expect(failCount).toBe(1);

        const noContactCount = await getNoContactEmailInquiryCount();
        // getNoContactEmailInquiryCount has no attempt-count gate so it counts
        // the same row regardless of how many cycles have elapsed.
        expect(noContactCount).toBe(1);

        // ── Run the retry action ──────────────────────────────────────────────

        const error = await retryFailedInquiryNotifications().catch((e) => e);
        expect(error).toBeInstanceOf(Error);
        // The redirect count must equal the banner count shown to the owner.
        expect(error.message).toBe(`REDIRECT:/inquiries?retry_result=1`);

        // ── Verify row state after reset ──────────────────────────────────────

        const row = await fetchRow(inqId);
        // emailAttempts reset to 0 — re-enters sweep candidate set.
        expect(row?.emailAttempts).toBe(0);
        // emailLastAttemptAt cleared — no backoff delay for next sweep.
        expect(row?.emailLastAttemptAt).toBeNull();
        // emailError preserved — the root cause is still a missing address;
        // the sweep uses emailError IS NOT NULL to select candidates.
        expect(row?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);

        // ── Banner counts after reset ─────────────────────────────────────────

        const failCountAfter = await getEmailFailCount();
        // Row is at emailAttempts=0, which is below MAX — gone from this banner.
        expect(failCountAfter).toBe(0);

        const noContactCountAfter = await getNoContactEmailInquiryCount();
        // Sentinel is still NO_CONTACT_EMAIL_ERROR — still needs an address.
        expect(noContactCountAfter).toBe(1);
      },
    );

    /**
     * A no-contact inquiry that has NOT yet reached MAX_EMAIL_ATTEMPTS should
     * NOT appear in getEmailFailCount — the attempt-count gate (emailAttempts
     * >= MAX) is what elevates it to the "permanently failed" banner.
     *
     * It should appear only in getNoContactEmailInquiryCount (correct bucket).
     */
    it(
      "no-contact inquiry below MAX appears only in the no-contact banner, not the permanently-failed banner",
      async () => {
        const tenantId = makeId("tenant-below-max");
        await insertTenant(tenantId);

        const artworkId = makeId("aw-below-max");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq-below-max");
        await insertInquiry(inqId, tenantId, artworkId, {
          emailError: NO_CONTACT_EMAIL_ERROR,
          emailAttempts: MAX_EMAIL_ATTEMPTS - 1, // one short of the cap
        });

        mockSession.tenantId = tenantId;
        mockSession.role = "owner";

        // Must NOT appear in the permanently-failed banner.
        const failCount = await getEmailFailCount();
        expect(failCount).toBe(0);

        // Must appear in the no-contact banner (no attempt-count gate).
        const noContactCount = await getNoContactEmailInquiryCount();
        expect(noContactCount).toBe(1);

        // The retry action must show 0 because there is nothing exhausted.
        const error = await retryFailedInquiryNotifications().catch((e) => e);
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe("REDIRECT:/inquiries?retry_result=0");

        // Row is untouched by the action.
        const row = await fetchRow(inqId);
        expect(row?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS - 1);
        expect(row?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);
      },
    );

    /**
     * When both an exhausted no-contact inquiry and an exhausted SMTP-error
     * inquiry coexist, requeueExhaustedInquiries resets both and the redirect
     * count equals the banner count.
     */
    it(
      "mixed exhausted rows — no-contact and SMTP-error — both counted and both reset",
      async () => {
        const tenantId = makeId("tenant-mixed");
        await insertTenant(tenantId);

        const artworkA = makeId("aw-mixed-nc");
        const artworkB = makeId("aw-mixed-smtp");
        await insertArtwork(artworkA, tenantId);
        await insertArtwork(artworkB, tenantId);

        const inqNC = makeId("inq-mixed-nc"); // no-contact, at MAX
        const inqSMTP = makeId("inq-mixed-smtp"); // SMTP error, at MAX

        await insertInquiry(inqNC, tenantId, artworkA, {
          emailError: NO_CONTACT_EMAIL_ERROR,
          emailAttempts: MAX_EMAIL_ATTEMPTS,
        });
        await insertInquiry(inqSMTP, tenantId, artworkB, {
          emailError: "550 mailbox not found",
          emailAttempts: MAX_EMAIL_ATTEMPTS,
        });

        mockSession.tenantId = tenantId;
        mockSession.role = "owner";

        // Both rows satisfy emailError IS NOT NULL AND emailAttempts >= MAX.
        const failCountBefore = await getEmailFailCount();
        expect(failCountBefore).toBe(2);

        // Only the no-contact row satisfies the no-contact predicate.
        const noContactCount = await getNoContactEmailInquiryCount();
        expect(noContactCount).toBe(1);

        // Action resets both; redirect count = banner count.
        const error = await retryFailedInquiryNotifications().catch((e) => e);
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe(`REDIRECT:/inquiries?retry_result=2`);

        // Both rows were reset.
        const rowNC = await fetchRow(inqNC);
        expect(rowNC?.emailAttempts).toBe(0);
        expect(rowNC?.emailLastAttemptAt).toBeNull();
        expect(rowNC?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);

        const rowSMTP = await fetchRow(inqSMTP);
        expect(rowSMTP?.emailAttempts).toBe(0);
        expect(rowSMTP?.emailLastAttemptAt).toBeNull();
        expect(rowSMTP?.emailError).toBe("550 mailbox not found");

        // Permanently-failed banner is now clear.
        const failCountAfter = await getEmailFailCount();
        expect(failCountAfter).toBe(0);

        // No-contact banner still shows 1 — sentinel survived the reset.
        const noContactCountAfter = await getNoContactEmailInquiryCount();
        expect(noContactCountAfter).toBe(1);
      },
    );

    /**
     * An archived exhausted no-contact inquiry is excluded from BOTH banners
     * (archivedAt IS NULL is required by both counts) and is NOT touched by
     * requeueExhaustedInquiries.
     */
    it(
      "archived exhausted no-contact inquiry is excluded from both banners and from the requeue action",
      async () => {
        const tenantId = makeId("tenant-archived-nc");
        await insertTenant(tenantId);

        const artworkId = makeId("aw-archived-nc");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq-archived-nc");
        await insertInquiry(inqId, tenantId, artworkId, {
          emailError: NO_CONTACT_EMAIL_ERROR,
          emailAttempts: MAX_EMAIL_ATTEMPTS,
          archivedAt: new Date("2024-05-01"),
        });

        mockSession.tenantId = tenantId;
        mockSession.role = "owner";

        // Archived rows must not appear in either banner.
        const failCount = await getEmailFailCount();
        expect(failCount).toBe(0);

        const noContactCount = await getNoContactEmailInquiryCount();
        expect(noContactCount).toBe(0);

        // Action resets 0 rows — archived row is excluded by archivedAt IS NULL.
        const error = await retryFailedInquiryNotifications().catch((e) => e);
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe("REDIRECT:/inquiries?retry_result=0");

        // Archived row is completely untouched.
        const row = await fetchRow(inqId);
        expect(row?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
        expect(row?.archivedAt).not.toBeNull();
        expect(row?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);
      },
    );

    /**
     * A no-contact inquiry above MAX (e.g. bumped past the cap by a concurrent
     * terminal write path) is also counted in getEmailFailCount (gte check)
     * and reset by requeueExhaustedInquiries.
     */
    it(
      "no-contact inquiry above MAX is counted in the permanently-failed banner and reset",
      async () => {
        const tenantId = makeId("tenant-above-max");
        await insertTenant(tenantId);

        const artworkId = makeId("aw-above-max");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq-above-max");
        await insertInquiry(inqId, tenantId, artworkId, {
          emailError: NO_CONTACT_EMAIL_ERROR,
          emailAttempts: MAX_EMAIL_ATTEMPTS + 3, // bumped past cap
        });

        mockSession.tenantId = tenantId;
        mockSession.role = "owner";

        // gte(MAX) includes rows above MAX too.
        const failCount = await getEmailFailCount();
        expect(failCount).toBe(1);

        const error = await retryFailedInquiryNotifications().catch((e) => e);
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe(`REDIRECT:/inquiries?retry_result=1`);

        const row = await fetchRow(inqId);
        expect(row?.emailAttempts).toBe(0);
        expect(row?.emailLastAttemptAt).toBeNull();
        expect(row?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);

        // No longer in permanently-failed banner after reset.
        const failCountAfter = await getEmailFailCount();
        expect(failCountAfter).toBe(0);

        // Still in no-contact banner.
        const noContactCountAfter = await getNoContactEmailInquiryCount();
        expect(noContactCountAfter).toBe(1);
      },
    );
  },
);
