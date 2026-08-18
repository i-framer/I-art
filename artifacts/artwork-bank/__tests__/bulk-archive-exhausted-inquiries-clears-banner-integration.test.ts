/**
 * Task #1012 — Confirm bulk-archiving exhausted inquiries also clears the
 * email-fail banner in one action.
 *
 * Background:
 *   getEmailFailCount filters out archived rows (isNull(archivedAt)), so
 *   bulk-archiving exhausted inquiries via bulkSetInquiriesArchived should
 *   immediately reduce the banner count by the number of archived rows.
 *   This integration test confirms the full end-to-end path:
 *
 *     1. Seed two or more exhausted inquiries (emailAttempts = MAX_EMAIL_ATTEMPTS,
 *        emailError set, archivedAt IS NULL).
 *     2. getEmailFailCount returns ≥ 2 (banner is visible).
 *     3. bulkSetInquiriesArchived is called with both IDs (archived=true).
 *     4. getEmailFailCount drops by the exact number of archived rows.
 *     5. revalidatePath("/inquiries") is called so Next.js purges the RSC
 *        cache for the inquiries route.
 *
 * Scenarios:
 *  1. Bulk-archiving two exhausted inquiries drops getEmailFailCount by 2 and
 *     calls revalidatePath("/inquiries").
 *  2. revalidatePath("/", "layout") is also called (keeps nav badge in sync).
 *  3. Bulk-archiving only exhausted rows from a mixed set drops count by exactly
 *     the number of exhausted rows archived (healthy rows don't affect the count).
 *  4. Bulk-archiving one of three exhausted inquiries reduces the count by 1,
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
  userId: "u-1012-test",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test-1012",
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
  return `t1012-${RUN}-${++seq}-${label}`;
}

async function insertTenant(id: string): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Bulk Archive Banner Test Gallery",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: null,
    contactEmail: "owner-1012@gallery.test",
  } as any);
}

async function insertArtwork(id: string, tenantId: string): Promise<void> {
  CREATED_ARTWORK_IDS.push(id);
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork 1012",
    sku: `sku-1012-${RUN}-${id.slice(-6)}`,
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
    artworkTitle: "Test Artwork 1012",
    buyerName: "Bulk Archive Test Buyer",
    buyerEmail: "buyer-1012@example.com",
    message: "Is this available?",
    emailError: "smtp: connection refused (1012)",
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
    artworkTitle: "Test Artwork 1012",
    buyerName: "Healthy Buyer 1012",
    buyerEmail: "healthy-1012@example.com",
    message: "Just browsing.",
    emailAttempts: 0,
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
  "Bulk-archiving exhausted inquiries clears the email-fail banner — real DB (Task #1012)",
  () => {
    // ── Scenario 1 ───────────────────────────────────────────────────────────

    it(
      "bulk-archiving two exhausted inquiries drops getEmailFailCount by 2 and calls revalidatePath('/inquiries')",
      { timeout: 30_000 },
      async () => {
        const tenantId = makeId("tenant-1012a");
        await insertTenant(tenantId);

        const artworkId = makeId("artwork-1012a");
        await insertArtwork(artworkId, tenantId);

        const inqIdA = makeId("inq-1012a-1");
        const inqIdB = makeId("inq-1012a-2");
        await insertExhaustedInquiry(inqIdA, tenantId, artworkId);
        await insertExhaustedInquiry(inqIdB, tenantId, artworkId);

        mockSession.tenantId = tenantId;

        // Pre-condition: banner shows both exhausted rows.
        const countBefore = await getEmailFailCount();
        expect(countBefore).toBeGreaterThanOrEqual(2);

        // Bulk-archive both inquiries via the server action.
        await bulkSetInquiriesArchived([inqIdA, inqIdB], true);

        // The DB now excludes both archived rows from the fail count.
        const countAfter = await getEmailFailCount();
        expect(countAfter).toBe(countBefore - 2);

        // revalidatePath("/inquiries") must be called so Next.js purges the
        // cached RSC output — the banner can't serve a stale count.
        expect(revalidatePath).toHaveBeenCalledWith("/inquiries");
      },
    );

    // ── Scenario 2 ───────────────────────────────────────────────────────────

    it(
      "bulkSetInquiriesArchived also calls revalidatePath('/', 'layout') to keep the nav badge in sync",
      { timeout: 30_000 },
      async () => {
        const tenantId = makeId("tenant-1012b");
        await insertTenant(tenantId);

        const artworkId = makeId("artwork-1012b");
        await insertArtwork(artworkId, tenantId);

        const inqIdA = makeId("inq-1012b-1");
        const inqIdB = makeId("inq-1012b-2");
        await insertExhaustedInquiry(inqIdA, tenantId, artworkId);
        await insertExhaustedInquiry(inqIdB, tenantId, artworkId);

        mockSession.tenantId = tenantId;

        await bulkSetInquiriesArchived([inqIdA, inqIdB], true);

        expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
      },
    );

    // ── Scenario 3 ───────────────────────────────────────────────────────────

    it(
      "bulk-archiving a mixed set (exhausted + healthy) drops the fail count only by the number of exhausted rows",
      { timeout: 30_000 },
      async () => {
        const tenantId = makeId("tenant-1012c");
        await insertTenant(tenantId);

        const artworkId = makeId("artwork-1012c");
        await insertArtwork(artworkId, tenantId);

        const exhaustedId = makeId("inq-1012c-exhausted");
        const healthyId = makeId("inq-1012c-healthy");
        await insertExhaustedInquiry(exhaustedId, tenantId, artworkId);
        await insertHealthyInquiry(healthyId, tenantId, artworkId);

        mockSession.tenantId = tenantId;

        const countBefore = await getEmailFailCount();
        expect(countBefore).toBeGreaterThanOrEqual(1);

        // Bulk-archive both — only the exhausted row affects getEmailFailCount.
        await bulkSetInquiriesArchived([exhaustedId, healthyId], true);

        const countAfter = await getEmailFailCount();
        // Drops by exactly 1 (the exhausted row), not 2.
        expect(countAfter).toBe(countBefore - 1);

        expect(revalidatePath).toHaveBeenCalledWith("/inquiries");
      },
    );

    // ── Scenario 4 ───────────────────────────────────────────────────────────

    it(
      "bulk-archiving one of three exhausted inquiries reduces the count by exactly 1, not to 0",
      { timeout: 30_000 },
      async () => {
        const tenantId = makeId("tenant-1012d");
        await insertTenant(tenantId);

        const artworkId = makeId("artwork-1012d");
        await insertArtwork(artworkId, tenantId);

        const inqIdA = makeId("inq-1012d-a");
        const inqIdB = makeId("inq-1012d-b");
        const inqIdC = makeId("inq-1012d-c");
        await insertExhaustedInquiry(inqIdA, tenantId, artworkId);
        await insertExhaustedInquiry(inqIdB, tenantId, artworkId);
        await insertExhaustedInquiry(inqIdC, tenantId, artworkId);

        mockSession.tenantId = tenantId;

        const countBefore = await getEmailFailCount();
        expect(countBefore).toBeGreaterThanOrEqual(3);

        // Archive only the first inquiry.
        await bulkSetInquiriesArchived([inqIdA], true);

        const countAfter = await getEmailFailCount();
        // Down by exactly 1; the other two exhausted inquiries are still counted.
        expect(countAfter).toBe(countBefore - 1);
        expect(countAfter).toBeGreaterThanOrEqual(2);
      },
    );
  },
);
