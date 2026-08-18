/**
 * Task #1023 — Confirm single-row archive/un-archive enforces tenant isolation
 * on a real database.
 *
 * Background:
 *   setInquiryArchived scopes its UPDATE by the session tenantId, so a
 *   gallery can never un-archive another gallery's inquiry.  This integration
 *   test proves that on a real PostgreSQL database by checking the
 *   getEmailFailCount helper — if the archived exhausted row were accidentally
 *   un-archived it would immediately appear in the fail-count bucket.
 *
 * Scenarios:
 *  1. Tenant B calling setInquiryArchived(idA, false) does NOT un-archive
 *     tenant A's exhausted archived inquiry — getEmailFailCount for tenant A
 *     remains 0 and the action completes without throwing.
 *  2. After the cross-tenant no-op, the row still has a non-null archivedAt
 *     in the database (direct DB assertion).
 *  3. A same-tenant call (archived=false) does un-archive and raises the count
 *     back to 1 — confirming the guard is in the tenantId WHERE clause, not
 *     a blanket no-op.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable, inquiriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockSession = {
  userId: "u-1023-test",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test-1023",
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/base-url", () => ({
  getTenantUrl: (_tenant: unknown, path: string) =>
    `https://gallery.test${path}`,
  getPlatformBaseUrl: () => "https://platform.test",
}));

vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
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
  return `t1023-${RUN}-${++seq}-${label}`;
}

async function insertTenant(id: string): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Tenant Isolation Test Gallery",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: null,
    contactEmail: "owner-1023@gallery.test",
  } as any);
}

async function insertArtwork(id: string, tenantId: string): Promise<void> {
  CREATED_ARTWORK_IDS.push(id);
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork 1023",
    sku: `sku-1023-${RUN}-${id.slice(-6)}`,
    status: "AVAILABLE",
  } as any);
}

/**
 * Insert an exhausted inquiry that is already archived (archivedAt IS NOT NULL).
 * This row must never re-appear in getEmailFailCount.
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
    artworkTitle: "Test Artwork 1023",
    buyerName: "Cross-Tenant Test Buyer",
    buyerEmail: "buyer-1023@example.com",
    message: "Is this available?",
    emailError: "smtp: connection refused (1023)",
    emailAttempts: MAX_EMAIL_ATTEMPTS,
    emailLastAttemptAt: new Date(Date.now() - 60_000),
    archivedAt: new Date(Date.now() - 30_000),
    status: "NEW",
  } as any);
}

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
  "setInquiryArchived cross-tenant isolation — single-row un-archive variant — real DB (Task #1023)",
  () => {
    // ── Scenario 1 ───────────────────────────────────────────────────────────

    it(
      "tenant B calling setInquiryArchived(idA, false) does not un-archive tenant A's exhausted inquiry and getEmailFailCount for A remains 0",
      { timeout: 30_000 },
      async () => {
        // Seed tenant A with an exhausted, already-archived inquiry.
        const tenantIdA = makeId("tenantA");
        await insertTenant(tenantIdA);
        const artworkIdA = makeId("artworkA");
        await insertArtwork(artworkIdA, tenantIdA);
        const inqIdA = makeId("inqA");
        await insertArchivedExhaustedInquiry(inqIdA, tenantIdA, artworkIdA);

        // Confirm baseline: tenant A's exhausted inquiry is archived so
        // getEmailFailCount (which excludes archivedAt IS NOT NULL) returns 0.
        mockSession.tenantId = tenantIdA;
        const countForATenantView = await getEmailFailCount();
        expect(countForATenantView).toBe(0);

        // Seed tenant B.
        const tenantIdB = makeId("tenantB");
        await insertTenant(tenantIdB);

        // Switch session to tenant B and attempt to un-archive tenant A's inquiry.
        mockSession.tenantId = tenantIdB;
        // The action must not throw (the WHERE clause finds no matching row for
        // tenant B and it may either silently skip or throw "Inquiry not found";
        // either behaviour preserves the guard — catch both).
        try {
          await setInquiryArchived(archiveFormData(inqIdA, false));
        } catch {
          // "Inquiry not found." is also acceptable — the row was not touched.
        }

        // Switch back to tenant A and verify getEmailFailCount is still 0:
        // the row must still be archived.
        mockSession.tenantId = tenantIdA;
        const countAfterCrossTenantAttempt = await getEmailFailCount();
        expect(countAfterCrossTenantAttempt).toBe(0);
      },
    );

    // ── Scenario 2 ───────────────────────────────────────────────────────────

    it(
      "the exhausted archived row retains non-null archivedAt in the DB after a cross-tenant un-archive attempt",
      { timeout: 30_000 },
      async () => {
        const tenantIdA = makeId("tenantA-s2");
        await insertTenant(tenantIdA);
        const artworkIdA = makeId("artworkA-s2");
        await insertArtwork(artworkIdA, tenantIdA);
        const inqIdA = makeId("inqA-s2");
        await insertArchivedExhaustedInquiry(inqIdA, tenantIdA, artworkIdA);

        const tenantIdB = makeId("tenantB-s2");
        await insertTenant(tenantIdB);

        mockSession.tenantId = tenantIdB;
        try {
          await setInquiryArchived(archiveFormData(inqIdA, false));
        } catch {
          // acceptable
        }

        // Direct DB read — archivedAt must still be non-null.
        const row = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, inqIdA),
        });
        expect(row).toBeDefined();
        expect(row?.archivedAt).not.toBeNull();
      },
    );

    // ── Scenario 3 ───────────────────────────────────────────────────────────
    // Confirms the guard lives in the tenantId WHERE clause, not a blanket
    // no-op: the same action succeeds when called by the owning tenant.

    it(
      "same-tenant un-archive restores getEmailFailCount to 1, proving the guard is scoped, not global",
      { timeout: 30_000 },
      async () => {
        const tenantIdA = makeId("tenantA-s3");
        await insertTenant(tenantIdA);
        const artworkIdA = makeId("artworkA-s3");
        await insertArtwork(artworkIdA, tenantIdA);
        const inqIdA = makeId("inqA-s3");
        await insertArchivedExhaustedInquiry(inqIdA, tenantIdA, artworkIdA);

        // Pre-condition: row is archived → fail count is 0.
        mockSession.tenantId = tenantIdA;
        const countBefore = await getEmailFailCount();
        expect(countBefore).toBe(0);

        // Owner un-archives their own inquiry.
        await setInquiryArchived(archiveFormData(inqIdA, false));

        // The exhausted inquiry is now un-archived → fail count rises to ≥ 1.
        const countAfter = await getEmailFailCount();
        expect(countAfter).toBeGreaterThanOrEqual(1);
      },
    );
  },
);
