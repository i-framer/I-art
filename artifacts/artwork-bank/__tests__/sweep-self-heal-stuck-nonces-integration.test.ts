/**
 * Task #999 — Sweep self-heal: auto-clear stuck nonces each cycle
 *
 * Verifies that clearAllStuckNonces() (called by the sweep route each cycle)
 * automatically makes stuck-nonce inquiry rows retryable without any manual
 * admin action.
 *
 * The "stuck" state arises when a sweep worker claims a row by writing
 * emailClaimNonce but then crashes before writing emailLastAttemptAt in the
 * CAS stamp.  Because emailLastAttemptAt remains NULL the normal lease-expiry
 * guard never fires and subsequent sweep passes skip the row forever — until
 * clearAllStuckNonces clears the nonce.
 *
 * Scenarios covered:
 *  1. clearAllStuckNonces clears the nonce on a stuck row and lets the very
 *     next sweep deliver the inquiry email — no admin action required.
 *  2. Archived stuck rows are NOT touched by clearAllStuckNonces.
 *  3. Rows that have an active claim (emailLastAttemptAt IS NOT NULL) are NOT
 *     touched — clearAllStuckNonces only targets the "crashed before CAS" case.
 *  4. clearAllStuckNonces clears stuck rows across multiple tenants in a single
 *     call (no per-tenant iteration needed in the sweep route).
 *  5. After clearAllStuckNonces the sweep delivers the email in the same cycle
 *     (end-to-end: stuck → auto-heal → send without human intervention).
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable, inquiriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@/lib/base-url", () => ({
  getTenantUrl: (_tenant: unknown, path: string) =>
    `https://gallery.test${path}`,
  getPlatformBaseUrl: () => "https://platform.test",
}));

// Email transport: capture calls without live SMTP/Resend.
const sendArtworkInquiry = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/lib/email", () => ({
  sendArtworkInquiry,
  sendOrderConfirmation: vi.fn(),
  sendOrderStatusUpdate: vi.fn(),
  sendConfirmationFailureNotice: vi.fn(),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import {
  clearAllStuckNonces,
  sweepUnsentInquiryEmails,
} from "@/lib/email-sweep";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = randomUUID().slice(0, 8);
let seq = 0;
const CREATED_TENANT_IDS: string[] = [];
const CREATED_ARTWORK_IDS: string[] = [];
const CREATED_INQUIRY_IDS: string[] = [];

function makeId(label: string) {
  return `t999-${RUN}-${++seq}-${label}`;
}

async function insertTenant(
  id: string,
  opts: { contactEmail?: string } = {},
): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Sweep Self-Heal Test Gallery",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: null,
    contactEmail: opts.contactEmail ?? "gallery@self-heal-test.example",
  } as any);
}

async function insertArtwork(id: string, tenantId: string): Promise<void> {
  CREATED_ARTWORK_IDS.push(id);
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork 999",
    sku: `sku-999-${RUN}-${id.slice(-6)}`,
    status: "AVAILABLE",
  } as any);
}

/**
 * Insert an inquiry in the stuck-nonce state:
 *   emailClaimNonce IS NOT NULL   — worker claimed it
 *   emailLastAttemptAt IS NULL    — worker crashed before the CAS stamp
 *   emailError IS NOT NULL        — row was previously attempted (has an error)
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
    artworkTitle: "Test Artwork 999",
    buyerName: "Stuck Buyer",
    buyerEmail: "stuck-buyer@example.com",
    message: "Interested in purchasing.",
    emailError: "connection reset by peer",
    emailAttempts: opts.emailAttempts ?? 1,
    emailLastAttemptAt:
      opts.emailLastAttemptAt !== undefined ? opts.emailLastAttemptAt : null,
    emailClaimNonce: randomUUID(), // simulates a crashed worker's dangling claim
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
  await cleanup();
});

afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration(
  "clearAllStuckNonces sweep self-heal — real DB (Task #999)",
  () => {
    // ── Scenario 1: auto-heal + deliver in same cycle ─────────────────────────

    it(
      "clears a stuck nonce globally and lets the very next sweep deliver the email",
      async () => {
        const tenantId = makeId("tenant-999a");
        await insertTenant(tenantId, {
          contactEmail: "gallery@999a.example",
        });

        const artworkId = makeId("artwork-999a");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq-999a");
        await insertStuckInquiry(inqId, tenantId, artworkId, {
          emailAttempts: 1,
        });

        // Pre-condition: row is stuck (nonce set, emailLastAttemptAt NULL)
        const rowBefore = await fetchRow(inqId);
        expect(rowBefore?.emailClaimNonce).not.toBeNull();
        expect(rowBefore?.emailLastAttemptAt).toBeNull();

        // Step 1 (what the sweep route does first): self-heal across all tenants
        const cleared = await clearAllStuckNonces();
        expect(cleared).toBeGreaterThanOrEqual(1); // our row must be among them

        const rowAfterHeal = await fetchRow(inqId);
        expect(rowAfterHeal?.emailClaimNonce).toBeNull(); // nonce released
        expect(rowAfterHeal?.emailLastAttemptAt).toBeNull(); // untouched
        expect(rowAfterHeal?.emailError).toBe("connection reset by peer"); // kept

        // Step 2 (what the sweep route does next): inquiry sweep can now deliver
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

    // ── Scenario 2: archived rows are NOT touched ─────────────────────────────

    it(
      "does NOT clear stuck nonces on archived inquiries",
      async () => {
        const tenantId = makeId("tenant-999b");
        await insertTenant(tenantId);

        const artworkId = makeId("artwork-999b");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq-999b");
        await insertStuckInquiry(inqId, tenantId, artworkId, {
          archivedAt: new Date("2024-01-01T00:00:00Z"),
        });

        // Self-heal should skip this row
        const nonceBeforeHeal = (await fetchRow(inqId))?.emailClaimNonce;
        expect(nonceBeforeHeal).not.toBeNull();

        await clearAllStuckNonces();

        const rowAfter = await fetchRow(inqId);
        expect(rowAfter?.emailClaimNonce).not.toBeNull(); // untouched
      },
    );

    // ── Scenario 3: active claims (emailLastAttemptAt IS NOT NULL) are safe ───

    it(
      "does NOT clear nonces on rows that have a live claim (emailLastAttemptAt IS NOT NULL)",
      async () => {
        const tenantId = makeId("tenant-999c");
        await insertTenant(tenantId);

        const artworkId = makeId("artwork-999c");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq-999c");
        // This row has BOTH nonce AND emailLastAttemptAt — an active live claim
        await insertStuckInquiry(inqId, tenantId, artworkId, {
          emailLastAttemptAt: new Date(),
        });

        const cleared = await clearAllStuckNonces();

        // Our live-claim row must not be among the cleared ones
        const rowAfter = await fetchRow(inqId);
        expect(rowAfter?.emailClaimNonce).not.toBeNull(); // untouched
        // (cleared may be 0 or reflect other stale rows from parallel tests)
        void cleared;
      },
    );

    // ── Scenario 4: clears across multiple tenants in one call ────────────────

    it(
      "clears stuck nonces for multiple tenants in a single call",
      async () => {
        const tenantA = makeId("tenant-999d-a");
        const tenantB = makeId("tenant-999d-b");
        await Promise.all([
          insertTenant(tenantA, { contactEmail: "a@999d.example" }),
          insertTenant(tenantB, { contactEmail: "b@999d.example" }),
        ]);

        const artworkA = makeId("artwork-999d-a");
        const artworkB = makeId("artwork-999d-b");
        await Promise.all([
          insertArtwork(artworkA, tenantA),
          insertArtwork(artworkB, tenantB),
        ]);

        const inqA = makeId("inq-999d-a");
        const inqB = makeId("inq-999d-b");
        await Promise.all([
          insertStuckInquiry(inqA, tenantA, artworkA),
          insertStuckInquiry(inqB, tenantB, artworkB),
        ]);

        const cleared = await clearAllStuckNonces();
        // Both rows from our test must be cleared in a single call
        expect(cleared).toBeGreaterThanOrEqual(2);

        const [rowA, rowB] = await Promise.all([
          fetchRow(inqA),
          fetchRow(inqB),
        ]);
        expect(rowA?.emailClaimNonce).toBeNull();
        expect(rowB?.emailClaimNonce).toBeNull();
      },
    );

    // ── Scenario 5: full end-to-end without any admin action ─────────────────

    it(
      "stuck inquiry is delivered end-to-end by the sweep cycle with no manual admin step",
      async () => {
        const tenantId = makeId("tenant-999e");
        await insertTenant(tenantId, {
          contactEmail: "gallery@999e.example",
        });

        const artworkId = makeId("artwork-999e");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq-999e");
        // Insert a stuck row — emailAttempts=1 so it is NOT exhausted
        await insertStuckInquiry(inqId, tenantId, artworkId, {
          emailAttempts: 1,
        });

        // Verify the sweep alone (before self-heal) would skip the row
        sendArtworkInquiry.mockResolvedValue(true);
        const preHealResult = await sweepUnsentInquiryEmails(
          new Date(),
          tenantId,
        );
        // The stuck nonce causes the CAS to fail; scanned may be 1 but sent=0
        expect(preHealResult.sent).toBe(0);
        expect(sendArtworkInquiry).not.toHaveBeenCalled();

        // Now simulate what the sweep route does: self-heal first, then sweep
        const cleared = await clearAllStuckNonces();
        expect(cleared).toBeGreaterThanOrEqual(1);

        sendArtworkInquiry.mockClear();
        const postHealResult = await sweepUnsentInquiryEmails(
          new Date(),
          tenantId,
        );
        expect(postHealResult.sent).toBe(1);
        expect(sendArtworkInquiry).toHaveBeenCalledTimes(1);

        const rowFinal = await fetchRow(inqId);
        expect(rowFinal?.emailError).toBeNull();
        expect(rowFinal?.emailClaimNonce).toBeNull();
      },
    );
  },
);
