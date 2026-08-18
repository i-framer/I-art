/**
 * Task #994 — Give an admin a one-click way to unstick a crashed-worker inquiry
 *
 * Tests the clearStuckNonces helper and the clearStuckInquiryNonces server
 * action end-to-end against a real PostgreSQL database.
 *
 * The "stuck" state:
 *   emailClaimNonce IS NOT NULL  AND  emailLastAttemptAt IS NULL
 *
 * This occurs when a sweep worker claims a row (sets the nonce) but crashes
 * before writing emailLastAttemptAt in the CAS stamp.  Because
 * emailLastAttemptAt remains NULL, the normal lease-expiry guard never
 * fires and the row is permanently skipped by all requeue helpers.
 *
 * Scenarios covered:
 *  1. clearStuckNonces clears the nonce, leaving the row retryable.
 *  2. After clearing, retrySmtpErrorInquiries re-queues the row (because it
 *     now has emailError set and emailClaimNonce = NULL).
 *  3. After clearing and requeuing, sweepUnsentInquiryEmails selects and
 *     delivers the inquiry email.
 *  4. Rows with an active (non-expired) claim (emailLastAttemptAt IS NOT NULL)
 *     are NOT touched by clearStuckNonces.
 *  5. Archived rows are NOT touched by clearStuckNonces.
 *  6. Rows belonging to a different tenant are NOT touched.
 *  7. clearStuckInquiryNonces server action redirects to
 *     /inquiries?stuck_result=<count> on success.
 *  8. getStuckNonceCount returns the correct count and drops to 0 after clearing.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable, inquiriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockSession = {
  userId: "u-994-test",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test-994",
}));

// redirect is used by the server action; capture it as a thrown error so the
// action's redirect call ends the function without actually navigating.
const redirectCalls: string[] = [];
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    redirectCalls.push(url);
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

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
  clearStuckNonces,
  retrySmtpErrorInquiries,
  sweepUnsentInquiryEmails,
} from "@/lib/email-sweep";
import { clearStuckInquiryNonces } from "@/app/(admin)/(gated)/inquiries/actions";
import { getStuckNonceCount } from "@/app/(admin)/_actions/inquiry-count";

// ── Helpers ───────────────────────────────────────────────────────────────────

const RUN = randomUUID().slice(0, 8);
let seq = 0;
const CREATED_TENANT_IDS: string[] = [];
const CREATED_ARTWORK_IDS: string[] = [];
const CREATED_INQUIRY_IDS: string[] = [];

function makeId(label: string) {
  return `t994-${RUN}-${++seq}-${label}`;
}

async function insertTenant(
  id: string,
  opts: { contactEmail?: string } = {},
): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Stuck Nonce Test Gallery",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: null,
    contactEmail: opts.contactEmail ?? "gallery@stuck-test.example",
  } as any);
}

async function insertArtwork(id: string, tenantId: string): Promise<void> {
  CREATED_ARTWORK_IDS.push(id);
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork 994",
    sku: `sku-994-${RUN}-${id.slice(-6)}`,
    status: "AVAILABLE",
  } as any);
}

/**
 * Insert an inquiry that is in the stuck-nonce state:
 *  – emailClaimNonce IS NOT NULL
 *  – emailLastAttemptAt IS NULL   ← the distinguishing crash-worker condition
 *  – emailError is set (so the sweep would normally want to retry it)
 */
async function insertStuckInquiry(
  id: string,
  tenantId: string,
  artworkId: string,
  opts: {
    emailAttempts?: number;
    archivedAt?: Date | null;
    emailLastAttemptAt?: Date | null;
  } = {},
): Promise<void> {
  CREATED_INQUIRY_IDS.push(id);
  await db.insert(inquiriesTable).values({
    id,
    tenantId,
    artworkId,
    artworkTitle: "Test Artwork 994",
    buyerName: "Stuck Buyer",
    buyerEmail: "stuck-buyer@example.com",
    message: "Interested in purchasing.",
    emailError: "connection reset by peer",
    emailAttempts: opts.emailAttempts ?? 1,
    emailLastAttemptAt: opts.emailLastAttemptAt !== undefined
      ? opts.emailLastAttemptAt
      : null,
    emailClaimNonce: randomUUID(), // simulates a crashed worker's claim
    archivedAt: opts.archivedAt ?? null,
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
  redirectCalls.length = 0;
  await cleanup();
});

afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration(
  "clearStuckNonces — real DB (Task #994)",
  () => {
    // ── Scenario 1: basic clear ───────────────────────────────────────────────

    it(
      "clears the nonce on a stuck inquiry and leaves it retryable",
      async () => {
        const tenantId = makeId("tenant-994a");
        await insertTenant(tenantId);

        const artworkId = makeId("artwork-994a");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq-994a");
        await insertStuckInquiry(inqId, tenantId, artworkId);

        mockSession.tenantId = tenantId;

        // Pre-condition: stuck state
        const rowBefore = await fetchRow(inqId);
        expect(rowBefore?.emailClaimNonce).not.toBeNull();
        expect(rowBefore?.emailLastAttemptAt).toBeNull();

        const cleared = await clearStuckNonces(tenantId);
        expect(cleared).toBe(1);

        // Post-condition: nonce cleared, row is still in sweep candidate set
        const rowAfter = await fetchRow(inqId);
        expect(rowAfter?.emailClaimNonce).toBeNull();
        expect(rowAfter?.emailLastAttemptAt).toBeNull(); // untouched
        expect(rowAfter?.emailError).toBe("connection reset by peer"); // untouched
        expect(rowAfter?.emailAttempts).toBe(1); // untouched
      },
    );

    // ── Scenario 2: clears → retrySmtpErrorInquiries re-queues ───────────────

    it(
      "after clearing, retrySmtpErrorInquiries re-queues the row",
      async () => {
        const tenantId = makeId("tenant-994b");
        await insertTenant(tenantId);

        const artworkId = makeId("artwork-994b");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq-994b");
        // Start with emailAttempts=1 so the row is NOT exhausted
        await insertStuckInquiry(inqId, tenantId, artworkId, {
          emailAttempts: 1,
        });

        mockSession.tenantId = tenantId;

        // Step 1: clear the stuck nonce
        const cleared = await clearStuckNonces(tenantId);
        expect(cleared).toBe(1);

        // Step 2: retrySmtpErrorInquiries should now find and reset the row
        const retried = await retrySmtpErrorInquiries(tenantId);
        expect(retried).toBe(1);

        const rowAfter = await fetchRow(inqId);
        expect(rowAfter?.emailAttempts).toBe(0);
        expect(rowAfter?.emailLastAttemptAt).toBeNull();
        expect(rowAfter?.emailClaimNonce).toBeNull();
        // emailError is preserved (retrySmtpErrorInquiries intentionally leaves it)
        expect(rowAfter?.emailError).toBe("connection reset by peer");
      },
    );

    // ── Scenario 3: full end-to-end → sweep delivers after clear+requeue ─────

    it(
      "after clear + requeue, sweepUnsentInquiryEmails delivers the inquiry",
      async () => {
        const tenantId = makeId("tenant-994c");
        await insertTenant(tenantId, {
          contactEmail: "gallery@994c.example",
        });

        const artworkId = makeId("artwork-994c");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq-994c");
        await insertStuckInquiry(inqId, tenantId, artworkId, {
          emailAttempts: 1,
        });

        mockSession.tenantId = tenantId;

        // Step 1: clear stuck nonce
        const cleared = await clearStuckNonces(tenantId);
        expect(cleared).toBe(1);

        // Step 2: requeue so emailAttempts=0 (re-enters sweep candidate set)
        await retrySmtpErrorInquiries(tenantId);

        // Step 3: sweep should now select and deliver the email
        sendArtworkInquiry.mockResolvedValue(true);
        const sweepResult = await sweepUnsentInquiryEmails(new Date(), tenantId);

        expect(sweepResult.scanned).toBe(1);
        expect(sweepResult.sent).toBe(1);
        expect(sweepResult.failed).toBe(0);
        expect(sendArtworkInquiry).toHaveBeenCalledTimes(1);

        const rowFinal = await fetchRow(inqId);
        expect(rowFinal?.emailError).toBeNull();
        expect(rowFinal?.emailClaimNonce).toBeNull();
      },
    );

    // ── Scenario 4: rows with an active claim are NOT cleared ────────────────

    it(
      "does NOT clear nonces on rows that have an active claim (emailLastAttemptAt IS NOT NULL)",
      async () => {
        const tenantId = makeId("tenant-994d");
        await insertTenant(tenantId);

        const artworkId = makeId("artwork-994d");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq-994d");
        // This row has BOTH nonce AND emailLastAttemptAt set — an active claim
        const activeClaimTime = new Date();
        await insertStuckInquiry(inqId, tenantId, artworkId, {
          emailLastAttemptAt: activeClaimTime,
        });

        mockSession.tenantId = tenantId;

        const cleared = await clearStuckNonces(tenantId);
        expect(cleared).toBe(0);

        // Row must remain untouched
        const rowAfter = await fetchRow(inqId);
        expect(rowAfter?.emailClaimNonce).not.toBeNull();
        expect(rowAfter?.emailLastAttemptAt).not.toBeNull();
      },
    );

    // ── Scenario 5: archived rows are NOT cleared ─────────────────────────────

    it(
      "does NOT clear nonces on archived inquiries",
      async () => {
        const tenantId = makeId("tenant-994e");
        await insertTenant(tenantId);

        const artworkId = makeId("artwork-994e");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq-994e");
        await insertStuckInquiry(inqId, tenantId, artworkId, {
          archivedAt: new Date("2024-01-01T00:00:00Z"),
        });

        mockSession.tenantId = tenantId;

        const cleared = await clearStuckNonces(tenantId);
        expect(cleared).toBe(0);

        const rowAfter = await fetchRow(inqId);
        expect(rowAfter?.emailClaimNonce).not.toBeNull();
      },
    );

    // ── Scenario 6: cross-tenant isolation ───────────────────────────────────

    it(
      "only clears nonces for the specified tenant — does not touch other tenants",
      async () => {
        const tenantA = makeId("tenant-994f-a");
        const tenantB = makeId("tenant-994f-b");
        await Promise.all([
          insertTenant(tenantA),
          insertTenant(tenantB),
        ]);

        const artworkA = makeId("artwork-994f-a");
        const artworkB = makeId("artwork-994f-b");
        await Promise.all([
          insertArtwork(artworkA, tenantA),
          insertArtwork(artworkB, tenantB),
        ]);

        const inqA = makeId("inq-994f-a");
        const inqB = makeId("inq-994f-b");
        await Promise.all([
          insertStuckInquiry(inqA, tenantA, artworkA),
          insertStuckInquiry(inqB, tenantB, artworkB),
        ]);

        mockSession.tenantId = tenantA;

        const cleared = await clearStuckNonces(tenantA);
        expect(cleared).toBe(1);

        // Tenant A's row is fixed
        const rowA = await fetchRow(inqA);
        expect(rowA?.emailClaimNonce).toBeNull();

        // Tenant B's row is untouched
        const rowB = await fetchRow(inqB);
        expect(rowB?.emailClaimNonce).not.toBeNull();
      },
    );

    // ── Scenario 7: server action redirects with correct count ────────────────

    it(
      "clearStuckInquiryNonces server action redirects to /inquiries?stuck_result=<n>",
      async () => {
        const tenantId = makeId("tenant-994g");
        await insertTenant(tenantId);

        const artworkId = makeId("artwork-994g");
        await insertArtwork(artworkId, tenantId);

        const inqId1 = makeId("inq-994g-1");
        const inqId2 = makeId("inq-994g-2");
        await Promise.all([
          insertStuckInquiry(inqId1, tenantId, artworkId),
          insertStuckInquiry(inqId2, tenantId, artworkId),
        ]);

        mockSession.tenantId = tenantId;

        // The action redirects — catch the thrown error.
        await expect(clearStuckInquiryNonces()).rejects.toThrow(
          "REDIRECT:/inquiries?stuck_result=2",
        );

        // Both rows should have their nonces cleared.
        const [row1, row2] = await Promise.all([
          fetchRow(inqId1),
          fetchRow(inqId2),
        ]);
        expect(row1?.emailClaimNonce).toBeNull();
        expect(row2?.emailClaimNonce).toBeNull();
      },
    );

    // ── Scenario 8: getStuckNonceCount returns correct count ─────────────────

    it(
      "getStuckNonceCount reflects the real stuck count and drops to 0 after clearing",
      async () => {
        const tenantId = makeId("tenant-994h");
        await insertTenant(tenantId);

        const artworkId = makeId("artwork-994h");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq-994h");
        await insertStuckInquiry(inqId, tenantId, artworkId);

        mockSession.tenantId = tenantId;

        const countBefore = await getStuckNonceCount();
        expect(countBefore).toBe(1);

        await clearStuckNonces(tenantId);

        const countAfter = await getStuckNonceCount();
        expect(countAfter).toBe(0);
      },
    );
  },
);
