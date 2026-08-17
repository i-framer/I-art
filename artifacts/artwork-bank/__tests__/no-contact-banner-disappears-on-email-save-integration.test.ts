/**
 * Task #948 — Confirm the 'no contact email' banner disappears immediately
 * after the gallery adds an address.
 *
 * When a gallery owner saves a contact email, requeueNoContactEmailInquiries
 * resets ALL no-contact inquiries for that tenant — regardless of attempt
 * count.  This is the only path that handles rows that were previously
 * exhausted (emailAttempts ≥ MAX_EMAIL_ATTEMPTS) and re-queues them so the
 * sweep can deliver them once a real address exists.
 *
 * Flow under test:
 *  1. Seed a tenant with NO contact email and three no-contact inquiries:
 *       - below MAX_EMAIL_ATTEMPTS  (not yet exhausted)
 *       - at exactly MAX_EMAIL_ATTEMPTS  (exhausted, counted in fail banner)
 *       - above MAX_EMAIL_ATTEMPTS  (over-bumped, also in fail banner)
 *  2. Call requeueNoContactEmailInquiries directly (what updateTenantSettings
 *     calls internally when a contactEmail is saved).
 *  3. Assert immediately after requeue:
 *       - getEmailFailCount → 0  (exhausted rows reset, no longer at MAX)
 *       - every row has emailAttempts = 0 and emailLastAttemptAt = null
 *       - getNoContactEmailInquiryCount still equals the seeded count
 *         (emailError sentinel preserved so the sweep can re-select rows)
 *  4. Run sweepUnsentInquiryEmails with a mocked transport.
 *  5. Assert getNoContactEmailInquiryCount → 0  (sentinel cleared after
 *     successful delivery).
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
  userId: "u-948-test",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test-948",
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// base-url: used by sweepUnsentInquiryEmails to build the artwork URL in the
// notification email body.
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
  requeueNoContactEmailInquiries,
  sweepUnsentInquiryEmails,
  NO_CONTACT_EMAIL_ERROR,
  MAX_EMAIL_ATTEMPTS,
} from "@/lib/email-sweep";
import {
  getNoContactEmailInquiryCount,
  getEmailFailCount,
} from "@/app/(admin)/_actions/inquiry-count";

// ── Helpers ───────────────────────────────────────────────────────────────────

const RUN = randomUUID().slice(0, 8);
let seq = 0;
const CREATED_TENANT_IDS: string[] = [];
const CREATED_ARTWORK_IDS: string[] = [];
const CREATED_INQUIRY_IDS: string[] = [];

function makeId(label: string) {
  return `t948-${RUN}-${++seq}-${label}`;
}

async function insertTenant(
  id: string,
  opts: { contactEmail?: string } = {},
): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Banner Disappears Test Gallery",
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
    title: "Test Artwork 948",
    sku: `sku-948-${RUN}-${id.slice(-6)}`,
    status: "AVAILABLE",
  } as any);
}

async function insertNoContactInquiry(
  id: string,
  tenantId: string,
  artworkId: string,
  emailAttempts: number,
): Promise<void> {
  CREATED_INQUIRY_IDS.push(id);
  await db.insert(inquiriesTable).values({
    id,
    tenantId,
    artworkId,
    artworkTitle: "Test Artwork 948",
    buyerName: "Test Buyer",
    buyerEmail: "buyer@example.com",
    message: "Is this still available?",
    emailError: NO_CONTACT_EMAIL_ERROR,
    emailAttempts,
    emailLastAttemptAt: new Date("2024-01-01T10:00:00Z"),
    status: "NEW",
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
  "no-contact banner disappears after gallery adds contact email — real DB (Task #948)",
  () => {
    /**
     * Core scenario: three no-contact inquiries at different attempt levels.
     *
     * After requeueNoContactEmailInquiries:
     *  - getEmailFailCount drops to 0 immediately (exhausted rows re-queued)
     *  - all rows have emailAttempts=0 and emailLastAttemptAt=null
     *  - getNoContactEmailInquiryCount remains at 3 (sentinel preserved for sweep)
     *
     * After sweepUnsentInquiryEmails delivers all three:
     *  - getNoContactEmailInquiryCount drops to 0
     */
    it(
      "requeueNoContactEmailInquiries resets all attempt levels; banner counts drop correctly after sweep",
      async () => {
        const tenantId = makeId("tenant");
        // Tenant has a contact email so the sweep can deliver on re-queue.
        await insertTenant(tenantId, { contactEmail: "owner@gallery-948.test" });

        const artworkId = makeId("artwork");
        await insertArtwork(artworkId, tenantId);

        // Three inquiries at different attempt levels.
        const inqBelowMax = makeId("inq-below");
        const inqAtMax = makeId("inq-at");
        const inqAboveMax = makeId("inq-above");

        const belowMaxAttempts = MAX_EMAIL_ATTEMPTS - 2; // e.g. 3 when MAX=5
        await insertNoContactInquiry(
          inqBelowMax,
          tenantId,
          artworkId,
          belowMaxAttempts,
        );
        await insertNoContactInquiry(
          inqAtMax,
          tenantId,
          artworkId,
          MAX_EMAIL_ATTEMPTS,
        );
        await insertNoContactInquiry(
          inqAboveMax,
          tenantId,
          artworkId,
          MAX_EMAIL_ATTEMPTS + 3,
        );

        mockSession.tenantId = tenantId;

        // ── Pre-conditions ────────────────────────────────────────────────────

        // Two rows satisfy emailAttempts >= MAX (at MAX and above MAX).
        const failCountBefore = await getEmailFailCount();
        expect(failCountBefore).toBe(2);

        // All three carry the NO_CONTACT_EMAIL_ERROR sentinel.
        const noContactBefore = await getNoContactEmailInquiryCount();
        expect(noContactBefore).toBe(3);

        // ── Requeue (simulates gallery owner saving a contact email) ──────────

        await requeueNoContactEmailInquiries(tenantId);

        // ── Immediately after requeue ─────────────────────────────────────────

        // getEmailFailCount must drop to 0: exhausted rows were re-queued
        // (emailAttempts reset to 0, which is below MAX_EMAIL_ATTEMPTS).
        const failCountAfterRequeue = await getEmailFailCount();
        expect(failCountAfterRequeue).toBe(0);

        // getNoContactEmailInquiryCount still shows 3: emailError sentinel is
        // preserved so the sweep can re-select the rows on its next run.
        const noContactAfterRequeue = await getNoContactEmailInquiryCount();
        expect(noContactAfterRequeue).toBe(3);

        // Every row must have emailAttempts=0 and emailLastAttemptAt=null.
        const [rowBelow, rowAt, rowAbove] = await Promise.all([
          fetchRow(inqBelowMax),
          fetchRow(inqAtMax),
          fetchRow(inqAboveMax),
        ]);

        expect(rowBelow?.emailAttempts).toBe(0);
        expect(rowBelow?.emailLastAttemptAt).toBeNull();
        // emailError preserved so the sweep can re-select the row.
        expect(rowBelow?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);

        expect(rowAt?.emailAttempts).toBe(0);
        expect(rowAt?.emailLastAttemptAt).toBeNull();
        expect(rowAt?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);

        expect(rowAbove?.emailAttempts).toBe(0);
        expect(rowAbove?.emailLastAttemptAt).toBeNull();
        expect(rowAbove?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);

        // ── Sweep delivers all three ──────────────────────────────────────────

        sendArtworkInquiry.mockResolvedValue(true);
        const result = await sweepUnsentInquiryEmails(new Date(), tenantId);

        expect(result.sent).toBe(3);
        expect(result.failed).toBe(0);
        expect(sendArtworkInquiry).toHaveBeenCalledTimes(3);

        // ── After sweep: banner drops to 0 ───────────────────────────────────

        const noContactAfterSweep = await getNoContactEmailInquiryCount();
        expect(noContactAfterSweep).toBe(0);

        const failCountAfterSweep = await getEmailFailCount();
        expect(failCountAfterSweep).toBe(0);
      },
    );

    /**
     * Confirms tenant isolation: requeueNoContactEmailInquiries for tenant A
     * must not touch tenant B's inquiries.
     */
    it(
      "requeueNoContactEmailInquiries only resets inquiries for the specified tenant",
      async () => {
        const tenantAId = makeId("tenant-a");
        const tenantBId = makeId("tenant-b");
        await insertTenant(tenantAId, {
          contactEmail: "owner-a@gallery-948.test",
        });
        await insertTenant(tenantBId);

        const artworkAId = makeId("artwork-a");
        const artworkBId = makeId("artwork-b");
        await insertArtwork(artworkAId, tenantAId);
        await insertArtwork(artworkBId, tenantBId);

        const inqA = makeId("inq-a");
        const inqB = makeId("inq-b");
        await insertNoContactInquiry(
          inqA,
          tenantAId,
          artworkAId,
          MAX_EMAIL_ATTEMPTS,
        );
        await insertNoContactInquiry(
          inqB,
          tenantBId,
          artworkBId,
          MAX_EMAIL_ATTEMPTS,
        );

        // Requeue only tenant A.
        await requeueNoContactEmailInquiries(tenantAId);

        const rowA = await fetchRow(inqA);
        const rowB = await fetchRow(inqB);

        // Tenant A's inquiry was reset.
        expect(rowA?.emailAttempts).toBe(0);
        expect(rowA?.emailLastAttemptAt).toBeNull();
        expect(rowA?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);

        // Tenant B's inquiry was NOT touched.
        expect(rowB?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
        expect(rowB?.emailLastAttemptAt).not.toBeNull();
        expect(rowB?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);

        // Tenant A's fail count drops to 0.
        mockSession.tenantId = tenantAId;
        expect(await getEmailFailCount()).toBe(0);

        // Tenant B's fail count remains 1.
        mockSession.tenantId = tenantBId;
        expect(await getEmailFailCount()).toBe(1);
      },
    );

    /**
     * Confirms that SMTP-error inquiries (emailError ≠ NO_CONTACT_EMAIL_ERROR)
     * are NOT reset by requeueNoContactEmailInquiries — the requeue is scoped
     * to the "no gallery contact email" sentinel only.
     */
    it(
      "requeueNoContactEmailInquiries does not reset SMTP-error inquiries",
      async () => {
        const tenantId = makeId("tenant-smtp");
        await insertTenant(tenantId, {
          contactEmail: "owner@gallery-948-smtp.test",
        });

        const artworkId = makeId("artwork-smtp");
        await insertArtwork(artworkId, tenantId);

        // A genuine SMTP-error inquiry at MAX.
        const inqSMTP = makeId("inq-smtp");
        CREATED_INQUIRY_IDS.push(inqSMTP);
        await db.insert(inquiriesTable).values({
          id: inqSMTP,
          tenantId,
          artworkId,
          artworkTitle: "Test Artwork 948",
          buyerName: "SMTP Buyer",
          buyerEmail: "smtp@example.com",
          message: "Any availability?",
          emailError: "550 mailbox not found",
          emailAttempts: MAX_EMAIL_ATTEMPTS,
          emailLastAttemptAt: new Date("2024-03-01T10:00:00Z"),
          status: "NEW",
        } as any);

        // A no-contact inquiry also at MAX.
        const inqNC = makeId("inq-nc-smtp");
        await insertNoContactInquiry(inqNC, tenantId, artworkId, MAX_EMAIL_ATTEMPTS);

        mockSession.tenantId = tenantId;

        // Pre-condition: both rows satisfy the fail banner predicate.
        expect(await getEmailFailCount()).toBe(2);

        // Requeue: should only reset the no-contact row.
        await requeueNoContactEmailInquiries(tenantId);

        const smtpRow = await fetchRow(inqSMTP);
        const ncRow = await fetchRow(inqNC);

        // SMTP row untouched.
        expect(smtpRow?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
        expect(smtpRow?.emailLastAttemptAt).not.toBeNull();
        expect(smtpRow?.emailError).toBe("550 mailbox not found");

        // No-contact row reset.
        expect(ncRow?.emailAttempts).toBe(0);
        expect(ncRow?.emailLastAttemptAt).toBeNull();
        expect(ncRow?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);

        // Fail count drops by 1 (only the no-contact row was reset).
        expect(await getEmailFailCount()).toBe(1);
      },
    );
  },
);
