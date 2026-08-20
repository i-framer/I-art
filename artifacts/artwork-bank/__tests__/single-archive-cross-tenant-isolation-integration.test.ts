/**
 * Task #1020 — Confirm archiving a single inquiry can't reach another gallery's records.
 * Task #1024 — Confirm un-archiving a single inquiry also can't touch another gallery's records.
 *
 * Background:
 *   setInquiryArchived scopes its UPDATE to the session tenant via an
 *   AND eq(inquiriesTable.tenantId, session.tenantId) clause, then throws
 *   "Inquiry not found." when zero rows are updated.  Passing a foreign
 *   inquiry ID must therefore be rejected — not silently accepted.
 *   This integration test confirms the cross-tenant isolation holds
 *   end-to-end against a real PostgreSQL database, in both the archive
 *   (archived=true) and unarchive (archived=false) directions.
 *
 * Scenarios:
 *  1. Session is tenant A; calling setInquiryArchived with a FormData holding
 *     tenant B's inquiry ID throws "Inquiry not found." (not a silent success).
 *  2. Tenant B's inquiry remains unarchived (archivedAt IS NULL) after the
 *     cross-tenant call.
 *  3. getEmailFailCount for tenant B is unchanged after tenant A's
 *     single-archive call — the email-fail banner for tenant B stays accurate.
 *  4. Session is tenant A; calling setInquiryArchived with archived="false" and
 *     tenant B's already-archived inquiry ID throws "Inquiry not found.".
 *  5. Tenant B's inquiry remains archived (archivedAt IS NOT NULL) after the
 *     cross-tenant unarchive attempt.
 *  6. getEmailFailCount for tenant B is unchanged after tenant A's
 *     single-unarchive call — the email-fail banner for tenant B stays accurate.
 *
 * All assertions run against a real PostgreSQL database.
 * revalidatePath and requireActiveBillingAccess are mocked so we can import
 * the server action without a live Next.js renderer or Stripe environment.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable, inquiriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockSession = {
  userId: "u-1020-test",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test-1020",
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath }));

vi.mock("@/lib/base-url", () => ({
  getTenantUrl: (_tenant: unknown, path: string) =>
    `https://gallery.test${path}`,
  getPlatformBaseUrl: () => "https://platform.test",
}));

// requireActiveBillingAccess is mocked so tests don't need Stripe
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
  return `t1020-${RUN}-${++seq}-${label}`;
}

async function insertTenant(id: string): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Single-Archive Cross-Tenant Test Gallery",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: null,
    contactEmail: "owner-1020@gallery.test",
  } as any);
}

async function insertArtwork(id: string, tenantId: string): Promise<void> {
  CREATED_ARTWORK_IDS.push(id);
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork 1020",
    sku: `sku-1020-${RUN}-${id.slice(-6)}`,
    status: "AVAILABLE",
  } as any);
}

/**
 * Insert an already-archived inquiry (archivedAt IS NOT NULL).
 */
async function insertArchivedInquiry(
  id: string,
  tenantId: string,
  artworkId: string,
): Promise<void> {
  CREATED_INQUIRY_IDS.push(id);
  await db.insert(inquiriesTable).values({
    id,
    tenantId,
    artworkId,
    artworkTitle: "Test Artwork 1024",
    buyerName: "Cross-Tenant Test Buyer",
    buyerEmail: "buyer-1024@example.com",
    message: "Is this available?",
    status: "NEW",
    archivedAt: new Date(Date.now() - 60_000),
  } as any);
}

/**
 * Insert an already-archived inquiry whose notification email has permanently
 * failed.  The archived row should be excluded from getEmailFailCount.
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
    artworkTitle: "Test Artwork 1027",
    buyerName: "Cross-Tenant Test Buyer",
    buyerEmail: "buyer-1027@example.com",
    message: "Is this available?",
    emailError: "smtp: connection refused (1027)",
    emailAttempts: MAX_EMAIL_ATTEMPTS,
    emailLastAttemptAt: new Date(Date.now() - 60_000),
    status: "NEW",
    archivedAt: new Date(Date.now() - 60_000),
  } as any);
}

/**
 * Insert an exhausted inquiry — all MAX_EMAIL_ATTEMPTS used, emailError set,
 * archivedAt left NULL (not archived).
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
    artworkTitle: "Test Artwork 1020",
    buyerName: "Cross-Tenant Test Buyer",
    buyerEmail: "buyer-1020@example.com",
    message: "Is this available?",
    emailError: "smtp: connection refused (1020)",
    emailAttempts: MAX_EMAIL_ATTEMPTS,
    emailLastAttemptAt: new Date(Date.now() - 60_000),
    status: "NEW",
  } as any);
}

function makeArchiveFormData(inquiryId: string, archived = "true"): FormData {
  const fd = new FormData();
  fd.append("inquiryId", inquiryId);
  fd.append("archived", archived);
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
  "Single-archive cross-tenant isolation — real DB (Task #1020)",
  () => {
    // ── Scenario 1 ───────────────────────────────────────────────────────────

    it(
      "setInquiryArchived throws 'Inquiry not found.' when tenant A tries to archive tenant B's inquiry",
      { timeout: 30_000 },
      async () => {
        // Seed tenant A with its own exhausted inquiry.
        const tenantIdA = makeId("tenant-a");
        await insertTenant(tenantIdA);
        const artworkIdA = makeId("artwork-a");
        await insertArtwork(artworkIdA, tenantIdA);
        const inqIdA = makeId("inq-a");
        await insertExhaustedInquiry(inqIdA, tenantIdA, artworkIdA);

        // Seed tenant B with an exhausted inquiry.
        const tenantIdB = makeId("tenant-b");
        await insertTenant(tenantIdB);
        const artworkIdB = makeId("artwork-b");
        await insertArtwork(artworkIdB, tenantIdB);
        const inqIdB = makeId("inq-b");
        await insertExhaustedInquiry(inqIdB, tenantIdB, artworkIdB);

        // Session is tenant A — attempt to archive tenant B's inquiry.
        mockSession.tenantId = tenantIdA;
        await expect(
          setInquiryArchived(makeArchiveFormData(inqIdB)),
        ).rejects.toThrow("Inquiry not found.");
      },
    );

    // ── Scenario 2 ───────────────────────────────────────────────────────────

    it(
      "tenant B's inquiry remains unarchived (archivedAt IS NULL) after the cross-tenant call",
      { timeout: 30_000 },
      async () => {
        // Seed tenant A.
        const tenantIdA = makeId("tenant-a");
        await insertTenant(tenantIdA);
        const artworkIdA = makeId("artwork-a");
        await insertArtwork(artworkIdA, tenantIdA);
        const inqIdA = makeId("inq-a");
        await insertExhaustedInquiry(inqIdA, tenantIdA, artworkIdA);

        // Seed tenant B.
        const tenantIdB = makeId("tenant-b");
        await insertTenant(tenantIdB);
        const artworkIdB = makeId("artwork-b");
        await insertArtwork(artworkIdB, tenantIdB);
        const inqIdB = makeId("inq-b");
        await insertExhaustedInquiry(inqIdB, tenantIdB, artworkIdB);

        // Tenant A session — attempt to archive tenant B's inquiry (will throw).
        mockSession.tenantId = tenantIdA;
        await expect(
          setInquiryArchived(makeArchiveFormData(inqIdB)),
        ).rejects.toThrow("Inquiry not found.");

        // Tenant B's inquiry must still be unarchived (archivedAt IS NULL).
        const [row] = await db
          .select({ archivedAt: inquiriesTable.archivedAt })
          .from(inquiriesTable)
          .where(eq(inquiriesTable.id, inqIdB));

        expect(row).toBeDefined();
        expect(row!.archivedAt).toBeNull();
      },
    );

    // ── Scenario 4 (Task #1024) ───────────────────────────────────────────────

    it(
      "setInquiryArchived throws 'Inquiry not found.' when tenant A tries to unarchive tenant B's already-archived inquiry",
      { timeout: 30_000 },
      async () => {
        // Seed tenant A with its own inquiry (not archived).
        const tenantIdA = makeId("tenant-a");
        await insertTenant(tenantIdA);
        const artworkIdA = makeId("artwork-a");
        await insertArtwork(artworkIdA, tenantIdA);
        const inqIdA = makeId("inq-a");
        await insertExhaustedInquiry(inqIdA, tenantIdA, artworkIdA);

        // Seed tenant B with an already-archived inquiry.
        const tenantIdB = makeId("tenant-b");
        await insertTenant(tenantIdB);
        const artworkIdB = makeId("artwork-b");
        await insertArtwork(artworkIdB, tenantIdB);
        const inqIdB = makeId("inq-b");
        await insertArchivedInquiry(inqIdB, tenantIdB, artworkIdB);

        // Session is tenant A — attempt to unarchive tenant B's inquiry.
        mockSession.tenantId = tenantIdA;
        await expect(
          setInquiryArchived(makeArchiveFormData(inqIdB, "false")),
        ).rejects.toThrow("Inquiry not found.");
      },
    );

    // ── Scenario 5 (Task #1024) ───────────────────────────────────────────────

    it(
      "tenant B's inquiry remains archived (archivedAt IS NOT NULL) after tenant A's cross-tenant unarchive attempt",
      { timeout: 30_000 },
      async () => {
        // Seed tenant A.
        const tenantIdA = makeId("tenant-a");
        await insertTenant(tenantIdA);
        const artworkIdA = makeId("artwork-a");
        await insertArtwork(artworkIdA, tenantIdA);
        const inqIdA = makeId("inq-a");
        await insertExhaustedInquiry(inqIdA, tenantIdA, artworkIdA);

        // Seed tenant B with an already-archived inquiry.
        const tenantIdB = makeId("tenant-b");
        await insertTenant(tenantIdB);
        const artworkIdB = makeId("artwork-b");
        await insertArtwork(artworkIdB, tenantIdB);
        const inqIdB = makeId("inq-b");
        await insertArchivedInquiry(inqIdB, tenantIdB, artworkIdB);

        // Tenant A session — attempt to unarchive tenant B's inquiry (will throw).
        mockSession.tenantId = tenantIdA;
        await expect(
          setInquiryArchived(makeArchiveFormData(inqIdB, "false")),
        ).rejects.toThrow("Inquiry not found.");

        // Tenant B's inquiry must still be archived (archivedAt IS NOT NULL).
        const [row] = await db
          .select({ archivedAt: inquiriesTable.archivedAt })
          .from(inquiriesTable)
          .where(eq(inquiriesTable.id, inqIdB));

        expect(row).toBeDefined();
        expect(row!.archivedAt).not.toBeNull();
      },
    );

    // ── Scenario 3 ───────────────────────────────────────────────────────────

    it(
      "getEmailFailCount for tenant B is unchanged after tenant A attempts to archive tenant B's exhausted inquiry",
      { timeout: 30_000 },
      async () => {
        // Seed tenant A.
        const tenantIdA = makeId("tenant-a");
        await insertTenant(tenantIdA);
        const artworkIdA = makeId("artwork-a");
        await insertArtwork(artworkIdA, tenantIdA);
        const inqIdA = makeId("inq-a");
        await insertExhaustedInquiry(inqIdA, tenantIdA, artworkIdA);

        // Seed tenant B.
        const tenantIdB = makeId("tenant-b");
        await insertTenant(tenantIdB);
        const artworkIdB = makeId("artwork-b");
        await insertArtwork(artworkIdB, tenantIdB);
        const inqIdB = makeId("inq-b");
        await insertExhaustedInquiry(inqIdB, tenantIdB, artworkIdB);

        // Record tenant B's fail count before the cross-tenant call.
        mockSession.tenantId = tenantIdB;
        const countBBefore = await getEmailFailCount();
        expect(countBBefore).toBeGreaterThanOrEqual(1);

        // Switch to tenant A and attempt to archive tenant B's inquiry.
        mockSession.tenantId = tenantIdA;
        await expect(
          setInquiryArchived(makeArchiveFormData(inqIdB)),
        ).rejects.toThrow("Inquiry not found.");

        // Tenant B's fail count must be unchanged.
        mockSession.tenantId = tenantIdB;
        const countBAfter = await getEmailFailCount();
        expect(countBAfter).toBe(countBBefore);
      },
    );

    // ── Scenario 6 (Task #1027) ──────────────────────────────────────────────

    it(
      "getEmailFailCount for tenant B is unchanged after tenant A attempts to unarchive tenant B's archived exhausted inquiry",
      { timeout: 30_000 },
      async () => {
        // Seed tenant A.
        const tenantIdA = makeId("tenant-a");
        await insertTenant(tenantIdA);
        const artworkIdA = makeId("artwork-a");
        await insertArtwork(artworkIdA, tenantIdA);
        const inqIdA = makeId("inq-a");
        await insertExhaustedInquiry(inqIdA, tenantIdA, artworkIdA);

        // Seed tenant B with an archived, exhausted inquiry.
        const tenantIdB = makeId("tenant-b");
        await insertTenant(tenantIdB);
        const artworkIdB = makeId("artwork-b");
        await insertArtwork(artworkIdB, tenantIdB);
        const inqIdB = makeId("inq-b");
        await insertArchivedExhaustedInquiry(inqIdB, tenantIdB, artworkIdB);

        // The archived inquiry is excluded from the banner count.
        mockSession.tenantId = tenantIdB;
        const countBBefore = await getEmailFailCount();
        expect(countBBefore).toBe(0);

        // Switch to tenant A and attempt to unarchive tenant B's inquiry.
        mockSession.tenantId = tenantIdA;
        await expect(
          setInquiryArchived(makeArchiveFormData(inqIdB, "false")),
        ).rejects.toThrow("Inquiry not found.");

        // Tenant B's fail count must be unchanged.
        mockSession.tenantId = tenantIdB;
        const countBAfter = await getEmailFailCount();
        expect(countBAfter).toBe(countBBefore);
      },
    );
  },
);
