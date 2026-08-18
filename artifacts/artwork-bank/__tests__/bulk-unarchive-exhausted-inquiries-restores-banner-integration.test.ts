/**
 * Task #1016 — Confirm bulk un-archiving exhausted inquiries restores the
 * email-fail banner count.
 *
 * Background:
 *   getEmailFailCount filters out archived rows (isNull(archivedAt)).  Calling
 *   bulkSetInquiriesArchived(ids, true) drops the count (confirmed by Task #1012).
 *   The reverse — bulkSetInquiriesArchived(ids, false) — should restore the
 *   count by setting archivedAt back to NULL, making previously-archived
 *   exhausted inquiries visible to getEmailFailCount again.
 *
 * Scenarios:
 *  1. Un-archiving two exhausted inquiries raises getEmailFailCount by 2 and
 *     calls revalidatePath("/inquiries").
 *  2. revalidatePath("/", "layout") is also called (keeps nav badge in sync).
 *  3. Un-archiving a mixed set (exhausted + healthy archived rows) raises the
 *     count only by the number of exhausted rows.
 *  4. Un-archiving one of three archived exhausted inquiries raises the count
 *     by exactly 1, not to the full 3.
 *
 * All count assertions run against a real PostgreSQL database.
 * revalidatePath assertions use a vi.mock of next/cache so they are verified
 * without a live Next.js renderer.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable, inquiriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockSession = {
  userId: "u-1016-test",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test-1016",
}));

// Capture redirect calls as thrown errors so we can assert on the URL without
// actually navigating.
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

// Track revalidatePath calls — the core assertion of this test.
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath }));

vi.mock("@/lib/base-url", () => ({
  getTenantUrl: (_tenant: unknown, path: string) =>
    `https://gallery.test${path}`,
  getPlatformBaseUrl: () => "https://platform.test",
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { MAX_EMAIL_ATTEMPTS } from "@/lib/email-sweep";
import { getEmailFailCount } from "@/app/(admin)/_actions/inquiry-count";
import { bulkSetInquiriesArchived } from "@/app/(admin)/(gated)/inquiries/actions";

// ── Helpers ───────────────────────────────────────────────────────────────────

const RUN = randomUUID().slice(0, 8);
let seq = 0;
const CREATED_TENANT_IDS: string[] = [];
const CREATED_ARTWORK_IDS: string[] = [];
const CREATED_INQUIRY_IDS: string[] = [];

function makeId(label: string) {
  return `t1016-${RUN}-${++seq}-${label}`;
}

async function insertTenant(id: string): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Bulk Un-Archive Banner Test Gallery",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: null,
    contactEmail: "owner-1016@gallery.test",
  } as any);
}

async function insertArtwork(id: string, tenantId: string): Promise<void> {
  CREATED_ARTWORK_IDS.push(id);
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork 1016",
    sku: `sku-1016-${RUN}-${id.slice(-6)}`,
    status: "AVAILABLE",
  } as any);
}

/**
 * Insert an exhausted inquiry that is already archived.
 * archivedAt is set to a past date so it's excluded from getEmailFailCount
 * until it's un-archived.
 */
async function insertArchivedExhaustedInquiry(
  id: string,
  tenantId: string,
  artworkId: string,
): Promise<void> {
  CREATED_INQUIRY_IDS.push(id);
  await db.insert(inquiriesTable).values({
    id,
    tenantId,
    artworkId,
    artworkTitle: "Test Artwork 1016",
    buyerName: "Bulk Un-Archive Test Buyer",
    buyerEmail: "buyer-1016@example.com",
    message: "Is this still available?",
    emailError: "smtp: connection refused (1016)",
    emailAttempts: MAX_EMAIL_ATTEMPTS,
    emailLastAttemptAt: new Date(Date.now() - 60_000),
    archivedAt: new Date(Date.now() - 120_000),
    status: "NEW",
  } as any);
}

/**
 * Insert an archived healthy (non-exhausted) inquiry.
 */
async function insertArchivedHealthyInquiry(
  id: string,
  tenantId: string,
  artworkId: string,
): Promise<void> {
  CREATED_INQUIRY_IDS.push(id);
  await db.insert(inquiriesTable).values({
    id,
    tenantId,
    artworkId,
    artworkTitle: "Test Artwork 1016",
    buyerName: "Healthy Archived Buyer 1016",
    buyerEmail: "healthy-1016@example.com",
    message: "Just browsing.",
    emailAttempts: 0,
    archivedAt: new Date(Date.now() - 120_000),
    status: "NEW",
  } as any);
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
  "Bulk un-archiving exhausted inquiries restores the email-fail banner count — real DB (Task #1016)",
  () => {
    // ── Scenario 1 ───────────────────────────────────────────────────────────

    it(
      "un-archiving two exhausted inquiries raises getEmailFailCount by 2 and calls revalidatePath('/inquiries')",
      { timeout: 30_000 },
      async () => {
        const tenantId = makeId("tenant-1016a");
        await insertTenant(tenantId);

        const artworkId = makeId("artwork-1016a");
        await insertArtwork(artworkId, tenantId);

        const inqIdA = makeId("inq-1016a-1");
        const inqIdB = makeId("inq-1016a-2");
        await insertArchivedExhaustedInquiry(inqIdA, tenantId, artworkId);
        await insertArchivedExhaustedInquiry(inqIdB, tenantId, artworkId);

        mockSession.tenantId = tenantId;

        // Pre-condition: both inquiries are archived, so neither appears in the
        // fail count.
        const countBefore = await getEmailFailCount();
        expect(countBefore).toBe(0);

        // Un-archive both inquiries — should restore both to the count.
        await bulkSetInquiriesArchived([inqIdA, inqIdB], false);

        // The DB now includes both restored rows in the fail count.
        const countAfter = await getEmailFailCount();
        expect(countAfter).toBe(countBefore + 2);

        // revalidatePath("/inquiries") must be called so Next.js purges the
        // cached RSC output — the banner needs a fresh count.
        expect(revalidatePath).toHaveBeenCalledWith("/inquiries");
      },
    );

    // ── Scenario 2 ───────────────────────────────────────────────────────────

    it(
      "bulkSetInquiriesArchived(ids, false) also calls revalidatePath('/', 'layout') to keep the nav badge in sync",
      { timeout: 30_000 },
      async () => {
        const tenantId = makeId("tenant-1016b");
        await insertTenant(tenantId);

        const artworkId = makeId("artwork-1016b");
        await insertArtwork(artworkId, tenantId);

        const inqIdA = makeId("inq-1016b-1");
        const inqIdB = makeId("inq-1016b-2");
        await insertArchivedExhaustedInquiry(inqIdA, tenantId, artworkId);
        await insertArchivedExhaustedInquiry(inqIdB, tenantId, artworkId);

        mockSession.tenantId = tenantId;

        await bulkSetInquiriesArchived([inqIdA, inqIdB], false);

        expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
      },
    );

    // ── Scenario 3 ───────────────────────────────────────────────────────────

    it(
      "un-archiving a mixed set (exhausted + healthy archived rows) raises the count only by the number of exhausted rows",
      { timeout: 30_000 },
      async () => {
        const tenantId = makeId("tenant-1016c");
        await insertTenant(tenantId);

        const artworkId = makeId("artwork-1016c");
        await insertArtwork(artworkId, tenantId);

        const exhaustedId = makeId("inq-1016c-exhausted");
        const healthyId = makeId("inq-1016c-healthy");
        await insertArchivedExhaustedInquiry(exhaustedId, tenantId, artworkId);
        await insertArchivedHealthyInquiry(healthyId, tenantId, artworkId);

        mockSession.tenantId = tenantId;

        // Pre-condition: both archived, fail count is 0.
        const countBefore = await getEmailFailCount();
        expect(countBefore).toBe(0);

        // Un-archive both — only the exhausted row affects getEmailFailCount.
        await bulkSetInquiriesArchived([exhaustedId, healthyId], false);

        const countAfter = await getEmailFailCount();
        // Rises by exactly 1 (the exhausted row), not 2.
        expect(countAfter).toBe(countBefore + 1);

        expect(revalidatePath).toHaveBeenCalledWith("/inquiries");
      },
    );

    // ── Scenario 4 ───────────────────────────────────────────────────────────

    it(
      "un-archiving one of three archived exhausted inquiries raises the count by exactly 1, not to 3",
      { timeout: 30_000 },
      async () => {
        const tenantId = makeId("tenant-1016d");
        await insertTenant(tenantId);

        const artworkId = makeId("artwork-1016d");
        await insertArtwork(artworkId, tenantId);

        const inqIdA = makeId("inq-1016d-a");
        const inqIdB = makeId("inq-1016d-b");
        const inqIdC = makeId("inq-1016d-c");
        await insertArchivedExhaustedInquiry(inqIdA, tenantId, artworkId);
        await insertArchivedExhaustedInquiry(inqIdB, tenantId, artworkId);
        await insertArchivedExhaustedInquiry(inqIdC, tenantId, artworkId);

        mockSession.tenantId = tenantId;

        // Pre-condition: all three are archived, fail count is 0.
        const countBefore = await getEmailFailCount();
        expect(countBefore).toBe(0);

        // Un-archive only the first inquiry.
        await bulkSetInquiriesArchived([inqIdA], false);

        const countAfter = await getEmailFailCount();
        // Rises by exactly 1; the other two remain archived and invisible.
        expect(countAfter).toBe(countBefore + 1);
        expect(countAfter).toBe(1);
      },
    );

    // ── Scenario 5 (round-trip) ───────────────────────────────────────────────

    it(
      "archive then un-archive returns getEmailFailCount to the original value",
      { timeout: 30_000 },
      async () => {
        const tenantId = makeId("tenant-1016e");
        await insertTenant(tenantId);

        const artworkId = makeId("artwork-1016e");
        await insertArtwork(artworkId, tenantId);

        // Seed two exhausted inquiries that are NOT yet archived.
        const inqIdA = makeId("inq-1016e-1");
        const inqIdB = makeId("inq-1016e-2");
        CREATED_INQUIRY_IDS.push(inqIdA, inqIdB);
        await db.insert(inquiriesTable).values([
          {
            id: inqIdA,
            tenantId,
            artworkId,
            artworkTitle: "Test Artwork 1016",
            buyerName: "Round-Trip Buyer 1016",
            buyerEmail: "rt-1016@example.com",
            message: "Round trip test A",
            emailError: "smtp: connection refused (1016-rt)",
            emailAttempts: MAX_EMAIL_ATTEMPTS,
            emailLastAttemptAt: new Date(Date.now() - 60_000),
            status: "NEW",
          } as any,
          {
            id: inqIdB,
            tenantId,
            artworkId,
            artworkTitle: "Test Artwork 1016",
            buyerName: "Round-Trip Buyer 1016",
            buyerEmail: "rt-1016@example.com",
            message: "Round trip test B",
            emailError: "smtp: connection refused (1016-rt)",
            emailAttempts: MAX_EMAIL_ATTEMPTS,
            emailLastAttemptAt: new Date(Date.now() - 60_000),
            status: "NEW",
          } as any,
        ]);

        mockSession.tenantId = tenantId;

        // Baseline: both visible in the fail count.
        const countBaseline = await getEmailFailCount();
        expect(countBaseline).toBeGreaterThanOrEqual(2);

        // Archive → count drops.
        await bulkSetInquiriesArchived([inqIdA, inqIdB], true);
        const countAfterArchive = await getEmailFailCount();
        expect(countAfterArchive).toBe(countBaseline - 2);

        // Un-archive → count is fully restored.
        vi.clearAllMocks();
        await bulkSetInquiriesArchived([inqIdA, inqIdB], false);
        const countAfterUnarchive = await getEmailFailCount();
        expect(countAfterUnarchive).toBe(countBaseline);

        // revalidatePath must be called on the un-archive pass too.
        expect(revalidatePath).toHaveBeenCalledWith("/inquiries");
        expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
      },
    );
  },
);
