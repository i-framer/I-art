/**
 * Task #950 — Confirm the sweep re-selects requeued no-contact inquiries even
 * when another sweep is running concurrently.
 *
 * requeueNoContactEmailInquiries resets emailAttempts to 0 specifically to
 * invalidate any concurrent sweep's CAS condition.  If a sweep is mid-flight
 * when the gallery owner saves their email, the stale CAS write fails (it
 * matched on emailAttempts=<snapshot>, but the DB now has 0) and the row
 * stays at emailAttempts=0 — ready for the next sweep pass.
 *
 * Flow under test:
 *  1. Seed a tenant with NO contact email and an inquiry at emailAttempts=2
 *     with emailError=NO_CONTACT_EMAIL_ERROR.
 *  2. Read the row to take the sweep's "concurrent snapshot" (emailAttempts=2).
 *  3. Call requeueNoContactEmailInquiries mid-flight — resets emailAttempts→0.
 *  4. Execute the CAS write the concurrent sweep would have issued
 *     (WHERE emailAttempts=2) — must return 0 rows because the DB now holds 0.
 *  5. Assert the row is still at emailAttempts=0 (the stale write left it
 *     untouched and did not advance it toward MAX_EMAIL_ATTEMPTS).
 *  6. Add a contact email to the tenant and run sweepUnsentInquiryEmails.
 *  7. Assert the row is selected, the email is sent, and
 *     getNoContactEmailInquiryCount drops to 0.
 *
 * All assertions run against a real PostgreSQL database so the test catches
 * Drizzle query regressions, missing WHERE clauses, and column-mapping errors
 * that unit tests with a mocked DB cannot detect.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable, inquiriesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockSession = {
  userId: "u-950-test",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test-950",
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
  retrySmtpErrorInquiries,
  sweepUnsentInquiryEmails,
  NO_CONTACT_EMAIL_ERROR,
  CLAIM_LEASE_MS,
} from "@/lib/email-sweep";
import { getNoContactEmailInquiryCount } from "@/app/(admin)/_actions/inquiry-count";

// ── Helpers ───────────────────────────────────────────────────────────────────

const RUN = randomUUID().slice(0, 8);
let seq = 0;
const CREATED_TENANT_IDS: string[] = [];
const CREATED_ARTWORK_IDS: string[] = [];
const CREATED_INQUIRY_IDS: string[] = [];

function makeId(label: string) {
  return `t950-${RUN}-${++seq}-${label}`;
}

async function insertTenant(
  id: string,
  opts: { contactEmail?: string } = {},
): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Concurrent Requeue Test Gallery",
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
    title: "Test Artwork 950",
    sku: `sku-950-${RUN}-${id.slice(-6)}`,
    status: "AVAILABLE",
  } as any);
}

async function insertNoContactInquiry(
  id: string,
  tenantId: string,
  artworkId: string,
  emailAttempts: number,
  emailLastAttemptAt: Date | null = new Date("2024-06-01T10:00:00Z"),
): Promise<void> {
  CREATED_INQUIRY_IDS.push(id);
  await db.insert(inquiriesTable).values({
    id,
    tenantId,
    artworkId,
    artworkTitle: "Test Artwork 950",
    buyerName: "Concurrent Buyer",
    buyerEmail: "concurrent-buyer@example.com",
    message: "Interested in purchasing.",
    emailError: NO_CONTACT_EMAIL_ERROR,
    emailAttempts,
    emailLastAttemptAt,
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
  "concurrent requeue invalidates stale sweep CAS — real DB (Task #950)",
  () => {
    /**
     * Core race scenario:
     *
     *  Sweep A reads the row at emailAttempts=2 (its snapshot).
     *  Gallery owner saves their email → requeueNoContactEmailInquiries runs,
     *    resetting emailAttempts→0.
     *  Sweep A's stale CAS write (WHERE emailAttempts=2) gets 0 rows back and
     *    does NOT advance the counter.
     *  Row stays at emailAttempts=0 and is re-selected by the next sweep pass,
     *    which delivers the email successfully.
     */
    it(
      "stale CAS write fails after requeueNoContactEmailInquiries; row is re-selected by the next sweep",
      async () => {
        const tenantId = makeId("tenant-950a");
        // Start with NO contact email — the inquiry will have NO_CONTACT_EMAIL_ERROR.
        await insertTenant(tenantId);

        const artworkId = makeId("artwork-950a");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq-950a");
        // One attempt away from exhaustion.
        const snapshotAttempts = 2;
        await insertNoContactInquiry(inqId, tenantId, artworkId, snapshotAttempts);

        mockSession.tenantId = tenantId;

        // ── Pre-condition: the row is in the no-contact state ─────────────────

        const rowBefore = await fetchRow(inqId);
        expect(rowBefore?.emailAttempts).toBe(2);
        expect(rowBefore?.emailLastAttemptAt).not.toBeNull();
        expect(rowBefore?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);

        const noContactBefore = await getNoContactEmailInquiryCount();
        expect(noContactBefore).toBe(1);

        // ── First requeue ─────────────────────────────────────────────────────
        //
        // Gallery owner saves their contact email for the first time.

        await requeueNoContactEmailInquiries(tenantId);

        const rowAfterRequeue = await fetchRow(inqId);
        expect(rowAfterRequeue?.emailAttempts).toBe(0);

        const staleResult = await db
          .update(inquiriesTable)
          .set({
            emailError: NO_CONTACT_EMAIL_ERROR,
            emailAttempts: snapshotAttempts + 1, // would have been MAX
            emailLastAttemptAt: new Date(),
          })
          .where(
            and(
              eq(inquiriesTable.id, inqId),
              eq(inquiriesTable.emailAttempts, snapshotAttempts),
            ),
          )
          .returning({ id: inquiriesTable.id });

        expect(staleResult).toHaveLength(0);

        // Row is still eligible — at emailAttempts=0, well below MAX.
        const rowAfterStaleWrite = await fetchRow(inqId);
        expect(rowAfterStaleWrite?.emailAttempts).toBe(0);

        // Add contact email and verify the sweep delivers it.
        await db
          .update(tenantsTable)
          .set({ contactEmail: "owner-edge@gallery-950.test" })
          .where(eq(tenantsTable.id, tenantId));

        sendArtworkInquiry.mockResolvedValue(true);
        const sweepResult = await sweepUnsentInquiryEmails(new Date(), tenantId);

        // The row at emailAttempts=0 was re-selected and the email was sent.
        expect(sweepResult.scanned).toBe(1);
        expect(sweepResult.sent).toBe(1);
        expect(sweepResult.failed).toBe(0);
        expect(sendArtworkInquiry).toHaveBeenCalledTimes(1);

        // ── No-contact banner drops to 0 after successful delivery ────────────

        const noContactAfterSweep = await getNoContactEmailInquiryCount();
        expect(noContactAfterSweep).toBe(0);

        // The DB row has emailError cleared (delivery succeeded).
        const rowFinal = await fetchRow(inqId);
        expect(rowFinal?.emailError).toBeNull();
      },
    );

    /**
     * Confirms that multiple concurrent sweeps all get their stale CAS writes
     * invalidated when requeueNoContactEmailInquiries fires in between.
     * Single stale write taken at emailAttempts=2; after requeue resets to 0,
     * the stale write returns 0 rows.
     */
    it(
      "two concurrent stale CAS writes are both invalidated after requeue",
      async () => {
        const tenantId = makeId("tenant-950b");
        // Start with NO contact email.
        await insertTenant(tenantId);

        const artworkId = makeId("artwork-950b");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq-950b");
        // One attempt away from exhaustion.
        const snapshotAttempts = 2;
        await insertNoContactInquiry(
          inqId,
          tenantId,
          artworkId,
          snapshotAttempts,
        );

        // Both sweeps read the same snapshot simultaneously (emailAttempts=2).
        // Gallery owner saves their email → requeue fires.
        await requeueNoContactEmailInquiries(tenantId);

        const rowAfterRequeue = await fetchRow(inqId);
        expect(rowAfterRequeue?.emailAttempts).toBe(0);
        expect(rowAfterRequeue?.emailLastAttemptAt).toBeNull();

        // The stale CAS write would have set emailAttempts to MAX_EMAIL_ATTEMPTS,
        // permanently removing the row from the sweep candidate set.  Confirm
        // the write is rejected.
        const staleResult = await db
          .update(inquiriesTable)
          .set({
            emailError: NO_CONTACT_EMAIL_ERROR,
            emailAttempts: snapshotAttempts + 1, // would have been MAX
            emailLastAttemptAt: new Date(),
          })
          .where(
            and(
              eq(inquiriesTable.id, inqId),
              eq(inquiriesTable.emailAttempts, snapshotAttempts),
            ),
          )
          .returning({ id: inquiriesTable.id });

        expect(staleResult).toHaveLength(0);

        // Row is still eligible — at emailAttempts=0, well below MAX.
        const rowAfterStaleWrite = await fetchRow(inqId);
        expect(rowAfterStaleWrite?.emailAttempts).toBe(0);

        // Add contact email and verify the sweep delivers it.
        await db
          .update(tenantsTable)
          .set({ contactEmail: "owner-edge@gallery-950.test" })
          .where(eq(tenantsTable.id, tenantId));

        sendArtworkInquiry.mockResolvedValue(true);
        const sweepResult = await sweepUnsentInquiryEmails(new Date(), tenantId);

        expect(sweepResult.sent).toBe(1);
        expect(sweepResult.failed).toBe(0);

        const noContactAfterSweep = await getNoContactEmailInquiryCount();
        expect(noContactAfterSweep).toBe(0);

        const rowFinal = await fetchRow(inqId);
        expect(rowFinal?.emailError).toBeNull();
      },
    );

    /**
     * Confirms that multiple concurrent sweeps all get their stale CAS writes
     * invalidated when requeueNoContactEmailInquiries fires in between.
     * Two "sweep snapshots" both taken at emailAttempts=2; after requeue resets
     * to 0, both stale writes return 0 rows.
     */
    it(
      "two concurrent stale CAS writes are both invalidated after requeue",
      async () => {
        const tenantId = makeId("tenant-950c");
        // Start with NO contact email.
        await insertTenant(tenantId);

        const artworkId = makeId("artwork-950c");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq-950c");
        const snapshotAttempts = 2;
        await insertNoContactInquiry(
          inqId,
          tenantId,
          artworkId,
          snapshotAttempts,
        );

        // Both sweeps read the same snapshot simultaneously (emailAttempts=2).
        // Gallery owner saves their email → requeue fires.
        await requeueNoContactEmailInquiries(tenantId);

        const rowAfterRequeue = await fetchRow(inqId);
        expect(rowAfterRequeue?.emailAttempts).toBe(0);

        const now = new Date();

        // First stale sweep CAS write.
        const staleResult1 = await db
          .update(inquiriesTable)
          .set({
            emailError: NO_CONTACT_EMAIL_ERROR,
            emailAttempts: snapshotAttempts + 1,
            emailLastAttemptAt: now,
          })
          .where(
            and(
              eq(inquiriesTable.id, inqId),
              eq(inquiriesTable.emailAttempts, snapshotAttempts),
            ),
          )
          .returning({ id: inquiriesTable.id });

        expect(staleResult1).toHaveLength(0);

        // Second stale sweep CAS write — also rejected.
        const staleResult2 = await db
          .update(inquiriesTable)
          .set({
            emailError: NO_CONTACT_EMAIL_ERROR,
            emailAttempts: snapshotAttempts + 1,
            emailLastAttemptAt: now,
          })
          .where(
            and(
              eq(inquiriesTable.id, inqId),
              eq(inquiriesTable.emailAttempts, snapshotAttempts),
            ),
          )
          .returning({ id: inquiriesTable.id });

        expect(staleResult2).toHaveLength(0);

        // Row is still at emailAttempts=0 — neither stale write landed.
        const rowFinal = await fetchRow(inqId);
        expect(rowFinal?.emailAttempts).toBe(0);
        expect(rowFinal?.emailLastAttemptAt).toBeNull();
        expect(rowFinal?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);

        // Deliver via the next sweep pass.
        await db
          .update(tenantsTable)
          .set({ contactEmail: "owner-multi@gallery-950.test" })
          .where(eq(tenantsTable.id, tenantId));

        sendArtworkInquiry.mockResolvedValue(true);
        const sweepResult = await sweepUnsentInquiryEmails(new Date(), tenantId);

        expect(sweepResult.sent).toBe(1);
      },
    );

    /**
     * Task #961 — Confirm that requeueNoContactEmailInquiries bulk-resets ALL
     * stuck inquiries for a tenant in a single UPDATE, regardless of how many
     * attempts each row has accumulated.
     *
     * Scenario:
     *  1. Seed 3 inquiries with emailAttempts = 1, 2, and 3 respectively, all
     *     with emailLastAttemptAt set to "just now" (well inside their backoff
     *     windows of 5 min, 10 min, and 20 min).  Without the requeue, every
     *     one of these rows would be skipped on the next sweep pass.
     *  2. Gallery owner adds a contact email → requeueNoContactEmailInquiries
     *     resets emailAttempts → 0 AND emailLastAttemptAt → null for all 3 rows.
     *  3. sweepUnsentInquiryEmails is called with now = new Date() (no time-
     *     travel).  The null emailLastAttemptAt causes the backoff guard to be
     *     skipped for every row, so all 3 emails are delivered in a single pass:
     *     sent=3, skipped=0.
     */
    it(
      "bulk requeue clears backoff for all stuck inquiries; sweep sends all 3 immediately (Task #961)",
      async () => {
        const tenantId = makeId("tenant-961");
        await insertTenant(tenantId); // no contactEmail

        const artworkId = makeId("artwork-961");
        await insertArtwork(artworkId, tenantId);

        // Seed 3 inquiries at emailAttempts=1, 2, 3 with emailLastAttemptAt
        // "just now" so each is inside its backoff window.  Without the requeue
        // they'd all be skipped on the next sweep pass.
        const recentAt = new Date();

        const inqId1 = makeId("inq-972-a");
        const inqId2 = makeId("inq-972-b");
        const inqId3 = makeId("inq-972-c");

        await Promise.all([
          insertNoContactInquiry(inqId1, tenantId, artworkId, 1, recentAt),
          insertNoContactInquiry(inqId2, tenantId, artworkId, 2, recentAt),
          insertNoContactInquiry(inqId3, tenantId, artworkId, 3, recentAt),
        ]);

        mockSession.tenantId = tenantId;

        // ── Pre-condition: all 3 rows are stuck inside their backoff windows ──

        const [r1, r2, r3] = await Promise.all([
          fetchRow(inqId1),
          fetchRow(inqId2),
          fetchRow(inqId3),
        ]);
        expect(r1?.emailAttempts).toBe(1);
        expect(r2?.emailAttempts).toBe(2);
        expect(r3?.emailAttempts).toBe(3);
        expect(r1?.emailLastAttemptAt).not.toBeNull();
        expect(r2?.emailLastAttemptAt).not.toBeNull();
        expect(r3?.emailLastAttemptAt).not.toBeNull();

        const countBefore = await getNoContactEmailInquiryCount();
        expect(countBefore).toBe(3);

        // ── Gallery owner saves a contact email → single bulk requeue ─────────

        await requeueNoContactEmailInquiries(tenantId);

        // Confirm all 3 rows are reset and still carry NO_CONTACT_EMAIL_ERROR.
        const [a1, a2, a3] = await Promise.all([
          fetchRow(inqId1),
          fetchRow(inqId2),
          fetchRow(inqId3),
        ]);
        expect(a1?.emailAttempts).toBe(0);
        expect(a2?.emailAttempts).toBe(0);
        expect(a3?.emailAttempts).toBe(0);
        expect(a1?.emailLastAttemptAt).toBeNull();
        expect(a2?.emailLastAttemptAt).toBeNull();
        expect(a3?.emailLastAttemptAt).toBeNull();
        // emailError stays intact so the sweep candidate query still selects the rows.
        expect(a1?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);
        expect(a2?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);
        expect(a3?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);

        // ── Persist the contact email so the sweep can deliver ────────────────

        await db
          .update(tenantsTable)
          .set({ contactEmail: "owner-961@gallery.test" })
          .where(eq(tenantsTable.id, tenantId));

        // ── Sweep runs with now = current wall time (no time-travel) ─────────
        //
        // emailLastAttemptAt is null for all 3 rows → backoff guard is skipped
        // entirely for each → all 3 emails are delivered in a single pass.

        sendArtworkInquiry.mockResolvedValue(true);
        const sweepResult = await sweepUnsentInquiryEmails(new Date(), tenantId);

        // All 3 rows have null emailLastAttemptAt → backoff guard skipped for
        // each → sendArtworkInquiry resolves successfully for every call.
        expect(sweepResult.scanned).toBe(3);
        expect(sweepResult.sent).toBe(3);
        expect(sweepResult.failed).toBe(0);
        expect(sweepResult.skipped).toBe(0);
        expect(sendArtworkInquiry).toHaveBeenCalledTimes(3);

        // ── All 3 rows are delivered ──────────────────────────────────────────

        const [f1, f2, f3] = await Promise.all([
          fetchRow(inqId1),
          fetchRow(inqId2),
          fetchRow(inqId3),
        ]);
        expect(f1?.emailError).toBeNull();
        expect(f2?.emailError).toBeNull();
        expect(f3?.emailError).toBeNull();
        expect(f1?.emailAttempts).toBe(1);
        expect(f2?.emailAttempts).toBe(1);
        expect(f3?.emailAttempts).toBe(1);

        // ── No-contact banner drops to 0 ──────────────────────────────────────

        const countAfter = await getNoContactEmailInquiryCount();
        expect(countAfter).toBe(0);
      },
    );

    /**
     * Task #964 — Confirm the sweep continues and delivers the remaining rows
     * when one sendArtworkInquiry call rejects mid-loop.
     *
     * Scenario:
     *  1. Seed 3 inquiries at emailAttempts=1 (with emailLastAttemptAt set to
     *     "just now") so all have NO_CONTACT_EMAIL_ERROR and are inside their
     *     backoff windows.
     *  2. Call requeueNoContactEmailInquiries — resets all 3 to
     *     emailAttempts=0, emailLastAttemptAt=null, ready to be swept.
     *  3. Persist a contact email on the tenant so the sweep can attempt delivery.
     *  4. Mock sendArtworkInquiry to reject on the 2nd call only.
     *  5. Run sweepUnsentInquiryEmails.
     *  6. Assert sweepResult: sent=2, failed=1, scanned=3.
     *  7. Assert DB state: the 2 successful rows have emailError=null; the
     *     failed row retains its transport error message.
     */
    it(
      "partial transport failure mid-sweep: sweep continues and delivers remaining rows (Task #964)",
      async () => {
        const tenantId = makeId("tenant-964");
        await insertTenant(tenantId); // no contactEmail

        const artworkId = makeId("artwork-964");
        await insertArtwork(artworkId, tenantId);

        const recentAt = new Date();

        const inqId1 = makeId("inq-964-a");
        const inqId2 = makeId("inq-964-b");
        const inqId3 = makeId("inq-964-c");

        await Promise.all([
          insertNoContactInquiry(inqId1, tenantId, artworkId, 1, recentAt),
          insertNoContactInquiry(inqId2, tenantId, artworkId, 1, recentAt),
          insertNoContactInquiry(inqId3, tenantId, artworkId, 1, recentAt),
        ]);

        mockSession.tenantId = tenantId;

        await requeueNoContactEmailInquiries(tenantId);

        await db
          .update(tenantsTable)
          .set({ contactEmail: "owner-964@gallery.test" })
          .where(eq(tenantsTable.id, tenantId));

        const transportError = new Error(
          "Transport failure: connection refused (964)",
        );
        sendArtworkInquiry
          .mockResolvedValueOnce(true)
          .mockRejectedValueOnce(transportError)
          .mockResolvedValueOnce(true);

        const sweepResult = await sweepUnsentInquiryEmails(new Date(), tenantId);

        // The sweep must continue past the mid-loop rejection.
        expect(sweepResult.scanned).toBe(3);
        expect(sweepResult.sent).toBe(2);
        expect(sweepResult.failed).toBe(1);
        expect(sweepResult.skipped).toBe(0);
        expect(sendArtworkInquiry).toHaveBeenCalledTimes(3);

        // ── DB state ──────────────────────────────────────────────────────────
        //
        // sweepUnsentInquiryEmails iterates the candidates in the order the DB
        // returns them.  We don't control which row is 2nd, so we check that
        // exactly 2 rows have emailError=null (success) and exactly 1 row
        // retains its error string (failure), regardless of insertion order.

        const [f1, f2, f3] = await Promise.all([
          fetchRow(inqId1),
          fetchRow(inqId2),
          fetchRow(inqId3),
        ]);

        const allRows = [f1, f2, f3];
        const successRows = allRows.filter((r) => r?.emailError === null);
        const failedRows = allRows.filter(
          (r) =>
            r?.emailError !== null &&
            r?.emailError !== NO_CONTACT_EMAIL_ERROR,
        );

        expect(successRows).toHaveLength(2);
        expect(failedRows).toHaveLength(1);

        for (const row of successRows) {
          expect(row?.emailError).toBeNull();
          expect(row?.emailAttempts).toBe(1);
        }

        // Failed row: emailError is the transport error message — non-null AND
        // distinct from NO_CONTACT_EMAIL_ERROR.  This is the property that makes
        // the no-contact banner count drop to 0 rather than 1.
        expect(failedRows[0]?.emailError).toBe(transportError.message);
        expect(failedRows[0]?.emailError).not.toBe(NO_CONTACT_EMAIL_ERROR);
        expect(failedRows[0]?.emailAttempts).toBe(1);
      },
    );

    /**
     * Task #953 — Confirm that requeueNoContactEmailInquiries clears the
     * backoff window so the freshly-requeued row is selected on the very next
     * sweep pass without any time-travel.
     *
     * Scenario:
     *  1. Seed an inquiry at emailAttempts=2 with emailLastAttemptAt set to
     *     "just now" — well inside the 10-minute backoff window for 2 attempts.
     *     Without the null-reset the sweep would skip the row.
     *  2. Gallery owner adds a contact email → requeueNoContactEmailInquiries
     *     resets emailAttempts→0 AND emailLastAttemptAt→null.
     *  3. sweepUnsentInquiryEmails is called with now = new Date() (no time-
     *     travel).  The null emailLastAttemptAt causes the backoff guard to be
     *     skipped entirely, so the row is claimed and the email is sent
     *     immediately.
     */
    it(
      "requeue clears backoff window; sweep sends the email immediately without time-travel (Task #953)",
      async () => {
        const tenantId = makeId("tenant-953");
        await insertTenant(tenantId); // no contactEmail

        const artworkId = makeId("artwork-953");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq-953");

        // Seed the inquiry at emailAttempts=2 with emailLastAttemptAt set to
        // "just now" so the row is firmly inside the backoff window for
        // 2 prior attempts (backoff = 10 minutes).  Without the null-reset
        // the sweep would skip this row on the next pass.
        const recentAttemptAt = new Date();
        await insertNoContactInquiry(inqId, tenantId, artworkId, 2, recentAttemptAt);

        mockSession.tenantId = tenantId;

        // ── Pre-condition: the row is inside the backoff window ───────────────

        const rowBefore = await fetchRow(inqId);
        expect(rowBefore?.emailAttempts).toBe(2);
        expect(rowBefore?.emailLastAttemptAt).not.toBeNull();
        expect(rowBefore?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);

        const noContactBefore = await getNoContactEmailInquiryCount();
        expect(noContactBefore).toBe(1);

        // ── Requeue ───────────────────────────────────────────────────────────
        //
        // Gallery owner saves their contact email.

        await requeueNoContactEmailInquiries(tenantId);

        const rowAfterRequeue = await fetchRow(inqId);
        expect(rowAfterRequeue?.emailAttempts).toBe(0);
        expect(rowAfterRequeue?.emailLastAttemptAt).toBeNull();
        // emailError must be preserved so the sweep still selects the row.
        expect(rowAfterRequeue?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);

        // No-contact badge still reflects the requeued row (emailError intact).
        const noContactAfterRequeue = await getNoContactEmailInquiryCount();
        expect(noContactAfterRequeue).toBe(1);

        // ── Persist the contact email so the sweep can deliver ────────────────

        await db
          .update(tenantsTable)
          .set({ contactEmail: "owner-953@gallery.test" })
          .where(eq(tenantsTable.id, tenantId));

        // ── Sweep runs with now = current wall time (no time-travel) ──────────
        //
        // emailLastAttemptAt is null → the backoff guard is skipped entirely →
        // the row is claimed and the email is delivered on this very pass.

        sendArtworkInquiry.mockResolvedValue(true);
        const sweepResult = await sweepUnsentInquiryEmails(new Date(), tenantId);

        expect(sweepResult.scanned).toBe(1);
        expect(sweepResult.sent).toBe(1);
        expect(sweepResult.failed).toBe(0);
        expect(sweepResult.skipped).toBe(0);
        expect(sendArtworkInquiry).toHaveBeenCalledTimes(1);

        // ── DB row confirms successful delivery ───────────────────────────────

        const rowFinal = await fetchRow(inqId);
        expect(rowFinal?.emailError).toBeNull();
        expect(rowFinal?.emailAttempts).toBe(1);

        // ── No-contact banner drops to 0 ──────────────────────────────────────

        const noContactAfter = await getNoContactEmailInquiryCount();
        expect(noContactAfter).toBe(0);
      },
    );

    /**
     * Task #972 — Confirm the no-contact banner count drops correctly when one
     * inquiry in a batch fails to send.
     *
     * getNoContactEmailInquiryCount drives the warning banner in the gallery
     * admin UI.  It counts rows where emailError = NO_CONTACT_EMAIL_ERROR.
     *
     * After a partial transport failure mid-sweep:
     *  • The 2 successfully sent rows get emailError = null → no longer counted.
     *  • The 1 failed row gets emailError = the transport error message (not
     *    NO_CONTACT_EMAIL_ERROR) → also no longer counted by the no-contact
     *    query.
     *
     * So the no-contact banner count drops from 3 to 0.  A regression that
     * accidentally leaves the failed row's emailError as NO_CONTACT_EMAIL_ERROR
     * (or forgets to update it at all) would cause the banner to show the
     * wrong number of stuck inquiries.
     *
     * Scenario (mirrors Task #964):
     *  1. Seed 3 inquiries at emailAttempts=1 with emailLastAttemptAt = "just
     *     now" — all inside their backoff windows, all with NO_CONTACT_EMAIL_ERROR.
     *  2. Call requeueNoContactEmailInquiries → resets all 3 to
     *     emailAttempts=0, emailLastAttemptAt=null; emailError stays intact.
     *  3. Persist a contact email so the sweep can attempt delivery.
     *  4. Mock sendArtworkInquiry: succeed, reject, succeed.
     *  5. Run sweepUnsentInquiryEmails; assert scanned=3, sent=2, failed=1.
     *  6. Call getNoContactEmailInquiryCount; assert it equals 0.
     *  7. Assert the failed row's emailError is non-null AND distinct from
     *     NO_CONTACT_EMAIL_ERROR (it holds the transport error message).
     */
    it(
      "no-contact banner count drops to 0 when 2 of 3 inquiries send and 1 fails mid-sweep (Task #972)",
      async () => {
        const tenantId = makeId("tenant-972");
        await insertTenant(tenantId); // no contactEmail

        const artworkId = makeId("artwork-972");
        await insertArtwork(artworkId, tenantId);

        const recentAt = new Date();

        const inqId1 = makeId("inq-972-a");
        const inqId2 = makeId("inq-972-b");
        const inqId3 = makeId("inq-972-c");

        await Promise.all([
          insertNoContactInquiry(inqId1, tenantId, artworkId, 1, recentAt),
          insertNoContactInquiry(inqId2, tenantId, artworkId, 1, recentAt),
          insertNoContactInquiry(inqId3, tenantId, artworkId, 1, recentAt),
        ]);

        mockSession.tenantId = tenantId;

        // ── Pre-condition: all 3 rows carry NO_CONTACT_EMAIL_ERROR ────────────

        const countBefore = await getNoContactEmailInquiryCount();
        expect(countBefore).toBe(3);

        // ── Gallery owner saves a contact email → single bulk requeue ─────────

        await requeueNoContactEmailInquiries(tenantId);

        // Confirm all 3 rows are reset and still carry NO_CONTACT_EMAIL_ERROR.
        const [a1, a2, a3] = await Promise.all([
          fetchRow(inqId1),
          fetchRow(inqId2),
          fetchRow(inqId3),
        ]);
        expect(a1?.emailAttempts).toBe(0);
        expect(a2?.emailAttempts).toBe(0);
        expect(a3?.emailAttempts).toBe(0);
        expect(a1?.emailLastAttemptAt).toBeNull();
        expect(a2?.emailLastAttemptAt).toBeNull();
        expect(a3?.emailLastAttemptAt).toBeNull();
        expect(a1?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);
        expect(a2?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);
        expect(a3?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);

        // No-contact count still 3 after requeue — emailError is preserved.
        const countAfterRequeue = await getNoContactEmailInquiryCount();
        expect(countAfterRequeue).toBe(3);

        // ── Persist the contact email so the sweep can attempt delivery ────────

        await db
          .update(tenantsTable)
          .set({ contactEmail: "owner-972@gallery.test" })
          .where(eq(tenantsTable.id, tenantId));

        // ── Mock transport: succeed for calls 1 and 3; reject for call 2 ──────

        const transportError = new Error(
          "Transport failure: connection refused (972)",
        );
        sendArtworkInquiry
          .mockResolvedValueOnce(true)
          .mockRejectedValueOnce(transportError)
          .mockResolvedValueOnce(true);

        // ── Sweep runs ────────────────────────────────────────────────────────

        const sweepResult = await sweepUnsentInquiryEmails(new Date(), tenantId);

        // The sweep must continue past the mid-loop rejection.
        expect(sweepResult.scanned).toBe(3);
        expect(sweepResult.sent).toBe(2);
        expect(sweepResult.failed).toBe(1);
        expect(sweepResult.skipped).toBe(0);
        expect(sendArtworkInquiry).toHaveBeenCalledTimes(3);

        // ── No-contact banner count drops to 0 ───────────────────────────────
        //
        // All three rows have left the NO_CONTACT_EMAIL_ERROR state:
        //  • The 2 successful rows have emailError = null.
        //  • The 1 failed row has emailError = transport error message (not
        //    NO_CONTACT_EMAIL_ERROR), so it is also excluded from this count.
        // A regression that forgets to update the failed row's emailError, or
        // accidentally keeps it as NO_CONTACT_EMAIL_ERROR, would cause this
        // assertion to fail.

        const countAfterSweep = await getNoContactEmailInquiryCount();
        expect(countAfterSweep).toBe(0);

        // ── DB state ──────────────────────────────────────────────────────────

        const [f1, f2, f3] = await Promise.all([
          fetchRow(inqId1),
          fetchRow(inqId2),
          fetchRow(inqId3),
        ]);

        const allRows = [f1, f2, f3];
        const successRows = allRows.filter((r) => r?.emailError === null);
        const failedRows = allRows.filter(
          (r) =>
            r?.emailError !== null &&
            r?.emailError !== NO_CONTACT_EMAIL_ERROR,
        );

        expect(successRows).toHaveLength(2);
        expect(failedRows).toHaveLength(1);

        // Successful rows: emailError cleared, attempts incremented.
        for (const row of successRows) {
          expect(row?.emailError).toBeNull();
          expect(row?.emailAttempts).toBe(1);
        }

        // Failed row: emailError is the transport error message — non-null AND
        // distinct from NO_CONTACT_EMAIL_ERROR.  This is the property that makes
        // the no-contact banner count drop to 0 rather than 1.
        expect(failedRows[0]?.emailError).toBe(transportError.message);
        expect(failedRows[0]?.emailError).not.toBe(NO_CONTACT_EMAIL_ERROR);
        expect(failedRows[0]?.emailAttempts).toBe(1);
      },
    );

    /**
     * Task #982 — Confirm the transport-error inquiry re-enters the sweep after
     * an admin retry, not the no-contact queue.
     *
     * After a partial transport failure mid-sweep, the failed inquiry has
     * emailError = transport error message (NOT NO_CONTACT_EMAIL_ERROR).
     * When an admin calls retrySmtpErrorInquiries, that row should re-enter
     * the sweep candidate set — but it must NOT be counted by
     * getNoContactEmailInquiryCount, which only tracks the no-contact sentinel.
     *
     * Scenario:
     *  1. Seed a tenant with a contact email and 3 inquiries at emailAttempts=0,
     *     emailError=NO_CONTACT_EMAIL_ERROR (ready for the sweep to attempt).
     *  2. Run sweepUnsentInquiryEmails with 2 successes and 1 transport failure:
     *     scanned=3, sent=2, failed=1.
     *  3. Assert the failed row has emailError = transport error message (not
     *     NO_CONTACT_EMAIL_ERROR) and emailAttempts=1.
     *  4. Assert getNoContactEmailInquiryCount is 0 — the failed row escaped
     *     the no-contact sentinel.
     *  5. Call retrySmtpErrorInquiries — resets emailAttempts→0,
     *     emailLastAttemptAt→null for the failed row; emailError is preserved.
     *  6. Assert getNoContactEmailInquiryCount is still 0 (the retry must not
     *     flip emailError to NO_CONTACT_EMAIL_ERROR).
     *  7. Run sweepUnsentInquiryEmails again; assert the failed row is
     *     re-selected and the email is delivered: scanned=1, sent=1.
     */
    it(
      "transport-error inquiry re-enters sweep after retrySmtpErrorInquiries; getNoContactEmailInquiryCount stays 0 (Task #982)",
      async () => {
        const tenantId = makeId("tenant-982");
        // Tenant has a contact email from the start so the sweep attempts delivery.
        await insertTenant(tenantId, { contactEmail: "owner-982@gallery.test" });

        const artworkId = makeId("artwork-982");
        await insertArtwork(artworkId, tenantId);

        // Seed 3 inquiries with emailError = NO_CONTACT_EMAIL_ERROR at
        // emailAttempts=0, emailLastAttemptAt=null.  Even though the tenant now
        // has a contact email, the rows still have the sentinel set (they were
        // recorded before the email was added).  sweepUnsentInquiryEmails will
        // see: emailError IS NOT NULL, emailAttempts < MAX → candidate.  Because
        // the tenant's contactEmail is set, the sweep reaches the delivery path
        // and calls sendArtworkInquiry.
        const inqId1 = makeId("inq-982-a");
        const inqId2 = makeId("inq-982-b");
        const inqId3 = makeId("inq-982-c");

        await Promise.all([
          insertNoContactInquiry(inqId1, tenantId, artworkId, 0, null),
          insertNoContactInquiry(inqId2, tenantId, artworkId, 0, null),
          insertNoContactInquiry(inqId3, tenantId, artworkId, 0, null),
        ]);

        mockSession.tenantId = tenantId;

        // ── Pre-condition: all 3 rows carry NO_CONTACT_EMAIL_ERROR ────────────

        const countBefore = await getNoContactEmailInquiryCount();
        expect(countBefore).toBe(3);

        // ── Sweep pass 1: 2 succeed, 1 fails with a transport error ───────────

        const transportError = new Error(
          "Transport failure: connection refused (982)",
        );
        sendArtworkInquiry
          .mockResolvedValueOnce(true)
          .mockRejectedValueOnce(transportError)
          .mockResolvedValueOnce(true);

        const sweep1 = await sweepUnsentInquiryEmails(new Date(), tenantId);

        expect(sweep1.scanned).toBe(3);
        expect(sweep1.sent).toBe(2);
        expect(sweep1.failed).toBe(1);
        expect(sweep1.skipped).toBe(0);
        expect(sendArtworkInquiry).toHaveBeenCalledTimes(3);

        // ── DB state after sweep 1 ────────────────────────────────────────────

        const [p1, p2, p3] = await Promise.all([
          fetchRow(inqId1),
          fetchRow(inqId2),
          fetchRow(inqId3),
        ]);

        const allRows = [p1, p2, p3];
        const successRows = allRows.filter((r) => r?.emailError === null);
        const failedRows = allRows.filter(
          (r) =>
            r?.emailError !== null &&
            r?.emailError !== NO_CONTACT_EMAIL_ERROR,
        );

        expect(successRows).toHaveLength(2);
        expect(failedRows).toHaveLength(1);

        // The failed row carries the transport error message — never NO_CONTACT_EMAIL_ERROR.
        expect(failedRows[0]?.emailError).toBe(transportError.message);
        expect(failedRows[0]?.emailError).not.toBe(NO_CONTACT_EMAIL_ERROR);
        expect(failedRows[0]?.emailAttempts).toBe(1);

        // ── getNoContactEmailInquiryCount must be 0 after sweep 1 ─────────────
        //
        // All 3 rows have left the NO_CONTACT_EMAIL_ERROR state:
        //  • 2 successful rows: emailError = null.
        //  • 1 failed row: emailError = transport error message.
        // Neither is the no-contact sentinel, so the count must be 0.

        const countAfterSweep1 = await getNoContactEmailInquiryCount();
        expect(countAfterSweep1).toBe(0);

        // ── Admin calls retrySmtpErrorInquiries ───────────────────────────────
        //
        // Resets the failed row: emailAttempts→0, emailLastAttemptAt→null.
        // emailError is preserved (still the transport error message) so the
        // sweep candidate query (isNotNull emailError) still selects the row.
        // Rows with emailError = null (the 2 successful rows) are NOT touched.

        const resetCount = await retrySmtpErrorInquiries(tenantId);
        expect(resetCount).toBe(1);

        const failedRowAfterRetry = await fetchRow(failedRows[0]!.id);
        expect(failedRowAfterRetry?.emailAttempts).toBe(0);
        expect(failedRowAfterRetry?.emailLastAttemptAt).toBeNull();
        // emailError must be preserved — not cleared, not changed to NO_CONTACT_EMAIL_ERROR.
        expect(failedRowAfterRetry?.emailError).toBe(transportError.message);
        expect(failedRowAfterRetry?.emailError).not.toBe(NO_CONTACT_EMAIL_ERROR);

        // ── getNoContactEmailInquiryCount is still 0 after retry ──────────────
        //
        // retrySmtpErrorInquiries must NOT flip emailError to NO_CONTACT_EMAIL_ERROR.
        // The failed row must never enter the no-contact queue.

        const countAfterRetry = await getNoContactEmailInquiryCount();
        expect(countAfterRetry).toBe(0);

        // ── Sweep pass 2: the failed row is re-selected and delivered ─────────
        //
        // emailAttempts=0 < MAX_EMAIL_ATTEMPTS → candidate.
        // emailLastAttemptAt=null → backoff guard is skipped.
        // The 2 successful rows have emailError=null → not selected (isNotNull guard).

        sendArtworkInquiry.mockResolvedValue(true);
        const sweep2 = await sweepUnsentInquiryEmails(new Date(), tenantId);

        expect(sweep2.scanned).toBe(1);
        expect(sweep2.sent).toBe(1);
        expect(sweep2.failed).toBe(0);
        expect(sweep2.skipped).toBe(0);

        // ── DB: failed row is now delivered ───────────────────────────────────

        const finalRow = await fetchRow(failedRows[0]!.id);
        expect(finalRow?.emailError).toBeNull();
        expect(finalRow?.emailAttempts).toBe(1);

        // ── No-contact count unchanged ────────────────────────────────────────

        const countFinal = await getNoContactEmailInquiryCount();
        expect(countFinal).toBe(0);
      },
    );

    /**
     * Task #960 — Confirm a row requeued twice in a row (with a recent
     * emailLastAttemptAt that would normally keep it inside the backoff window)
     * still sends immediately on the next sweep.
     *
     * requeueNoContactEmailInquiries is idempotent — calling it twice should
     * leave the row in the same ready state as calling it once.  In particular,
     * both calls must clear emailLastAttemptAt to null even when the first call
     * already set it to null.  A second reset on an already-clean row must be a
     * no-op; it must not re-introduce a backoff timestamp.
     *
     * Scenario:
     *  1. Seed an inquiry at emailAttempts=2 with emailLastAttemptAt = now
     *     (firmly inside the 10-minute backoff window for 2 attempts).
     *  2. Call requeueNoContactEmailInquiries twice (simulating a gallery owner
     *     saving settings twice in quick succession).
     *  3. Assert emailAttempts=0 and emailLastAttemptAt=null after both calls.
     *  4. Add a contact email and sweep; assert sent=1, skipped=0 — the email
     *     is delivered on the very next pass without any time-travel.
     */
    it(
      "double requeue with a recent backoff timestamp leaves row at 0/null; sweep sends immediately (Task #960)",
      async () => {
        const tenantId = makeId("tenant-960");
        await insertTenant(tenantId); // no contactEmail

        const artworkId = makeId("artwork-960");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq-960");

        // Seed the inquiry at emailAttempts=2 with emailLastAttemptAt set to
        // "just now" so the row is firmly inside the backoff window for
        // 2 prior attempts (backoff = 10 minutes).  Without the null-reset
        // the sweep would skip this row on the next pass.
        const recentAttemptAt = new Date();
        await insertNoContactInquiry(inqId, tenantId, artworkId, 2, recentAttemptAt);

        mockSession.tenantId = tenantId;

        // ── Pre-condition: the row is inside the backoff window ───────────────

        const rowBefore = await fetchRow(inqId);
        expect(rowBefore?.emailAttempts).toBe(2);
        expect(rowBefore?.emailLastAttemptAt).not.toBeNull();
        expect(rowBefore?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);

        const noContactBefore = await getNoContactEmailInquiryCount();
        expect(noContactBefore).toBe(1);

        // ── First requeue ─────────────────────────────────────────────────────
        //
        // Gallery owner saves their contact email for the first time.

        await requeueNoContactEmailInquiries(tenantId);

        const rowAfterFirst = await fetchRow(inqId);
        expect(rowAfterFirst?.emailAttempts).toBe(0);
        expect(rowAfterFirst?.emailLastAttemptAt).toBeNull();
        // emailError must be preserved so the sweep still selects the row.
        expect(rowAfterFirst?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);

        // ── Second requeue ────────────────────────────────────────────────────
        //
        // Gallery owner immediately changes to a different email address,
        // triggering a second requeueNoContactEmailInquiries call.  The row is
        // already at emailAttempts=0 / emailLastAttemptAt=null — the second
        // call must be a no-op (0→0, null→null) and must NOT re-introduce a
        // backoff timestamp.

        await requeueNoContactEmailInquiries(tenantId);

        const rowAfterSecond = await fetchRow(inqId);
        // Both must still be at the clean, ready state.
        expect(rowAfterSecond?.emailAttempts).toBe(0);
        expect(rowAfterSecond?.emailLastAttemptAt).toBeNull();
        expect(rowAfterSecond?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);

        // No-contact badge still reflects the requeued row (emailError intact).
        const noContactAfterRequeue = await getNoContactEmailInquiryCount();
        expect(noContactAfterRequeue).toBe(1);

        // ── Persist the contact email so the sweep can deliver ────────────────

        await db
          .update(tenantsTable)
          .set({ contactEmail: "owner-960@gallery.test" })
          .where(eq(tenantsTable.id, tenantId));

        // ── Sweep runs with now = current wall time (no time-travel) ──────────
        //
        // emailLastAttemptAt is null → the backoff guard is skipped entirely →
        // the row is claimed and the email is delivered on this very pass.
        // skipped must be 0 — a non-zero skipped would mean a backoff timestamp
        // crept back in during the second requeue.

        sendArtworkInquiry.mockResolvedValue(true);
        const sweepResult = await sweepUnsentInquiryEmails(new Date(), tenantId);

        expect(sweepResult.scanned).toBe(1);
        expect(sweepResult.sent).toBe(1);
        expect(sweepResult.failed).toBe(0);
        expect(sweepResult.skipped).toBe(0);
        expect(sendArtworkInquiry).toHaveBeenCalledTimes(1);

        // ── DB row confirms successful delivery ───────────────────────────────

        const rowFinal = await fetchRow(inqId);
        expect(rowFinal?.emailError).toBeNull();
        expect(rowFinal?.emailAttempts).toBe(1);

        // ── No-contact banner drops to 0 ──────────────────────────────────────

        const noContactAfter = await getNoContactEmailInquiryCount();
        expect(noContactAfter).toBe(0);
      },
    );

    /**
     * Task #953 — Confirm that requeueNoContactEmailInquiries clears the
     * backoff window so the freshly-requeued row is selected on the very next
     * sweep pass without any time-travel.
     *
     * Scenario:
     *  1. Seed an inquiry at emailAttempts=2 with emailLastAttemptAt set to
     *     "just now" — well inside the 10-minute backoff window for 2 attempts.
     *     Without the null-reset the sweep would skip the row.
     *  2. Gallery owner adds a contact email → requeueNoContactEmailInquiries
     *     resets emailAttempts→0 AND emailLastAttemptAt→null.
     *  3. sweepUnsentInquiryEmails is called with now = new Date() (no time-
     *     travel).  The null emailLastAttemptAt causes the backoff guard to be
     *     skipped entirely, so the row is claimed and the email is sent
     *     immediately.
     */
    it(
      "requeue clears backoff window; sweep sends the email immediately without time-travel (Task #953)",
      async () => {
        const tenantId = makeId("tenant-953");
        // Start with NO contact email — the inquiry will have NO_CONTACT_EMAIL_ERROR.
        await insertTenant(tenantId);

        const artworkId = makeId("artwork-953");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq-953");

        // Seed the inquiry at emailAttempts=2 with emailLastAttemptAt set to
        // "just now" so the row is firmly inside the backoff window for
        // 2 prior attempts (backoff = 10 minutes).  Without the null-reset
        // the sweep would skip this row on the next pass.
        const recentAttemptAt = new Date();
        await insertNoContactInquiry(inqId, tenantId, artworkId, 2, recentAttemptAt);

        mockSession.tenantId = tenantId;

        // ── Pre-condition: the row is inside the backoff window ───────────────

        const rowBefore = await fetchRow(inqId);
        expect(rowBefore?.emailAttempts).toBe(2);
        expect(rowBefore?.emailLastAttemptAt).not.toBeNull();
        expect(rowBefore?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);

        // ── Gallery owner saves their contact email → requeue fires ───────────

        await requeueNoContactEmailInquiries(tenantId);

        const rowAfterRequeue = await fetchRow(inqId);
        // emailAttempts and emailLastAttemptAt are both reset.
        expect(rowAfterRequeue?.emailAttempts).toBe(0);
        expect(rowAfterRequeue?.emailLastAttemptAt).toBeNull();
        // emailError is preserved so the sweep candidate query still selects it.
        expect(rowAfterRequeue?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);

        // ── Persist the contact email so the sweep can deliver ────────────────

        await db
          .update(tenantsTable)
          .set({ contactEmail: "owner-953@gallery.test" })
          .where(eq(tenantsTable.id, tenantId));

        // ── Sweep runs with now = current wall time (no time-travel) ─────────
        //
        // emailLastAttemptAt is null → the backoff guard is skipped entirely →
        // the row is claimed and the email is delivered on this very pass.

        sendArtworkInquiry.mockResolvedValue(true);
        const sweepResult = await sweepUnsentInquiryEmails(new Date(), tenantId);

        expect(sweepResult.scanned).toBe(1);
        expect(sweepResult.sent).toBe(1);
        expect(sweepResult.failed).toBe(0);
        expect(sweepResult.skipped).toBe(0);
        expect(sendArtworkInquiry).toHaveBeenCalledTimes(1);

        // ── DB row confirms successful delivery ───────────────────────────────

        const rowFinal = await fetchRow(inqId);
        expect(rowFinal?.emailError).toBeNull();
        expect(rowFinal?.emailAttempts).toBe(1);

        // ── No-contact banner drops to 0 ──────────────────────────────────────

        const noContactAfter = await getNoContactEmailInquiryCount();
        expect(noContactAfter).toBe(0);
      },
    );

    /**
     * Task #981 — Confirm the no-contact banner count drops correctly when
     * archived inquiries are excluded from a partial-failure sweep.
     *
     * getNoContactEmailInquiryCount already filters out archived rows
     * (archivedAt IS NULL).  sweepUnsentInquiryEmails must also skip archived
     * rows so that a batch containing a mix of live and archived inquiries
     * produces the right scanned count, and the banner count reflects only
     * the live unarchived rows after the sweep completes.
     *
     * Scenario:
     *  1. Seed 3 inquiries at emailAttempts=0 / emailLastAttemptAt=null, all
     *     with NO_CONTACT_EMAIL_ERROR.
     *  2. Archive 1 of them (set archivedAt = now).
     *  3. Verify getNoContactEmailInquiryCount = 2 (archived row excluded).
     *  4. Persist a contact email on the tenant so the sweep can deliver.
     *  5. Run sweepUnsentInquiryEmails → scanned=2 (archived row not selected),
     *     sent=2, failed=0.
     *  6. Assert getNoContactEmailInquiryCount drops to 0.
     *  7. Assert the archived row's emailError is still NO_CONTACT_EMAIL_ERROR
     *     (the sweep left it untouched).
     */
    it(
      "archived inquiry is excluded from sweep scan and banner count reflects only live rows (Task #981)",
      async () => {
        const tenantId = makeId("tenant-981");
        // Insert tenant with a contact email already set so the sweep can
        // attempt delivery immediately — no requeue needed.
        await insertTenant(tenantId, {
          contactEmail: "owner-981@gallery.test",
        });

        const artworkId = makeId("artwork-981");
        await insertArtwork(artworkId, tenantId);

        // Seed 3 inquiries: all have NO_CONTACT_EMAIL_ERROR, emailAttempts=0,
        // emailLastAttemptAt=null → ready to be swept immediately.
        const inqId1 = makeId("inq-981-a");
        const inqId2 = makeId("inq-981-b");
        const inqId3 = makeId("inq-981-c");

        await Promise.all([
          insertNoContactInquiry(inqId1, tenantId, artworkId, 0, null),
          insertNoContactInquiry(inqId2, tenantId, artworkId, 0, null),
          insertNoContactInquiry(inqId3, tenantId, artworkId, 0, null),
        ]);

        mockSession.tenantId = tenantId;

        // ── Pre-condition: all 3 are counted before archiving ─────────────────

        const countBefore = await getNoContactEmailInquiryCount();
        expect(countBefore).toBe(3);

        // ── Archive 1 inquiry ─────────────────────────────────────────────────
        //
        // Simulates the gallery owner archiving a resolved lead while the
        // sweep is yet to run.  The archived row should be excluded both from
        // the sweep's candidate set and from the banner count.

        const archivedAt = new Date();
        await db
          .update(inquiriesTable)
          .set({ archivedAt })
          .where(eq(inquiriesTable.id, inqId3));

        // ── Banner count drops to 2 immediately after archiving ───────────────

        const countAfterArchive = await getNoContactEmailInquiryCount();
        expect(countAfterArchive).toBe(2);

        // ── Sweep runs ────────────────────────────────────────────────────────
        //
        // sweepUnsentInquiryEmails must filter out archived rows — only the 2
        // live inquiries (inqId1, inqId2) should appear in the candidate set.

        sendArtworkInquiry.mockResolvedValue(true);
        const sweepResult = await sweepUnsentInquiryEmails(new Date(), tenantId);

        // scanned=2 proves the archived row was excluded from the candidate query.
        expect(sweepResult.scanned).toBe(2);
        expect(sweepResult.sent).toBe(2);
        expect(sweepResult.failed).toBe(0);
        expect(sweepResult.skipped).toBe(0);
        expect(sendArtworkInquiry).toHaveBeenCalledTimes(2);

        // ── Banner count drops to 0 ───────────────────────────────────────────
        //
        // The 2 live rows now have emailError = null (delivered), so the
        // no-contact count is 0.  The archived row is still excluded regardless
        // of its emailError value.

        const countAfterSweep = await getNoContactEmailInquiryCount();
        expect(countAfterSweep).toBe(0);

        // ── DB state ──────────────────────────────────────────────────────────

        const [f1, f2, f3] = await Promise.all([
          fetchRow(inqId1),
          fetchRow(inqId2),
          fetchRow(inqId3),
        ]);

        // Live rows were delivered: emailError cleared, emailAttempts incremented.
        expect(f1?.emailError).toBeNull();
        expect(f1?.emailAttempts).toBe(1);
        expect(f2?.emailError).toBeNull();
        expect(f2?.emailAttempts).toBe(1);

        // Archived row was NOT touched by the sweep: emailError and
        // emailAttempts are unchanged from their seeded values.
        expect(f3?.archivedAt).not.toBeNull();
        expect(f3?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);
        expect(f3?.emailAttempts).toBe(0);
      },
    );

    /**
     * Task #969 — Confirm a requeue that fires between a sweep's CAS claim and
     * its email send cannot cause a double-send.
     *
     * The sweep atomically claims a row by writing emailLastAttemptAt + a UUID
     * nonce (emailClaimNonce).  requeueNoContactEmailInquiries now skips any
     * row whose emailClaimNonce IS NOT NULL, so a concurrent gallery-email save
     * cannot reset emailLastAttemptAt→null and make the in-flight row
     * re-claimable by a second sweep pass.
     *
     * This test exercises the actual concurrent window using Promise
     * coordination: sweep A is held inside the transport (post-claim, pre-
     * success-write), the requeue fires and should skip the claimed row, sweep B
     * runs and should be blocked by the backoff guard (emailLastAttemptAt is
     * recent) and by the CAS nonce condition, then sweep A is released and
     * completes normally.  sendArtworkInquiry must be called exactly once.
     *
     * Flow under test:
     *  1. Seed a tenant WITH a contact email and an inquiry in the requeued
     *     no-contact state (emailError set, emailAttempts=0,
     *     emailLastAttemptAt=null).
     *  2. Block sweep A inside the transport mock after its CAS claim succeeds.
     *  3. Fire requeueNoContactEmailInquiries — it must skip the claimed row.
     *  4. Run sweep B — it must be blocked (backoff + nonce CAS fail).
     *  5. Release sweep A — it completes, clears emailError and emailClaimNonce.
     *  6. Assert sendArtworkInquiry was called exactly once and emailError=null.
     */
    it(
      "sends the email exactly once when requeue fires between CAS claim and success write (Task #969)",
      { timeout: 30_000 },
      async () => {
        // ── Seed ─────────────────────────────────────────────────────────────

        const tenantId = makeId("tenant-969");
        const artworkId = makeId("artwork-969");
        const inqId = makeId("inq-969");

        // Tenant already has a contact email so the sweep proceeds past the
        // no-email guard to the CAS claim.
        await insertTenant(tenantId, {
          contactEmail: "gallery-969@test.example",
        });
        await insertArtwork(artworkId, tenantId);

        // Inquiry is in the requeued no-contact state: emailError is set (so
        // the sweep candidate query selects it), emailAttempts=0 and
        // emailLastAttemptAt=null (so the backoff guard is skipped).
        CREATED_INQUIRY_IDS.push(inqId);
        await db.insert(inquiriesTable).values({
          id: inqId,
          tenantId,
          artworkId,
          artworkTitle: "Test Artwork 969",
          buyerName: "Race Buyer 969",
          buyerEmail: "buyer-969@test.example",
          message: "Is this available?",
          emailError: NO_CONTACT_EMAIL_ERROR,
          emailAttempts: 0,
          emailLastAttemptAt: null,
          status: "NEW",
        } as any);

        mockSession.tenantId = tenantId;

        // ── Pre-condition checks ──────────────────────────────────────────────

        const rowBefore = await fetchRow(inqId);
        expect(rowBefore?.emailAttempts).toBe(0);
        expect(rowBefore?.emailLastAttemptAt).toBeNull();
        expect(rowBefore?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);
        expect((rowBefore as any)?.emailClaimNonce).toBeNull();

        // ── Concurrent race setup ─────────────────────────────────────────────
        //
        // Use a Promise pair to hold sweep A inside its transport call (after
        // the CAS claim has committed to the DB) until we have verified that
        // (a) the requeue skips the claimed row, and (b) a concurrent sweep B
        // cannot re-claim and double-send.

        let releaseSweepA!: () => void;
        const sweepABlocker = new Promise<void>((res) => {
          releaseSweepA = res;
        });
        const sweepATransportEntered = new Promise<void>((resolve) => {
          sendArtworkInquiry.mockImplementationOnce(async () => {
            resolve(); // signal: CAS claim is in the DB, we are mid-send
            await sweepABlocker; // hold here until released
            return true;
          });
        });
        // If sweep B somehow gets through (it must not), give it a mock too.
        sendArtworkInquiry.mockResolvedValue(true);

        // ── Start sweep A (do not await) ──────────────────────────────────────

        const sweepADone = sweepUnsentInquiryEmails(new Date(), tenantId);

        // Wait until sweep A has entered the transport (= CAS claim in DB).
        await sweepATransportEntered;

        // ── Verify CAS claim is visible in the DB ─────────────────────────────

        const rowMid = await fetchRow(inqId);
        // emailLastAttemptAt and emailClaimNonce were both stamped by the CAS.
        expect(rowMid?.emailLastAttemptAt).not.toBeNull();
        expect((rowMid as any)?.emailClaimNonce).not.toBeNull();
        // emailError is still set (success write has not fired yet).
        expect(rowMid?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);

        // ── Fire requeue — should skip the claimed row ────────────────────────
        //
        // The gallery owner saves a new contact email while sweep A is blocked
        // mid-send.  With the emailClaimNonce guard in place, the requeue's
        // WHERE clause includes isNull(emailClaimNonce) and therefore leaves
        // the row untouched.

        await requeueNoContactEmailInquiries(tenantId);

        const rowAfterRequeue = await fetchRow(inqId);
        // Requeue skipped the row: emailLastAttemptAt and emailClaimNonce must
        // still be the values set by sweep A's CAS claim.
        expect(rowAfterRequeue?.emailLastAttemptAt).toEqual(
          rowMid?.emailLastAttemptAt,
        );
        expect((rowAfterRequeue as any)?.emailClaimNonce).toEqual(
          (rowMid as any)?.emailClaimNonce,
        );

        // ── Run sweep B — must not send ───────────────────────────────────────
        //
        // Sweep B sees emailLastAttemptAt=T1 (recent, within the BASE_BACKOFF_MS
        // window) and emailClaimNonce≠null.  The backoff guard skips the row
        // before the CAS is even attempted.

        const sweepBResult = await sweepUnsentInquiryEmails(new Date(), tenantId);

        expect(sweepBResult.sent).toBe(0);
        // Row was scanned (emailError still non-null) but skipped by backoff.
        expect(sweepBResult.scanned).toBe(1);
        expect(sweepBResult.skipped).toBe(1);
        // Transport was not invoked by sweep B.
        expect(sendArtworkInquiry).toHaveBeenCalledTimes(1);

        // ── Release sweep A ───────────────────────────────────────────────────

        releaseSweepA();
        const sweepAResult = await sweepADone;

        // Sweep A delivered successfully.
        expect(sweepAResult.sent).toBe(1);
        expect(sweepAResult.failed).toBe(0);

        // ── Final DB state ────────────────────────────────────────────────────

        const rowFinal = await fetchRow(inqId);
        expect(rowFinal?.emailError).toBeNull();
        expect(rowFinal?.emailAttempts).toBe(1);
        // Claim nonce released by the success write.
        expect((rowFinal as any)?.emailClaimNonce).toBeNull();

        // ── Second sweep: no double-send ──────────────────────────────────────

        const secondSweep = await sweepUnsentInquiryEmails(new Date(), tenantId);
        expect(secondSweep.scanned).toBe(0);
        expect(sendArtworkInquiry).toHaveBeenCalledTimes(1); // still 1
      },
    );

    /**
     * Task #969 — Expired-claim recovery: a row left with a non-null
     * emailClaimNonce and an old emailLastAttemptAt (worker crashed before
     * either completion write) must become deliverable again.
     *
     * Two recovery paths are exercised:
     *  A. requeueNoContactEmailInquiries resets the row when the claim is
     *     expired (emailLastAttemptAt < now − CLAIM_LEASE_MS).
     *  B. A fresh sweep can reclaim an expired-claim row via the CAS (the
     *     claim-expiry branch in the WHERE clause) and deliver it.
     */
    it(
      "recovers a row whose sweep claim expired (worker crash simulation) (Task #969)",
      { timeout: 30_000 },
      async () => {
        // ── Seed ─────────────────────────────────────────────────────────────

        const tenantId = makeId("tenant-969b");
        const artworkId = makeId("artwork-969b");
        const inqId = makeId("inq-969b");

        await insertTenant(tenantId, {
          contactEmail: "gallery-969b@test.example",
        });
        await insertArtwork(artworkId, tenantId);
        CREATED_INQUIRY_IDS.push(inqId);

        // Simulate a crashed-worker scenario: the row was claimed (both
        // emailClaimNonce and emailLastAttemptAt are set) but the worker died
        // before issuing either the success or failure completion write.
        // emailLastAttemptAt is set far enough in the past to exceed
        // CLAIM_LEASE_MS so the claim is treated as expired.
        const expiredClaimAt = new Date(Date.now() - CLAIM_LEASE_MS - 60_000);
        const staleCrashNonce = "stale-nonce-from-crashed-worker";

        await db.insert(inquiriesTable).values({
          id: inqId,
          tenantId,
          artworkId,
          artworkTitle: "Test Artwork 969b",
          buyerName: "Race Buyer 969b",
          buyerEmail: "buyer-969b@test.example",
          message: "Is this available?",
          emailError: NO_CONTACT_EMAIL_ERROR,
          emailAttempts: 0,
          emailLastAttemptAt: expiredClaimAt,
          status: "NEW",
        } as any);

        // Manually stamp the stale nonce as if a previous worker died mid-claim.
        await db
          .update(inquiriesTable)
          .set({ emailClaimNonce: staleCrashNonce } as any)
          .where(eq(inquiriesTable.id, inqId));

        mockSession.tenantId = tenantId;

        // ── Pre-condition: claim is visible but expired ───────────────────────

        const rowBefore = await fetchRow(inqId);
        expect((rowBefore as any)?.emailClaimNonce).toBe(staleCrashNonce);
        expect(rowBefore?.emailLastAttemptAt).toEqual(expiredClaimAt);
        expect(rowBefore?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);

        // ── Path A: requeue resets an expired-claim row ───────────────────────
        //
        // requeueNoContactEmailInquiries should NOT skip this row even though
        // emailClaimNonce is non-null, because emailLastAttemptAt is older than
        // CLAIM_LEASE_MS (the claim is expired / abandoned).

        await requeueNoContactEmailInquiries(tenantId);

        const rowAfterRequeue = await fetchRow(inqId);
        // Expired claim → requeue was allowed to reset it.
        expect(rowAfterRequeue?.emailAttempts).toBe(0);
        expect(rowAfterRequeue?.emailLastAttemptAt).toBeNull();
        // Note: requeue only resets emailAttempts and emailLastAttemptAt; the
        // stale nonce is cleared by the sweep's completion write, not here.

        // ── Path B: fresh sweep delivers after the requeue ────────────────────

        sendArtworkInquiry.mockResolvedValue(true);
        const sweepResult = await sweepUnsentInquiryEmails(new Date(), tenantId);

        expect(sweepResult.sent).toBe(1);
        expect(sweepResult.scanned).toBe(1);
        expect(sendArtworkInquiry).toHaveBeenCalledTimes(1);

        // ── Final DB state ────────────────────────────────────────────────────

        const rowFinal = await fetchRow(inqId);
        expect(rowFinal?.emailError).toBeNull();
        expect(rowFinal?.emailAttempts).toBe(1);
        // Sweep's completion write cleared the nonce (regardless of whether it
        // was the stale or a newly-issued one).
        expect((rowFinal as any)?.emailClaimNonce).toBeNull();
      },
    );

    /**
     * Task #968 — Confirm archived inquiries are not re-queued when the
     * gallery adds a contact email.
     *
     * requeueNoContactEmailInquiries must guard against resurrecting rows that
     * the gallery owner explicitly archived.  An archived inquiry carries
     * archivedAt IS NOT NULL; without an explicit isNull(archivedAt) filter in
     * the UPDATE's WHERE clause the reset would silently reactivate it and the
     * next sweep pass would deliver an email the gallery owner already decided
     * not to receive.
     *
     * Flow:
     *  1. Seed one ARCHIVED inquiry and one ACTIVE inquiry for the same tenant,
     *     both with emailError=NO_CONTACT_EMAIL_ERROR and emailAttempts=2.
     *  2. Call requeueNoContactEmailInquiries — only the active row may be reset.
     *  3. Assert archived row is completely untouched (emailAttempts still 2,
     *     emailLastAttemptAt unchanged).
     *  4. Assert active row is reset to emailAttempts=0, emailLastAttemptAt=null.
     *  5. Add a contact email to the tenant and run sweepUnsentInquiryEmails.
     *  6. Assert sent=1 (active inquiry only); archived row remains undelivered.
     */
    it(
      "requeueNoContactEmailInquiries skips archived rows; sweep delivers only the active inquiry (Task #968)",
      async () => {
        const tenantId = makeId("tenant-968");
        await insertTenant(tenantId); // no contactEmail

        const artworkId = makeId("artwork-968");
        await insertArtwork(artworkId, tenantId);

        // Archived inquiry — archivedAt is set; must be left completely
        // untouched by the requeue and invisible to the sweep.
        const archivedInqId = makeId("inq-968-archived");
        const originalLastAttemptAt = new Date("2024-06-01T10:00:00Z");
        const archivedAtTs = new Date("2024-05-01T09:00:00Z");
        CREATED_INQUIRY_IDS.push(archivedInqId);
        await db.insert(inquiriesTable).values({
          id: archivedInqId,
          tenantId,
          artworkId,
          artworkTitle: "Test Artwork 968",
          buyerName: "Archived Buyer",
          buyerEmail: "archived-buyer@example.com",
          message: "Archived before gallery had an email.",
          emailError: NO_CONTACT_EMAIL_ERROR,
          emailAttempts: 2,
          emailLastAttemptAt: originalLastAttemptAt,
          status: "NEW",
          archivedAt: archivedAtTs,
        } as any);

        // Active inquiry — archivedAt is null; must be reset and swept.
        const activeInqId = makeId("inq-968-active");
        await insertNoContactInquiry(activeInqId, tenantId, artworkId, 2);

        mockSession.tenantId = tenantId;

        // ── Pre-condition ─────────────────────────────────────────────────────

        const archivedBefore = await fetchRow(archivedInqId);
        expect(archivedBefore?.emailAttempts).toBe(2);
        expect(archivedBefore?.emailLastAttemptAt?.toISOString()).toBe(
          originalLastAttemptAt.toISOString(),
        );
        expect(archivedBefore?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);

        const activeBefore = await fetchRow(activeInqId);
        expect(activeBefore?.emailAttempts).toBe(2);
        expect(activeBefore?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);

        // ── Gallery owner saves contact email → requeue fires ─────────────────

        await requeueNoContactEmailInquiries(tenantId);

        // Archived row must be completely untouched.
        const archivedAfterRequeue = await fetchRow(archivedInqId);
        expect(archivedAfterRequeue?.emailAttempts).toBe(2);
        expect(archivedAfterRequeue?.emailLastAttemptAt?.toISOString()).toBe(
          originalLastAttemptAt.toISOString(),
        );

        // Active row is reset.
        const activeAfterRequeue = await fetchRow(activeInqId);
        expect(activeAfterRequeue?.emailAttempts).toBe(0);
        expect(activeAfterRequeue?.emailLastAttemptAt).toBeNull();
        expect(activeAfterRequeue?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);

        // ── Add contact email and run sweep ───────────────────────────────────

        await db
          .update(tenantsTable)
          .set({ contactEmail: "owner-968@gallery.test" })
          .where(eq(tenantsTable.id, tenantId));

        sendArtworkInquiry.mockResolvedValue(true);
        const sweepResult = await sweepUnsentInquiryEmails(new Date(), tenantId);

        // Only the active inquiry should have been scanned and sent.
        expect(sweepResult.scanned).toBe(1);
        expect(sweepResult.sent).toBe(1);
        expect(sweepResult.failed).toBe(0);
        expect(sweepResult.skipped).toBe(0);
        expect(sendArtworkInquiry).toHaveBeenCalledTimes(1);

        // ── Archived row remains undelivered ──────────────────────────────────

        const archivedFinal = await fetchRow(archivedInqId);
        expect(archivedFinal?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);
        expect(archivedFinal?.emailAttempts).toBe(2);

        // ── Active row is delivered ───────────────────────────────────────────

        const activeFinal = await fetchRow(activeInqId);
        expect(activeFinal?.emailError).toBeNull();
        expect(activeFinal?.emailAttempts).toBe(1);
      },
    );
  },
);
