/**
 * Task #959 — Confirm the no-contact banner count stays accurate when the
 * gallery saves their email during an active sweep.
 *
 * getNoContactEmailInquiryCount drives the admin badge on the Inquiries page.
 * If requeueNoContactEmailInquiries fires while sweepUnsentInquiryEmails is
 * mid-flight, rows pass through intermediate states:
 *
 *   • emailLastAttemptAt is stamped by the CAS claim before delivery
 *   • requeue may reset emailAttempts → 0 and emailLastAttemptAt → null
 *   • the success write clears emailError only after the transport resolves
 *
 * The badge count query (WHERE emailError = sentinel) must not double-count or
 * miss rows in any of these windows.
 *
 * Flow under test:
 *  1. Seed multiple no-contact inquiries (emailLastAttemptAt = null so the
 *     sweep selects and claims them immediately without backoff).
 *  2. Assert pre-sweep count = N.
 *  3. Start sweepUnsentInquiryEmails with a delayed mock transport that
 *     resolves only when we tell it to — putting the sweep mid-flight.
 *  4. Yield to the event loop so the sweep advances to the blocked delivery.
 *  5. Assert mid-sweep count = N (sentinel still set on all rows, including
 *     the claimed-but-not-yet-delivered row).
 *  6. Call requeueNoContactEmailInquiries concurrently (simulating the gallery
 *     owner saving their email address while the sweep is in progress).
 *  7. Assert count = N again (emailError not cleared by requeue).
 *  8. Release the deferred; await the sweep.
 *  9. Assert post-sweep count = 0 (all rows delivered; emailError cleared).
 * 10. Assert sendArtworkInquiry was called exactly N times (no double send).
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
  userId: "u-959-test",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test-959",
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

// Email transport: hoisted so we can replace the implementation per-test.
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
} from "@/lib/email-sweep";
import { getNoContactEmailInquiryCount } from "@/app/(admin)/_actions/inquiry-count";

// ── Utilities ─────────────────────────────────────────────────────────────────

/**
 * A deferred promise whose resolve/reject handles are exposed so the test can
 * release the mock transport at exactly the right moment.
 */
function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Yield to the Node.js microtask / macro-task queue so any already-started
 * async chains (like a non-awaited sweep) can advance to their next suspension
 * point (typically the first `await` inside a mock).
 *
 * One `setImmediate` is usually enough for the sweep to read its DB candidates
 * and reach the first `sendArtworkInquiry` call.  We use three rounds to be
 * safe across minor implementation changes.
 */
function flushMicrotasks(rounds = 3): Promise<void> {
  return new Promise((resolve) => {
    let remaining = rounds;
    function next() {
      if (--remaining <= 0) return resolve();
      setImmediate(next);
    }
    setImmediate(next);
  });
}

// ── Test data helpers ─────────────────────────────────────────────────────────

const RUN = randomUUID().slice(0, 8);
let seq = 0;
const CREATED_TENANT_IDS: string[] = [];
const CREATED_ARTWORK_IDS: string[] = [];
const CREATED_INQUIRY_IDS: string[] = [];

function makeId(label: string) {
  return `t959-${RUN}-${++seq}-${label}`;
}

async function insertTenant(
  id: string,
  opts: { contactEmail?: string } = {},
): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Mid-Sweep Count Test Gallery",
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
    title: "Test Artwork 959",
    sku: `sku-959-${RUN}-${id.slice(-6)}`,
    status: "AVAILABLE",
  } as any);
}

/**
 * Insert an inquiry that is in the "no gallery contact email" state.
 *
 * emailLastAttemptAt is intentionally null so the sweep selects the row
 * immediately (no backoff window) and the CAS uses `IS NULL` — making the
 * requeue's reset (null → null) a true no-op for the CAS condition on rows
 * that haven't been claimed yet.
 */
async function insertNoContactInquiry(
  id: string,
  tenantId: string,
  artworkId: string,
): Promise<void> {
  CREATED_INQUIRY_IDS.push(id);
  await db.insert(inquiriesTable).values({
    id,
    tenantId,
    artworkId,
    artworkTitle: "Test Artwork 959",
    buyerName: "Mid-Sweep Buyer",
    buyerEmail: "mid-sweep-buyer@example.com",
    message: "Interested in purchasing.",
    emailError: NO_CONTACT_EMAIL_ERROR,
    emailAttempts: 0,
    emailLastAttemptAt: null,
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
  "no-contact banner count accuracy during active sweep — real DB (Task #959)",
  () => {
    /**
     * Core scenario: three no-contact inquiries, sweep is mid-flight (blocked
     * at the first email delivery), requeueNoContactEmailInquiries fires.
     *
     * The count must equal 3 at every checkpoint until all deliveries succeed.
     * sendArtworkInquiry must be called exactly 3 times — never more.
     *
     * Why emailLastAttemptAt = null matters here:
     *   The sweep's CAS claim uses `WHERE emailLastAttemptAt IS NULL` (because
     *   the snapshot is null).  After requeue resets the field to null, the CAS
     *   for unclaimed rows is `IS NULL` → the DB value is null → condition still
     *   matches → each row is claimed and delivered by the same sweep run.
     *   This lets us verify the full end-to-end path in a single sweep pass.
     */
    it(
      "count stays at N mid-sweep and drops to 0 post-sweep; no inquiry is double-sent",
      async () => {
        // ── Seed ───────────────────────────────────────────────────────────────

        const tenantId = makeId("tenant");
        // Tenant already has a contact email — the sweep will deliver, not skip.
        await insertTenant(tenantId, {
          contactEmail: "owner@gallery-959.test",
        });

        const artworkId = makeId("artwork");
        await insertArtwork(artworkId, tenantId);

        const inqId1 = makeId("inq-1");
        const inqId2 = makeId("inq-2");
        const inqId3 = makeId("inq-3");

        await insertNoContactInquiry(inqId1, tenantId, artworkId);
        await insertNoContactInquiry(inqId2, tenantId, artworkId);
        await insertNoContactInquiry(inqId3, tenantId, artworkId);

        mockSession.tenantId = tenantId;

        // ── Pre-sweep checkpoint ───────────────────────────────────────────────

        const countBefore = await getNoContactEmailInquiryCount();
        expect(countBefore).toBe(3);

        // ── Set up a deferred transport that we control ────────────────────────
        //
        // The first call to sendArtworkInquiry blocks on `firstDelivery.promise`.
        // Subsequent calls resolve immediately so the sweep can finish without
        // further intervention once we release the first deferred.

        const firstDelivery = createDeferred<boolean>();
        let deliveryCallCount = 0;

        sendArtworkInquiry.mockImplementation(async () => {
          deliveryCallCount++;
          if (deliveryCallCount === 1) {
            // Block until the test releases this deferred.
            return firstDelivery.promise;
          }
          // Rows 2 and 3 resolve immediately.
          return true;
        });

        // ── Start the sweep without awaiting it ───────────────────────────────
        //
        // The sweep will:
        //  1. Read all 3 candidates from the DB.
        //  2. CAS-claim row 1 (stamp emailLastAttemptAt).
        //  3. Call sendArtworkInquiry for row 1 → suspend here (deferred).
        //
        // Control returns to the test after flushMicrotasks.

        const sweepPromise = sweepUnsentInquiryEmails(new Date(), tenantId);

        // Give the sweep enough event-loop turns to reach the first blocked send.
        await flushMicrotasks(5);

        // ── Mid-sweep checkpoint (before requeue) ─────────────────────────────
        //
        // The sweep has claimed row 1 (emailLastAttemptAt stamped) but has not
        // yet written emailError = null.  All three rows still carry the
        // NO_CONTACT_EMAIL_ERROR sentinel.

        const countMidBeforeRequeue = await getNoContactEmailInquiryCount();
        expect(countMidBeforeRequeue).toBe(3);

        // ── Fire the concurrent requeue ────────────────────────────────────────
        //
        // requeueNoContactEmailInquiries resets emailAttempts→0 and
        // emailLastAttemptAt→null for every row still carrying the sentinel.
        // This simulates the gallery owner saving their contact email while the
        // sweep is blocked waiting for the transport.

        await requeueNoContactEmailInquiries(tenantId);

        // ── Mid-sweep checkpoint (after requeue) ──────────────────────────────
        //
        // The requeue does NOT touch emailError — the sentinel is still set on
        // all three rows (row 1's delivery hasn't completed yet).

        const countMidAfterRequeue = await getNoContactEmailInquiryCount();
        expect(countMidAfterRequeue).toBe(3);

        // Sanity check: all rows still carry the sentinel in the DB.
        const [row1Mid, row2Mid, row3Mid] = await Promise.all([
          fetchRow(inqId1),
          fetchRow(inqId2),
          fetchRow(inqId3),
        ]);

        for (const row of [row1Mid, row2Mid, row3Mid]) {
          expect(row?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);
        }

        // Row 1's emailAttempts was reset to 0 by requeue (even though the
        // sweep had already CAS-claimed it — the claim stamp was on
        // emailLastAttemptAt, not emailAttempts, and requeue resets both).
        expect(row1Mid?.emailAttempts).toBe(0);

        // Rows 2 and 3 were not yet claimed; requeue is a no-op (they were
        // already at emailAttempts=0 and emailLastAttemptAt=null).
        expect(row2Mid?.emailAttempts).toBe(0);
        expect(row2Mid?.emailLastAttemptAt).toBeNull();
        expect(row3Mid?.emailAttempts).toBe(0);
        expect(row3Mid?.emailLastAttemptAt).toBeNull();

        // ── Release the deferred — sweep resumes ──────────────────────────────

        firstDelivery.resolve(true);

        const sweepResult = await sweepPromise;

        // ── Post-sweep assertions ─────────────────────────────────────────────

        // The sweep should have delivered all 3 rows.  sendArtworkInquiry must
        // have been called exactly 3 times — once per inquiry, no duplicates.
        expect(sweepResult.sent).toBe(3);
        expect(sweepResult.failed).toBe(0);
        expect(sendArtworkInquiry).toHaveBeenCalledTimes(3);

        // All rows have emailError cleared (delivery confirmed).
        const [row1Final, row2Final, row3Final] = await Promise.all([
          fetchRow(inqId1),
          fetchRow(inqId2),
          fetchRow(inqId3),
        ]);

        for (const row of [row1Final, row2Final, row3Final]) {
          expect(row?.emailError).toBeNull();
        }

        // ── Post-sweep count checkpoint ────────────────────────────────────────
        //
        // All sentinels are cleared — the badge must drop to 0.

        const countAfter = await getNoContactEmailInquiryCount();
        expect(countAfter).toBe(0);
      },
    );

    /**
     * Variant: requeue fires *between* deliveries — after row 1 has been
     * delivered (emailError cleared) but before row 2 is claimed.
     *
     * At that point the count should be 2 (rows 2 and 3 still have the
     * sentinel), the requeue should be a no-op for row 1 (emailError=null does
     * not match the sentinel filter), and the sweep should continue to deliver
     * rows 2 and 3 successfully.
     *
     * Synchronization: instead of polling with flushMicrotasks we expose a
     * `secondCallStarted` deferred that the mock resolves the instant the
     * second sendArtworkInquiry invocation begins.  This is the earliest
     * possible moment after row 1's DB success-write has committed, giving us
     * a reliable checkpoint without any arbitrary delay.
     */
    it(
      "count is N-1 after the first delivery; requeue between deliveries leaves remaining rows eligible",
      async () => {
        // ── Seed ───────────────────────────────────────────────────────────────

        const tenantId = makeId("tenant-between");
        await insertTenant(tenantId, {
          contactEmail: "owner-between@gallery-959.test",
        });

        const artworkId = makeId("artwork-between");
        await insertArtwork(artworkId, tenantId);

        const inqId1 = makeId("inq-b-1");
        const inqId2 = makeId("inq-b-2");
        const inqId3 = makeId("inq-b-3");

        await insertNoContactInquiry(inqId1, tenantId, artworkId);
        await insertNoContactInquiry(inqId2, tenantId, artworkId);
        await insertNoContactInquiry(inqId3, tenantId, artworkId);

        mockSession.tenantId = tenantId;

        // Pre-sweep: all 3 rows counted.
        expect(await getNoContactEmailInquiryCount()).toBe(3);

        // ── Transport: row 1 resolves immediately; row 2 blocks ───────────────
        //
        // `secondCallStarted` resolves the moment sendArtworkInquiry is called
        // for row 2.  That call can only happen after row 1's DB success-write
        // has committed (the sweep loop is sequential), giving us a precise,
        // race-free synchronization point.

        const secondDelivery = createDeferred<boolean>();
        const secondCallStarted = createDeferred<void>();
        let callCount = 0;

        sendArtworkInquiry.mockImplementation(async () => {
          const n = ++callCount;
          if (n === 1) return true;           // row 1 resolves immediately
          if (n === 2) {
            secondCallStarted.resolve();      // signal: row 1 is fully done
            return secondDelivery.promise;    // row 2 blocks until we release
          }
          return true;                        // row 3 resolves immediately
        });

        const sweepPromise = sweepUnsentInquiryEmails(new Date(), tenantId);

        // Wait until the sweep has called sendArtworkInquiry for row 2.
        // At this point row 1's emailError is null in the DB.
        await secondCallStarted.promise;

        // ── Row 1 is delivered; rows 2 and 3 are still pending ────────────────

        const row1Mid = await fetchRow(inqId1);
        expect(row1Mid?.emailError).toBeNull(); // delivered

        // Count at this mid-point: 2 (rows 2 and 3 still carry the sentinel).
        const countMid = await getNoContactEmailInquiryCount();
        expect(countMid).toBe(2);

        // ── Requeue fires between row 1 (done) and row 2 (in-flight) ──────────
        //
        // requeueNoContactEmailInquiries only touches rows WHERE emailError =
        // NO_CONTACT_EMAIL_ERROR.  Row 1 is already cleared (emailError=null)
        // so it is unaffected.  Rows 2 and 3 still carry the sentinel, so their
        // emailAttempts→0 and emailLastAttemptAt→null (already the seeded
        // state, so effectively a no-op for the CAS condition).

        await requeueNoContactEmailInquiries(tenantId);

        // Count unchanged by requeue (emailError still set on rows 2 and 3).
        const countAfterRequeue = await getNoContactEmailInquiryCount();
        expect(countAfterRequeue).toBe(2);

        // ── Release row 2's deferred; sweep finishes ──────────────────────────

        secondDelivery.resolve(true);
        const sweepResult = await sweepPromise;

        // All three rows were sent in this single sweep pass.
        expect(sweepResult.sent).toBe(3);
        expect(sweepResult.failed).toBe(0);
        expect(sendArtworkInquiry).toHaveBeenCalledTimes(3);

        // ── Post-sweep count ───────────────────────────────────────────────────

        const countAfter = await getNoContactEmailInquiryCount();
        expect(countAfter).toBe(0);

        // All rows cleared.
        for (const id of [inqId1, inqId2, inqId3]) {
          const row = await fetchRow(id);
          expect(row?.emailError).toBeNull();
        }
      },
    );

    /**
     * Single-inquiry variant: confirms the count transitions 1→1→0 and the
     * inquiry is not double-sent even when the requeue fires in the narrow
     * window after the CAS claim but before the success write.
     */
    it(
      "single inquiry: count is 1 through the mid-sweep window and 0 after delivery",
      async () => {
        // ── Seed ───────────────────────────────────────────────────────────────

        const tenantId = makeId("tenant-single");
        await insertTenant(tenantId, {
          contactEmail: "owner-single@gallery-959.test",
        });

        const artworkId = makeId("artwork-single");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq-single");
        await insertNoContactInquiry(inqId, tenantId, artworkId);

        mockSession.tenantId = tenantId;

        // Pre-sweep: 1 row.
        expect(await getNoContactEmailInquiryCount()).toBe(1);

        // ── Deferred transport ────────────────────────────────────────────────

        const delivery = createDeferred<boolean>();
        sendArtworkInquiry.mockImplementation(() => delivery.promise);

        const sweepPromise = sweepUnsentInquiryEmails(new Date(), tenantId);

        // Advance to the blocked delivery.
        await flushMicrotasks(5);

        // Mid-sweep: row is claimed but not yet delivered — count is still 1.
        const countMid = await getNoContactEmailInquiryCount();
        expect(countMid).toBe(1);

        // Concurrent requeue — resets emailAttempts→0, emailLastAttemptAt→null.
        await requeueNoContactEmailInquiries(tenantId);

        // Count is still 1 (emailError unchanged).
        const countAfterRequeue = await getNoContactEmailInquiryCount();
        expect(countAfterRequeue).toBe(1);

        // Release; sweep delivers successfully.
        delivery.resolve(true);
        const sweepResult = await sweepPromise;

        expect(sweepResult.sent).toBe(1);
        expect(sweepResult.failed).toBe(0);
        expect(sendArtworkInquiry).toHaveBeenCalledTimes(1);

        // Badge drops to 0.
        const countAfter = await getNoContactEmailInquiryCount();
        expect(countAfter).toBe(0);

        // Row cleared.
        const rowFinal = await fetchRow(inqId);
        expect(rowFinal?.emailError).toBeNull();
        expect(rowFinal?.emailAttempts).toBe(1);
      },
    );
  },
);
