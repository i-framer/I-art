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
     * The requeue deliberately skips the live claimed row so another sweep
     * cannot reclaim it and double-send. It still resets the two unclaimed rows,
     * whose null timestamp continues to satisfy their CAS snapshots.
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
        const firstDeliveryStarted = createDeferred<void>();
        let deliveryCallCount = 0;

        sendArtworkInquiry.mockImplementation(async () => {
          deliveryCallCount++;
          if (deliveryCallCount === 1) {
            firstDeliveryStarted.resolve();
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
        // Control returns immediately; the explicit delivery signal below
        // tells the test when the claim has reached the transport.

        const sweepPromise = sweepUnsentInquiryEmails(new Date(), tenantId);

        // A delivery begins only after its database claim is committed. Waiting
        // for this explicit signal keeps the mid-sweep assertion stable when
        // other isolated integration workers are actively using the database.
        await firstDeliveryStarted.promise;

        // ── Mid-sweep checkpoint (before requeue) ─────────────────────────────
        //
        // The sweep has claimed row 1 (emailLastAttemptAt stamped) but has not
        // yet written emailError = null.  All three rows still carry the
        // NO_CONTACT_EMAIL_ERROR sentinel.

        const countMidBeforeRequeue = await getNoContactEmailInquiryCount();
        expect(countMidBeforeRequeue).toBe(3);

        // ── Fire the concurrent requeue ────────────────────────────────────────
        //
        // requeueNoContactEmailInquiries resets unclaimed sentinel rows while
        // preserving the active claim. This prevents another sweep from
        // reclaiming the blocked delivery and double-sending it.

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

        // The query does not promise a candidate order, so assert the claim
        // state across all rows rather than assigning the blocked delivery to
        // a particular seeded id. Exactly one row is actively claimed; requeue
        // leaves its nonce and timestamp intact. The other two are reset.
        const rowsMid = [row1Mid, row2Mid, row3Mid];
        const activeRows = rowsMid.filter((row) => row?.emailClaimNonce);
        const unclaimedRows = rowsMid.filter((row) => !row?.emailClaimNonce);
        expect(activeRows).toHaveLength(1);
        expect(activeRows[0]?.emailAttempts).toBe(0);
        expect(activeRows[0]?.emailLastAttemptAt).toBeInstanceOf(Date);
        expect(unclaimedRows).toHaveLength(2);
        for (const row of unclaimedRows) {
          expect(row?.emailAttempts).toBe(0);
          expect(row?.emailLastAttemptAt).toBeNull();
        }

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
     * Variant: requeue fires *between* deliveries — after one row has been
     * delivered (emailError cleared) and while the next row is claimed.
     *
     * At that point the count should be 2. Requeue must preserve both the
     * delivered row and the active claim, then the sweep continues to deliver
     * the remaining rows successfully.
     *
     * Synchronization: instead of timing an event-loop poll we expose a
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
         // `secondCallStarted` resolves the moment the second sequential
         // sendArtworkInquiry call begins. The first success write has committed
         // by then, while the second row's live claim is protected by its nonce.

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

        // Wait until the second sequential delivery begins.
        await secondCallStarted.promise;

        // ── One row delivered; one row claimed; one row is pending ─────────────

        const rowsMid = await Promise.all([
          fetchRow(inqId1),
          fetchRow(inqId2),
          fetchRow(inqId3),
        ]);
        expect(rowsMid.filter((row) => row?.emailError === null)).toHaveLength(1);
        expect(rowsMid.filter((row) => row?.emailClaimNonce)).toHaveLength(1);
        expect(
          rowsMid.filter(
            (row) =>
              row?.emailError === NO_CONTACT_EMAIL_ERROR &&
              row.emailClaimNonce === null,
          ),
        ).toHaveLength(1);

        // Count at this mid-point: the two non-delivered rows still carry the
        // no-contact sentinel.
        const countMid = await getNoContactEmailInquiryCount();
        expect(countMid).toBe(2);

        // ── Requeue fires between one completed and one in-flight delivery ─────
        //
        // It cannot touch the delivered row (error cleared) or the active row
        // (non-expired nonce). Only the remaining unclaimed sentinel row resets.

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
        const deliveryStarted = createDeferred<void>();
        sendArtworkInquiry.mockImplementation(() => {
          deliveryStarted.resolve();
          return delivery.promise;
        });

        const sweepPromise = sweepUnsentInquiryEmails(new Date(), tenantId);

        // A delivery begins only after its database claim is committed.
        await deliveryStarted.promise;

        // Mid-sweep: row is claimed but not yet delivered — count is still 1.
        const countMid = await getNoContactEmailInquiryCount();
        expect(countMid).toBe(1);

        // Concurrent requeue preserves the live claim to avoid a double send.
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
