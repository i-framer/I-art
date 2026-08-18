/**
 * Task #1010 — Confirm the email-fail banner disappears as soon as an
 * exhausted inquiry is archived.
 *
 * Background:
 *   getEmailFailCount filters out archived rows (isNull(archivedAt)), so
 *   archiving an exhausted inquiry should immediately reduce the banner count.
 *   This integration test confirms the full end-to-end path:
 *
 *     1. Seed an exhausted inquiry (emailAttempts = MAX_EMAIL_ATTEMPTS,
 *        emailError set, archivedAt IS NULL).
 *     2. getEmailFailCount returns ≥ 1 (banner is visible).
 *     3. setInquiryArchived is called via the server action (archived=true).
 *     4. getEmailFailCount drops immediately (archivedAt IS NOT NULL → excluded).
 *     5. revalidatePath("/inquiries") was called so Next.js purges the RSC
 *        cache for the inquiries route.
 *
 * Scenarios:
 *  1. Archiving an exhausted inquiry drops getEmailFailCount and calls
 *     revalidatePath("/inquiries").
 *  2. revalidatePath("/", "layout") is also called (keeps nav badge in sync).
 *  3. Unarchiving (archived=false) restores the banner count.
 *  4. Archiving a non-exhausted inquiry does NOT change getEmailFailCount
 *     (the row was never in the banner).
 *  5. Archiving one of two exhausted inquiries reduces the count by exactly 1,
 *     not to 0.
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
  userId: "u-1010-test",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test-1010",
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
import { setInquiryArchived } from "@/app/(admin)/(gated)/inquiries/actions";

// ── Helpers ───────────────────────────────────────────────────────────────────

const RUN = randomUUID().slice(0, 8);
let seq = 0;
const CREATED_TENANT_IDS: string[] = [];
const CREATED_ARTWORK_IDS: string[] = [];
const CREATED_INQUIRY_IDS: string[] = [];

function makeId(label: string) {
  return `t1010-${RUN}-${++seq}-${label}`;
}

async function insertTenant(id: string): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Archive Banner Test Gallery",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: null,
    contactEmail: "owner-1010@gallery.test",
  } as any);
}

async function insertArtwork(id: string, tenantId: string): Promise<void> {
  CREATED_ARTWORK_IDS.push(id);
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork 1010",
    sku: `sku-1010-${RUN}-${id.slice(-6)}`,
    status: "AVAILABLE",
  } as any);
}

/**
 * Insert an exhausted inquiry — all MAX_EMAIL_ATTEMPTS used, emailError set.
 * archivedAt is left NULL (not archived).
 */
async function insertExhaustedInquiry(
  id: string,
  tenantId: string,
  artworkId: string,
): Promise<void> {
  CREATED_INQUIRY_IDS.push(id);
  await db.insert(inquiriesTable).values({
    id,
    tenantId,
    artworkId,
    artworkTitle: "Test Artwork 1010",
    buyerName: "Archive Banner Test Buyer",
    buyerEmail: "buyer-1010@example.com",
    message: "Is this available?",
    emailError: "smtp: connection refused (1010)",
    emailAttempts: MAX_EMAIL_ATTEMPTS,
    emailLastAttemptAt: new Date(Date.now() - 60_000),
    status: "NEW",
  } as any);
}

/**
 * Insert a healthy (non-exhausted) inquiry — emailAttempts < MAX and no error.
 */
async function insertHealthyInquiry(
  id: string,
  tenantId: string,
  artworkId: string,
): Promise<void> {
  CREATED_INQUIRY_IDS.push(id);
  await db.insert(inquiriesTable).values({
    id,
    tenantId,
    artworkId,
    artworkTitle: "Test Artwork 1010",
    buyerName: "Healthy Buyer 1010",
    buyerEmail: "healthy-1010@example.com",
    message: "Just browsing.",
    emailAttempts: 0,
    status: "NEW",
  } as any);
}

/**
 * Build a FormData object for setInquiryArchived.
 */
function archiveFormData(inquiryId: string, archived: boolean): FormData {
  const fd = new FormData();
  fd.set("inquiryId", inquiryId);
  fd.set("archived", String(archived));
  return fd;
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
  "Email-fail banner disappears immediately when an exhausted inquiry is archived — real DB (Task #1010)",
  () => {
    // ── Scenario 1 ───────────────────────────────────────────────────────────

    it(
      "archiving an exhausted inquiry drops getEmailFailCount immediately and calls revalidatePath('/inquiries')",
      { timeout: 30_000 },
      async () => {
        const tenantId = makeId("tenant-1010a");
        await insertTenant(tenantId);

        const artworkId = makeId("artwork-1010a");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq-1010a");
        await insertExhaustedInquiry(inqId, tenantId, artworkId);

        mockSession.tenantId = tenantId;

        // Pre-condition: banner shows the exhausted row.
        const countBefore = await getEmailFailCount();
        expect(countBefore).toBeGreaterThanOrEqual(1);

        // Archive the inquiry via the server action.
        await setInquiryArchived(archiveFormData(inqId, true));

        // The DB now excludes the archived row from the fail count.
        const countAfter = await getEmailFailCount();
        expect(countAfter).toBe(countBefore - 1);

        // revalidatePath("/inquiries") must be called so Next.js purges the
        // cached RSC output — the banner can't serve a stale count.
        expect(revalidatePath).toHaveBeenCalledWith("/inquiries");
      },
    );

    // ── Scenario 2 ───────────────────────────────────────────────────────────

    it(
      "setInquiryArchived also calls revalidatePath('/', 'layout') to keep the nav badge in sync",
      { timeout: 30_000 },
      async () => {
        const tenantId = makeId("tenant-1010b");
        await insertTenant(tenantId);

        const artworkId = makeId("artwork-1010b");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq-1010b");
        await insertExhaustedInquiry(inqId, tenantId, artworkId);

        mockSession.tenantId = tenantId;

        await setInquiryArchived(archiveFormData(inqId, true));

        expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
      },
    );

    // ── Scenario 3 ───────────────────────────────────────────────────────────

    it(
      "unarchiving (archived=false) restores the exhausted inquiry to the banner count",
      { timeout: 30_000 },
      async () => {
        const tenantId = makeId("tenant-1010c");
        await insertTenant(tenantId);

        const artworkId = makeId("artwork-1010c");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq-1010c");
        await insertExhaustedInquiry(inqId, tenantId, artworkId);

        mockSession.tenantId = tenantId;

        const countBefore = await getEmailFailCount();
        expect(countBefore).toBeGreaterThanOrEqual(1);

        // Archive it — count drops.
        await setInquiryArchived(archiveFormData(inqId, true));
        const countAfterArchive = await getEmailFailCount();
        expect(countAfterArchive).toBe(countBefore - 1);

        vi.clearAllMocks();

        // Unarchive it — count rises back to where it was.
        await setInquiryArchived(archiveFormData(inqId, false));
        const countAfterUnarchive = await getEmailFailCount();
        expect(countAfterUnarchive).toBe(countBefore);

        // revalidatePath is also called on unarchive.
        expect(revalidatePath).toHaveBeenCalledWith("/inquiries");
      },
    );

    // ── Scenario 4 ───────────────────────────────────────────────────────────

    it(
      "archiving a non-exhausted inquiry does NOT change getEmailFailCount",
      { timeout: 30_000 },
      async () => {
        const tenantId = makeId("tenant-1010d");
        await insertTenant(tenantId);

        const artworkId = makeId("artwork-1010d");
        await insertArtwork(artworkId, tenantId);

        // Healthy inquiry — no emailError, emailAttempts < MAX.
        const healthyId = makeId("inq-1010d-healthy");
        await insertHealthyInquiry(healthyId, tenantId, artworkId);

        mockSession.tenantId = tenantId;

        const countBefore = await getEmailFailCount();

        // Archive the healthy inquiry.
        await setInquiryArchived(archiveFormData(healthyId, true));

        // getEmailFailCount must be unchanged — the healthy row was never in
        // the exhausted bucket.
        const countAfter = await getEmailFailCount();
        expect(countAfter).toBe(countBefore);

        // revalidatePath is still called (the inquiries list itself changed).
        expect(revalidatePath).toHaveBeenCalledWith("/inquiries");
      },
    );

    // ── Scenario 5 ───────────────────────────────────────────────────────────

    it(
      "archiving one of two exhausted inquiries reduces the count by exactly 1, not to 0",
      { timeout: 30_000 },
      async () => {
        const tenantId = makeId("tenant-1010e");
        await insertTenant(tenantId);

        const artworkId = makeId("artwork-1010e");
        await insertArtwork(artworkId, tenantId);

        const inqIdA = makeId("inq-1010e-a");
        const inqIdB = makeId("inq-1010e-b");
        await insertExhaustedInquiry(inqIdA, tenantId, artworkId);
        await insertExhaustedInquiry(inqIdB, tenantId, artworkId);

        mockSession.tenantId = tenantId;

        const countBefore = await getEmailFailCount();
        expect(countBefore).toBeGreaterThanOrEqual(2);

        // Archive only the first inquiry.
        await setInquiryArchived(archiveFormData(inqIdA, true));

        const countAfter = await getEmailFailCount();
        // Down by exactly 1; the second exhausted inquiry is still counted.
        expect(countAfter).toBe(countBefore - 1);
        expect(countAfter).toBeGreaterThanOrEqual(1);
      },
    );
  },
);
