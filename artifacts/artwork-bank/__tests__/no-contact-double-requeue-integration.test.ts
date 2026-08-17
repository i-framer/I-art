/**
 * Task #954 — Confirm the no-contact requeue is safe when the gallery changes
 * email multiple times in quick succession.
 *
 * If a gallery owner saves their contact email and then immediately changes it
 * again, requeueNoContactEmailInquiries fires twice in rapid succession.
 *
 * A second reset on a row that is already at emailAttempts=0 should be a
 * no-op: idempotent.  The double-requeue must leave the row in a clean state
 * (emailAttempts=0, emailLastAttemptAt=null) and the sweep must still deliver
 * the inquiry email exactly once on the next pass.
 *
 * Flow under test:
 *  1. Seed an inquiry in the no-contact state
 *     (emailError=NO_CONTACT_EMAIL_ERROR, emailAttempts > 0).
 *  2. Call requeueNoContactEmailInquiries twice in a row (simulating two rapid
 *     email-address saves).
 *  3. Assert the row is still at emailAttempts=0 and emailLastAttemptAt=null
 *     — not doubled or corrupted.
 *  4. Run sweepUnsentInquiryEmails and assert the email is sent exactly once.
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
  userId: "u-954-test",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test-954",
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
  return `t954-${RUN}-${++seq}-${label}`;
}

async function insertTenant(
  id: string,
  opts: { contactEmail?: string } = {},
): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Double Requeue Test Gallery",
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
    title: "Test Artwork 954",
    sku: `sku-954-${RUN}-${id.slice(-6)}`,
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
    artworkTitle: "Test Artwork 954",
    buyerName: "Double Requeue Buyer",
    buyerEmail: "double-requeue-buyer@example.com",
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
  "double requeue is idempotent — real DB (Task #954)",
  () => {
    /**
     * Core scenario: the gallery owner saves their email, triggering
     * requeueNoContactEmailInquiries, then immediately saves a different email,
     * triggering a second call.  The second reset finds a row already at
     * emailAttempts=0 and emailLastAttemptAt=null — it should be a complete
     * no-op, leaving the row in the same clean state.
     *
     * The sweep then runs once and delivers the email exactly once.
     */
    it(
      "two consecutive requeues leave the row at emailAttempts=0 and emailLastAttemptAt=null",
      async () => {
        const tenantId = makeId("tenant");
        await insertTenant(tenantId, { contactEmail: "owner@gallery-954.test" });

        const artworkId = makeId("artwork");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq");
        // Seed at emailAttempts=3 — mid-flight, below MAX.
        await insertNoContactInquiry(inqId, tenantId, artworkId, 3);

        mockSession.tenantId = tenantId;

        // ── Pre-condition ─────────────────────────────────────────────────────

        const rowBefore = await fetchRow(inqId);
        expect(rowBefore?.emailAttempts).toBe(3);
        expect(rowBefore?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);
        expect(rowBefore?.emailLastAttemptAt).not.toBeNull();

        const noContactBefore = await getNoContactEmailInquiryCount();
        expect(noContactBefore).toBe(1);

        // ── First requeue (gallery owner saves their first email address) ──────

        await requeueNoContactEmailInquiries(tenantId);

        const rowAfterFirst = await fetchRow(inqId);
        expect(rowAfterFirst?.emailAttempts).toBe(0);
        expect(rowAfterFirst?.emailLastAttemptAt).toBeNull();
        // emailError is preserved so the sweep can still re-select the row.
        expect(rowAfterFirst?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);

        // ── Second requeue (gallery owner immediately changes to a new address) ─
        //
        // The row is already at emailAttempts=0 and emailLastAttemptAt=null.
        // The second call should be a no-op — it sets 0→0 and null→null.

        await requeueNoContactEmailInquiries(tenantId);

        const rowAfterSecond = await fetchRow(inqId);
        // Must not be doubled, negated, or otherwise corrupted.
        expect(rowAfterSecond?.emailAttempts).toBe(0);
        expect(rowAfterSecond?.emailLastAttemptAt).toBeNull();
        // emailError must still be intact so the sweep picks it up.
        expect(rowAfterSecond?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);

        // ── No-contact badge still reflects the requeued row ──────────────────
        //
        // getNoContactEmailInquiryCount counts rows where emailError is the
        // sentinel — the requeue does not clear it, so the count is unchanged.

        const noContactAfterRequeue = await getNoContactEmailInquiryCount();
        expect(noContactAfterRequeue).toBe(1);

        // ── Sweep delivers the inquiry exactly once ────────────────────────────

        sendArtworkInquiry.mockResolvedValue(true);
        const sweepResult = await sweepUnsentInquiryEmails(new Date(), tenantId);

        expect(sweepResult.scanned).toBe(1);
        expect(sweepResult.sent).toBe(1);
        expect(sweepResult.failed).toBe(0);
        expect(sendArtworkInquiry).toHaveBeenCalledTimes(1);

        // emailError cleared after successful delivery.
        const rowFinal = await fetchRow(inqId);
        expect(rowFinal?.emailError).toBeNull();
        expect(rowFinal?.emailAttempts).toBe(1);

        // Badge drops to 0.
        const noContactAfterSweep = await getNoContactEmailInquiryCount();
        expect(noContactAfterSweep).toBe(0);
      },
    );

    /**
     * Edge case: the inquiry is at emailAttempts=MAX_EMAIL_ATTEMPTS (exhausted)
     * when the first requeue fires.  Two rapid requeues must leave it at 0,
     * not push it past 0 or leave it stuck.
     */
    it(
      "two requeues on an exhausted row leave it at emailAttempts=0 and eligible for the sweep",
      async () => {
        const tenantId = makeId("tenant-exhausted");
        await insertTenant(tenantId, {
          contactEmail: "owner-exhausted@gallery-954.test",
        });

        const artworkId = makeId("artwork-exhausted");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq-exhausted");
        // Seed at MAX — normally excluded from the sweep candidate set.
        await insertNoContactInquiry(
          inqId,
          tenantId,
          artworkId,
          MAX_EMAIL_ATTEMPTS,
        );

        mockSession.tenantId = tenantId;

        // Pre-condition: the row is exhausted (excluded from normal sweeps).
        const rowBefore = await fetchRow(inqId);
        expect(rowBefore?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);

        // First requeue — resets to 0, re-enters the candidate set.
        await requeueNoContactEmailInquiries(tenantId);

        const rowAfterFirst = await fetchRow(inqId);
        expect(rowAfterFirst?.emailAttempts).toBe(0);
        expect(rowAfterFirst?.emailLastAttemptAt).toBeNull();

        // Second requeue — the row is already reset; must still be 0.
        await requeueNoContactEmailInquiries(tenantId);

        const rowAfterSecond = await fetchRow(inqId);
        expect(rowAfterSecond?.emailAttempts).toBe(0);
        expect(rowAfterSecond?.emailLastAttemptAt).toBeNull();
        expect(rowAfterSecond?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);

        // Sweep delivers successfully.
        sendArtworkInquiry.mockResolvedValue(true);
        const sweepResult = await sweepUnsentInquiryEmails(new Date(), tenantId);

        expect(sweepResult.sent).toBe(1);
        expect(sweepResult.failed).toBe(0);
        expect(sendArtworkInquiry).toHaveBeenCalledTimes(1);

        const rowFinal = await fetchRow(inqId);
        expect(rowFinal?.emailError).toBeNull();
      },
    );

    /**
     * Confirms idempotency holds across many requeue calls, not just two.
     * Three rapid email saves (e.g. owner types fast and saves multiple times)
     * must leave the row in the same clean state.
     */
    it(
      "three consecutive requeues are safe and the sweep sends exactly once",
      async () => {
        const tenantId = makeId("tenant-triple");
        await insertTenant(tenantId, {
          contactEmail: "owner-triple@gallery-954.test",
        });

        const artworkId = makeId("artwork-triple");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq-triple");
        await insertNoContactInquiry(inqId, tenantId, artworkId, 2);

        mockSession.tenantId = tenantId;

        // Three rapid requeues.
        await requeueNoContactEmailInquiries(tenantId);
        await requeueNoContactEmailInquiries(tenantId);
        await requeueNoContactEmailInquiries(tenantId);

        const rowAfterTriple = await fetchRow(inqId);
        expect(rowAfterTriple?.emailAttempts).toBe(0);
        expect(rowAfterTriple?.emailLastAttemptAt).toBeNull();
        expect(rowAfterTriple?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);

        // Sweep sends exactly once — not once per requeue call.
        sendArtworkInquiry.mockResolvedValue(true);
        const sweepResult = await sweepUnsentInquiryEmails(new Date(), tenantId);

        expect(sweepResult.sent).toBe(1);
        expect(sweepResult.failed).toBe(0);
        expect(sendArtworkInquiry).toHaveBeenCalledTimes(1);

        const rowFinal = await fetchRow(inqId);
        expect(rowFinal?.emailError).toBeNull();
        expect(rowFinal?.emailAttempts).toBe(1);
      },
    );

    /**
     * Confirms that multiple inquiries for the same tenant are all reset
     * correctly by a double requeue — none are left at a stale attempt count.
     */
    it(
      "double requeue resets all no-contact inquiries for the tenant; sweep delivers each exactly once",
      async () => {
        const tenantId = makeId("tenant-multi");
        await insertTenant(tenantId, {
          contactEmail: "owner-multi@gallery-954.test",
        });

        const artworkId = makeId("artwork-multi");
        await insertArtwork(artworkId, tenantId);

        // Three inquiries at different attempt counts.
        const inqId1 = makeId("inq-multi-1");
        const inqId2 = makeId("inq-multi-2");
        const inqId3 = makeId("inq-multi-3");

        await insertNoContactInquiry(inqId1, tenantId, artworkId, 1);
        await insertNoContactInquiry(inqId2, tenantId, artworkId, 3);
        await insertNoContactInquiry(inqId3, tenantId, artworkId, MAX_EMAIL_ATTEMPTS);

        mockSession.tenantId = tenantId;

        // Pre-condition: all three rows counted.
        expect(await getNoContactEmailInquiryCount()).toBe(3);

        // First requeue — resets all three to 0.
        await requeueNoContactEmailInquiries(tenantId);

        // Second requeue — should be a no-op for each.
        await requeueNoContactEmailInquiries(tenantId);

        // All three rows must be at emailAttempts=0 and emailLastAttemptAt=null.
        const [row1, row2, row3] = await Promise.all([
          fetchRow(inqId1),
          fetchRow(inqId2),
          fetchRow(inqId3),
        ]);

        for (const row of [row1, row2, row3]) {
          expect(row?.emailAttempts).toBe(0);
          expect(row?.emailLastAttemptAt).toBeNull();
          expect(row?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);
        }

        // Badge count: emailError is still set for all three → count is 3.
        expect(await getNoContactEmailInquiryCount()).toBe(3);

        // Sweep delivers all three exactly once.
        sendArtworkInquiry.mockResolvedValue(true);
        const sweepResult = await sweepUnsentInquiryEmails(new Date(), tenantId);

        expect(sweepResult.sent).toBe(3);
        expect(sweepResult.failed).toBe(0);
        expect(sendArtworkInquiry).toHaveBeenCalledTimes(3);

        // All emailError fields cleared.
        const [finalRow1, finalRow2, finalRow3] = await Promise.all([
          fetchRow(inqId1),
          fetchRow(inqId2),
          fetchRow(inqId3),
        ]);

        for (const row of [finalRow1, finalRow2, finalRow3]) {
          expect(row?.emailError).toBeNull();
        }

        // Badge drops to 0.
        expect(await getNoContactEmailInquiryCount()).toBe(0);
      },
    );
  },
);
