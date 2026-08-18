/**
 * Task #1013 — Confirm the email-fail banner count is scoped to each
 * gallery's own inquiries only.
 *
 * Background:
 *   getEmailFailCount filters by tenantId from the session, so archiving one
 *   tenant's exhausted inquiry must have zero effect on any other tenant's
 *   banner count.  A missing WHERE clause or session-scope bug could
 *   silently reduce another gallery's number.
 *
 * Scenarios:
 *  1. Two-tenant isolation: Tenant A archives their exhausted inquiry →
 *     A's count drops to 0, B's count stays at 1.
 *  2. Archive row is scoped to Tenant A's DB row only (Tenant B's row is
 *     untouched: archivedAt remains NULL).
 *  3. Tenant B archiving their own inquiry does not affect Tenant A's count.
 *  4. Re-seeding a third tenant confirms counts are always per-session tenant.
 *
 * All assertions run against a real PostgreSQL database.
 * revalidatePath assertions use a vi.mock of next/cache.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable, inquiriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockSession = {
  userId: "u-1013-test",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test-1013",
}));

// Capture redirect calls as thrown errors so we can assert on the URL without
// actually navigating.
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

// Track revalidatePath calls.
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
  return `t1013-${RUN}-${++seq}-${label}`;
}

async function insertTenant(id: string): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Tenant-Scope Banner Test Gallery",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: null,
    contactEmail: "owner-1013@gallery.test",
  } as any);
}

async function insertArtwork(id: string, tenantId: string): Promise<void> {
  CREATED_ARTWORK_IDS.push(id);
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork 1013",
    sku: `sku-1013-${RUN}-${id.slice(-6)}`,
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
    artworkTitle: "Test Artwork 1013",
    buyerName: "Tenant-Scope Test Buyer",
    buyerEmail: "buyer-1013@example.com",
    message: "Is this available?",
    emailError: "smtp: connection refused (1013)",
    emailAttempts: MAX_EMAIL_ATTEMPTS,
    emailLastAttemptAt: new Date(Date.now() - 60_000),
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
  "email-fail banner count is scoped to each gallery's own inquiries only — real DB (Task #1013)",
  () => {
    // ── Scenario 1 ───────────────────────────────────────────────────────────

    it(
      "Tenant A archiving their exhausted inquiry drops A's count but leaves Tenant B's count unchanged",
      { timeout: 30_000 },
      async () => {
        // Seed Tenant A
        const tenantIdA = makeId("tenantA");
        await insertTenant(tenantIdA);
        const artworkIdA = makeId("artworkA");
        await insertArtwork(artworkIdA, tenantIdA);
        const inqIdA = makeId("inqA");
        await insertExhaustedInquiry(inqIdA, tenantIdA, artworkIdA);

        // Seed Tenant B
        const tenantIdB = makeId("tenantB");
        await insertTenant(tenantIdB);
        const artworkIdB = makeId("artworkB");
        await insertArtwork(artworkIdB, tenantIdB);
        const inqIdB = makeId("inqB");
        await insertExhaustedInquiry(inqIdB, tenantIdB, artworkIdB);

        // Pre-condition: both tenants have ≥ 1 exhausted inquiry in the banner.
        mockSession.tenantId = tenantIdA;
        const countABefore = await getEmailFailCount();
        expect(countABefore).toBeGreaterThanOrEqual(1);

        mockSession.tenantId = tenantIdB;
        const countBBefore = await getEmailFailCount();
        expect(countBBefore).toBeGreaterThanOrEqual(1);

        // Tenant A archives their inquiry.
        mockSession.tenantId = tenantIdA;
        await setInquiryArchived(archiveFormData(inqIdA, true));

        // Tenant A's count drops by 1.
        mockSession.tenantId = tenantIdA;
        const countAAfter = await getEmailFailCount();
        expect(countAAfter).toBe(countABefore - 1);

        // Tenant B's count is entirely unchanged.
        mockSession.tenantId = tenantIdB;
        const countBAfter = await getEmailFailCount();
        expect(countBAfter).toBe(countBBefore);
      },
    );

    // ── Scenario 2 ───────────────────────────────────────────────────────────

    it(
      "the archive DB update touches only Tenant A's row — Tenant B's inquiry row has archivedAt still NULL",
      { timeout: 30_000 },
      async () => {
        // Seed Tenant A
        const tenantIdA = makeId("tenantA2");
        await insertTenant(tenantIdA);
        const artworkIdA = makeId("artworkA2");
        await insertArtwork(artworkIdA, tenantIdA);
        const inqIdA = makeId("inqA2");
        await insertExhaustedInquiry(inqIdA, tenantIdA, artworkIdA);

        // Seed Tenant B
        const tenantIdB = makeId("tenantB2");
        await insertTenant(tenantIdB);
        const artworkIdB = makeId("artworkB2");
        await insertArtwork(artworkIdB, tenantIdB);
        const inqIdB = makeId("inqB2");
        await insertExhaustedInquiry(inqIdB, tenantIdB, artworkIdB);

        // Tenant A archives their inquiry.
        mockSession.tenantId = tenantIdA;
        await setInquiryArchived(archiveFormData(inqIdA, true));

        // Tenant A's row must have archivedAt set.
        const [rowA] = await db
          .select({ archivedAt: inquiriesTable.archivedAt })
          .from(inquiriesTable)
          .where(eq(inquiriesTable.id, inqIdA));
        expect(rowA).toBeDefined();
        expect(rowA!.archivedAt).not.toBeNull();

        // Tenant B's row must still have archivedAt = NULL.
        const [rowB] = await db
          .select({ archivedAt: inquiriesTable.archivedAt })
          .from(inquiriesTable)
          .where(eq(inquiriesTable.id, inqIdB));
        expect(rowB).toBeDefined();
        expect(rowB!.archivedAt).toBeNull();
      },
    );

    // ── Scenario 3 ───────────────────────────────────────────────────────────

    it(
      "Tenant B archiving their own inquiry does not affect Tenant A's count",
      { timeout: 30_000 },
      async () => {
        // Seed Tenant A
        const tenantIdA = makeId("tenantA3");
        await insertTenant(tenantIdA);
        const artworkIdA = makeId("artworkA3");
        await insertArtwork(artworkIdA, tenantIdA);
        const inqIdA = makeId("inqA3");
        await insertExhaustedInquiry(inqIdA, tenantIdA, artworkIdA);

        // Seed Tenant B
        const tenantIdB = makeId("tenantB3");
        await insertTenant(tenantIdB);
        const artworkIdB = makeId("artworkB3");
        await insertArtwork(artworkIdB, tenantIdB);
        const inqIdB = makeId("inqB3");
        await insertExhaustedInquiry(inqIdB, tenantIdB, artworkIdB);

        // Capture Tenant A's count before Tenant B takes any action.
        mockSession.tenantId = tenantIdA;
        const countABefore = await getEmailFailCount();
        expect(countABefore).toBeGreaterThanOrEqual(1);

        // Tenant B archives their inquiry.
        mockSession.tenantId = tenantIdB;
        await setInquiryArchived(archiveFormData(inqIdB, true));

        // Tenant A's count must be unaffected.
        mockSession.tenantId = tenantIdA;
        const countAAfter = await getEmailFailCount();
        expect(countAAfter).toBe(countABefore);
      },
    );

    // ── Scenario 4 ───────────────────────────────────────────────────────────

    it(
      "getEmailFailCount always reflects only the session tenant — three independent tenants",
      { timeout: 30_000 },
      async () => {
        // Seed three tenants each with one exhausted inquiry.
        const tenantIdA = makeId("tenantA4");
        const tenantIdB = makeId("tenantB4");
        const tenantIdC = makeId("tenantC4");
        await insertTenant(tenantIdA);
        await insertTenant(tenantIdB);
        await insertTenant(tenantIdC);

        const artworkIdA = makeId("artworkA4");
        const artworkIdB = makeId("artworkB4");
        const artworkIdC = makeId("artworkC4");
        await insertArtwork(artworkIdA, tenantIdA);
        await insertArtwork(artworkIdB, tenantIdB);
        await insertArtwork(artworkIdC, tenantIdC);

        const inqIdA = makeId("inqA4");
        const inqIdB = makeId("inqB4");
        const inqIdC = makeId("inqC4");
        await insertExhaustedInquiry(inqIdA, tenantIdA, artworkIdA);
        await insertExhaustedInquiry(inqIdB, tenantIdB, artworkIdB);
        await insertExhaustedInquiry(inqIdC, tenantIdC, artworkIdC);

        // Each tenant sees exactly their own count (≥ 1).
        mockSession.tenantId = tenantIdA;
        const countA = await getEmailFailCount();
        expect(countA).toBeGreaterThanOrEqual(1);

        mockSession.tenantId = tenantIdB;
        const countB = await getEmailFailCount();
        expect(countB).toBeGreaterThanOrEqual(1);

        mockSession.tenantId = tenantIdC;
        const countC = await getEmailFailCount();
        expect(countC).toBeGreaterThanOrEqual(1);

        // Tenant A archives — only A's count changes.
        mockSession.tenantId = tenantIdA;
        await setInquiryArchived(archiveFormData(inqIdA, true));

        mockSession.tenantId = tenantIdA;
        expect(await getEmailFailCount()).toBe(countA - 1);

        mockSession.tenantId = tenantIdB;
        expect(await getEmailFailCount()).toBe(countB);

        mockSession.tenantId = tenantIdC;
        expect(await getEmailFailCount()).toBe(countC);
      },
    );
  },
);
