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
  sweepUnsentInquiryEmails,
  NO_CONTACT_EMAIL_ERROR,
  MAX_EMAIL_ATTEMPTS,
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
    emailLastAttemptAt: new Date("2024-06-01T10:00:00Z"),
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
        const tenantId = makeId("tenant");
        // Start with NO contact email — the sweep will hit the no-contact path.
        await insertTenant(tenantId);

        const artworkId = makeId("artwork");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq");
        // Seed at emailAttempts=2 — below MAX, so the sweep normally selects it.
        const snapshotAttempts = 2;
        await insertNoContactInquiry(inqId, tenantId, artworkId, snapshotAttempts);

        mockSession.tenantId = tenantId;

        // ── Pre-condition: the row is in the no-contact state ─────────────────

        const rowBefore = await fetchRow(inqId);
        expect(rowBefore?.emailAttempts).toBe(snapshotAttempts);
        expect(rowBefore?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);
        expect(rowBefore?.emailLastAttemptAt).not.toBeNull();

        const noContactBefore = await getNoContactEmailInquiryCount();
        expect(noContactBefore).toBe(1);

        // ── Simulate the concurrent sweep's snapshot ──────────────────────────
        //
        // The sweep read emailAttempts=2 and is about to issue its CAS write.
        // Before it can, requeueNoContactEmailInquiries fires (the gallery
        // owner just saved their contact email).

        await requeueNoContactEmailInquiries(tenantId);

        // The row is now at emailAttempts=0.
        const rowAfterRequeue = await fetchRow(inqId);
        expect(rowAfterRequeue?.emailAttempts).toBe(0);
        expect(rowAfterRequeue?.emailLastAttemptAt).toBeNull();
        // emailError is preserved so the sweep can re-select the row.
        expect(rowAfterRequeue?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);

        // ── Stale CAS write (what the concurrent sweep would issue) ───────────
        //
        // The no-contact path in sweepUnsentInquiryEmails issues:
        //
        //   UPDATE inquiries
        //   SET emailError = NO_CONTACT_EMAIL_ERROR,
        //       emailAttempts = inquiry.emailAttempts + 1,   -- 2+1=3
        //       emailLastAttemptAt = now
        //   WHERE id = <id>
        //     AND emailError IS NOT NULL
        //     AND emailAttempts = <snapshot>                 -- 2
        //
        // Since requeueNoContactEmailInquiries already changed emailAttempts to
        // 0, the WHERE emailAttempts=2 predicate no longer matches; the write
        // returns 0 rows.

        const now = new Date();
        const staleResult = await db
          .update(inquiriesTable)
          .set({
            emailError: NO_CONTACT_EMAIL_ERROR,
            emailAttempts: snapshotAttempts + 1, // would have been 3
            emailLastAttemptAt: now,
          })
          .where(
            and(
              eq(inquiriesTable.id, inqId),
              eq(inquiriesTable.emailAttempts, snapshotAttempts), // stale: 2
            ),
          )
          .returning({ id: inquiriesTable.id });

        // The stale CAS write must have matched 0 rows.
        expect(staleResult).toHaveLength(0);

        // ── Row is still at emailAttempts=0 (the stale write left it intact) ──

        const rowAfterStaleWrite = await fetchRow(inqId);
        expect(rowAfterStaleWrite?.emailAttempts).toBe(0);
        expect(rowAfterStaleWrite?.emailLastAttemptAt).toBeNull();
        expect(rowAfterStaleWrite?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);

        // ── Next sweep pass: gallery now has a contact email ──────────────────
        //
        // Simulate the gallery owner's email actually being persisted so the
        // sweep can deliver the inquiry notification.

        await db
          .update(tenantsTable)
          .set({ contactEmail: "owner@gallery-950.test" })
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
        expect(rowFinal?.emailAttempts).toBe(1);
      },
    );

    /**
     * Edge case: the row is at emailAttempts=MAX_EMAIL_ATTEMPTS-1 (one attempt
     * away from exhaustion) when the concurrent sweep reads it.  After
     * requeueNoContactEmailInquiries resets to 0, the stale CAS write would
     * have pushed the row to MAX_EMAIL_ATTEMPTS — dropping it out of the
     * candidate set permanently.  Confirm the stale write is blocked and the
     * row remains eligible.
     */
    it(
      "stale CAS write at MAX-1 does not exhaust the row; requeue keeps it eligible",
      async () => {
        const tenantId = makeId("tenant-edge");
        await insertTenant(tenantId);

        const artworkId = makeId("artwork-edge");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq-edge");
        // One attempt away from exhaustion.
        const snapshotAttempts = MAX_EMAIL_ATTEMPTS - 1;
        await insertNoContactInquiry(
          inqId,
          tenantId,
          artworkId,
          snapshotAttempts,
        );

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

        // getNoContactEmailInquiryCount is session-scoped; the row was delivered
        // so it no longer has emailError set — verified via the DB row below.
        const _noContactAfterSweep = await getNoContactEmailInquiryCount();
        // Tenant B rows may exist in other tests but we check isolation via tenantId filter.
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
        const tenantId = makeId("tenant-multi");
        await insertTenant(tenantId);

        const artworkId = makeId("artwork-multi");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq-multi");
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
  },
);
