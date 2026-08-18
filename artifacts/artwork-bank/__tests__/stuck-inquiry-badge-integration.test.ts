/**
 * Task #998 — Confirm stuck inquiries still show an error badge before the
 * admin fixes them
 *
 * A "stuck-nonce" inquiry has:
 *   emailClaimNonce IS NOT NULL  AND  emailLastAttemptAt IS NULL
 *
 * The Inquiries page derives the badge label via getInquiryEmailBadgeLabel()
 * (lib/inquiry-badge.ts), which is imported here so any change to that
 * function's output strings immediately breaks the corresponding assertion.
 *
 * Scenarios covered:
 *  1. A stuck-nonce inquiry with emailAttempts < MAX renders BADGE_RETRYING
 *     while the nonce is still set (pre-clear state visible to an admin).
 *  2. A stuck-nonce inquiry with emailAttempts >= MAX renders BADGE_PERMANENT.
 *  3. getStuckNonceCount() is non-zero before clearing.
 *  4. After clearStuckNonces the nonce is gone but badge fields are intact —
 *     the page still shows the correct badge until the sweep re-delivers.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable, inquiriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  getInquiryEmailBadgeLabel,
  BADGE_RETRYING,
  BADGE_PERMANENT,
} from "@/lib/inquiry-badge";
import { MAX_EMAIL_ATTEMPTS } from "@/lib/email-sweep";

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockSession = {
  userId: "u-998-test",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { clearStuckNonces } from "@/lib/email-sweep";
import { getStuckNonceCount } from "@/app/(admin)/_actions/inquiry-count";

// ── Helpers ───────────────────────────────────────────────────────────────────

const RUN = randomUUID().slice(0, 8);
let seq = 0;
const CREATED_TENANT_IDS: string[] = [];
const CREATED_ARTWORK_IDS: string[] = [];
const CREATED_INQUIRY_IDS: string[] = [];

function makeId(label: string) {
  return `t998-${RUN}-${++seq}-${label}`;
}

async function insertTenant(id: string): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Badge Test Gallery",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: null,
    contactEmail: "gallery@badge-test.example",
  } as any);
}

async function insertArtwork(id: string, tenantId: string): Promise<void> {
  CREATED_ARTWORK_IDS.push(id);
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork 998",
    sku: `sku-998-${RUN}-${id.slice(-6)}`,
    status: "AVAILABLE",
  } as any);
}

/**
 * Insert a stuck-nonce inquiry:
 *   – emailClaimNonce IS NOT NULL  (worker claimed it)
 *   – emailLastAttemptAt IS NULL   (worker crashed before stamping the CAS)
 *   – emailError set               (prior SMTP failure)
 *   – emailAttempts configurable   (controls which badge branch the page uses)
 */
async function insertStuckInquiry(
  id: string,
  tenantId: string,
  artworkId: string,
  opts: { emailAttempts?: number } = {},
): Promise<void> {
  CREATED_INQUIRY_IDS.push(id);
  await db.insert(inquiriesTable).values({
    id,
    tenantId,
    artworkId,
    artworkTitle: "Test Artwork 998",
    buyerName: "Stuck Buyer",
    buyerEmail: "stuck-buyer@badge-test.example",
    message: "Interested in purchasing.",
    emailError: "connection reset by peer",
    emailAttempts: opts.emailAttempts ?? 1,
    emailLastAttemptAt: null, // distinguishing stuck-nonce condition
    emailClaimNonce: randomUUID(), // simulates a crashed worker's claim
    archivedAt: null,
    status: "NEW",
  } as any);
}

/** Re-run the same select the page uses: pull the full inquiry row. */
async function fetchPageRow(id: string) {
  return db.query.inquiriesTable.findFirst({
    where: eq(inquiriesTable.id, id),
  });
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

async function cleanup() {
  for (const id of CREATED_INQUIRY_IDS.splice(0)) {
    await db.delete(inquiriesTable).where(eq(inquiriesTable.id, id)).catch(() => {});
  }
  for (const id of CREATED_ARTWORK_IDS.splice(0)) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of CREATED_TENANT_IDS.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(async () => {
  vi.clearAllMocks();
  await cleanup();
});

afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration(
  "Stuck inquiry badge state — real DB (Task #998)",
  () => {
    // ── Scenario 1: "retrying" badge while nonce is still set ────────────────
    //
    // The page renders BADGE_RETRYING when emailError is set and
    // emailAttempts < MAX_EMAIL_ATTEMPTS.  This is the pre-clear state an
    // admin sees on the Inquiries page before clicking "Clear stuck nonces".

    it(
      "stuck inquiry with emailAttempts < MAX shows the retrying badge before clearing",
      async () => {
        const tenantId = makeId("tenant-998a");
        await insertTenant(tenantId);
        const artworkId = makeId("artwork-998a");
        await insertArtwork(artworkId, tenantId);

        // emailAttempts=1 is well below MAX_EMAIL_ATTEMPTS
        const inqId = makeId("inq-998a");
        await insertStuckInquiry(inqId, tenantId, artworkId, { emailAttempts: 1 });

        mockSession.tenantId = tenantId;

        // Fetch the row via the same query path the page uses
        const row = await fetchPageRow(inqId);
        expect(row).toBeDefined();

        // The nonce is still set — this is the stuck pre-clear state
        expect(row!.emailClaimNonce).not.toBeNull();

        // Apply the badge helper the page uses and assert the exact label
        const badge = getInquiryEmailBadgeLabel(row!.emailError, row!.emailAttempts);
        expect(badge).toBe(BADGE_RETRYING);
        // Confirm it is NOT the permanently-failed label
        expect(badge).not.toBe(BADGE_PERMANENT);
      },
    );

    // ── Scenario 2: "permanently failed" badge ───────────────────────────────
    //
    // When emailAttempts >= MAX_EMAIL_ATTEMPTS the page renders BADGE_PERMANENT.

    it(
      "stuck inquiry with emailAttempts >= MAX shows the permanently-failed badge",
      async () => {
        const tenantId = makeId("tenant-998b");
        await insertTenant(tenantId);
        const artworkId = makeId("artwork-998b");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq-998b");
        await insertStuckInquiry(inqId, tenantId, artworkId, {
          emailAttempts: MAX_EMAIL_ATTEMPTS,
        });

        mockSession.tenantId = tenantId;

        const row = await fetchPageRow(inqId);
        expect(row).toBeDefined();
        expect(row!.emailClaimNonce).not.toBeNull();

        const badge = getInquiryEmailBadgeLabel(row!.emailError, row!.emailAttempts);
        expect(badge).toBe(BADGE_PERMANENT);
        expect(badge).not.toBe(BADGE_RETRYING);
      },
    );

    // ── Scenario 3: getStuckNonceCount is non-zero before clearing ───────────

    it(
      "getStuckNonceCount is non-zero while a stuck inquiry exists",
      async () => {
        const tenantId = makeId("tenant-998c");
        await insertTenant(tenantId);
        const artworkId = makeId("artwork-998c");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq-998c");
        await insertStuckInquiry(inqId, tenantId, artworkId, { emailAttempts: 1 });

        mockSession.tenantId = tenantId;

        const countBefore = await getStuckNonceCount();
        expect(countBefore).toBeGreaterThanOrEqual(1);
      },
    );

    // ── Scenario 4: badge fields survive clearStuckNonces; count drops to 0 ──
    //
    // clearStuckNonces only wipes emailClaimNonce.  The badge fields
    // (emailError, emailAttempts) must remain intact so the page still shows
    // the correct badge until the sweep successfully re-delivers.

    it(
      "badge label is still correct after clearStuckNonces — only the nonce is wiped",
      async () => {
        const tenantId = makeId("tenant-998d");
        await insertTenant(tenantId);
        const artworkId = makeId("artwork-998d");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq-998d");
        await insertStuckInquiry(inqId, tenantId, artworkId, { emailAttempts: 1 });

        mockSession.tenantId = tenantId;

        // Pre-clear: banner count is non-zero
        const countBefore = await getStuckNonceCount();
        expect(countBefore).toBeGreaterThanOrEqual(1);

        // Pre-clear: badge label is correct on the row the page would render
        const rowBefore = await fetchPageRow(inqId);
        expect(rowBefore!.emailClaimNonce).not.toBeNull();
        expect(getInquiryEmailBadgeLabel(rowBefore!.emailError, rowBefore!.emailAttempts))
          .toBe(BADGE_RETRYING);

        // Clear the stuck nonce
        const cleared = await clearStuckNonces(tenantId);
        expect(cleared).toBe(1);

        // Post-clear: banner count drops to 0
        const countAfter = await getStuckNonceCount();
        expect(countAfter).toBe(0);

        // Post-clear: nonce is gone, but badge label is still correct
        const rowAfter = await fetchPageRow(inqId);
        expect(rowAfter!.emailClaimNonce).toBeNull();
        expect(getInquiryEmailBadgeLabel(rowAfter!.emailError, rowAfter!.emailAttempts))
          .toBe(BADGE_RETRYING);
      },
    );
  },
);
