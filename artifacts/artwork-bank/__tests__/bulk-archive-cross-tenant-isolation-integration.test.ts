/**
 * Task #1017 — Confirm bulk-archiving can't hide another gallery's email failures.
 *
 * Background:
 *   bulkSetInquiriesArchived scopes its UPDATE to the session tenant via an
 *   AND eq(inquiriesTable.tenantId, session.tenantId) clause, so IDs belonging
 *   to a different tenant should be silently ignored — zero rows updated.
 *   This integration test confirms that cross-tenant isolation holds end-to-end
 *   against a real PostgreSQL database.
 *
 * Scenarios:
 *  1. Session is tenant A; calling bulkSetInquiriesArchived with tenant B's
 *     inquiry ID leaves that inquiry unarchived (archivedAt IS NULL).
 *  2. getEmailFailCount for tenant B is unchanged after tenant A's bulk-archive
 *     call — the email-fail banner for tenant B stays accurate.
 *  3. Tenant A's own exhausted inquiry is unaffected by the cross-tenant
 *     call (tenant A's count is also unchanged when none of its IDs are passed).
 *  4. (Task #1026) A pure-foreign archive batch completes without throwing;
 *     tenant A's active inquiries and tenant B's own active inquiry remain
 *     unarchived.
 *
 * All assertions run against a real PostgreSQL database.
 * revalidatePath is mocked so we can import the server action without a live
 * Next.js renderer.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable, inquiriesTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockSession = {
  userId: "u-1017-test",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test-1017",
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
  return `t1017-${RUN}-${++seq}-${label}`;
}

async function insertTenant(id: string): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Cross-Tenant Isolation Test Gallery",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: null,
    contactEmail: "owner-1017@gallery.test",
  } as any);
}

async function insertArtwork(id: string, tenantId: string): Promise<void> {
  CREATED_ARTWORK_IDS.push(id);
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork 1017",
    sku: `sku-1017-${RUN}-${id.slice(-6)}`,
    status: "AVAILABLE",
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
    artworkTitle: "Test Artwork 1017",
    buyerName: "Cross-Tenant Test Buyer",
    buyerEmail: "buyer-1017@example.com",
    message: "Is this available?",
    emailError: "smtp: connection refused (1017)",
    emailAttempts: MAX_EMAIL_ATTEMPTS,
    emailLastAttemptAt: new Date(Date.now() - 60_000),
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
  "Bulk-archive cross-tenant isolation — real DB (Task #1017)",
  () => {
    // ── Scenario 1 ───────────────────────────────────────────────────────────

    it(
      "calling bulkSetInquiriesArchived as tenant A with tenant B's inquiry ID leaves tenant B's inquiry unarchived",
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
        await bulkSetInquiriesArchived([inqIdB], true);

        // Tenant B's inquiry must still be unarchived (archivedAt IS NULL).
        const [row] = await db
          .select({ archivedAt: inquiriesTable.archivedAt })
          .from(inquiriesTable)
          .where(eq(inquiriesTable.id, inqIdB));

        expect(row).toBeDefined();
        expect(row!.archivedAt).toBeNull();
      },
    );

    // ── Scenario 2 ───────────────────────────────────────────────────────────

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
        await bulkSetInquiriesArchived([inqIdB], true);

        // Tenant B's fail count must be unchanged.
        mockSession.tenantId = tenantIdB;
        const countBAfter = await getEmailFailCount();
        expect(countBAfter).toBe(countBBefore);
      },
    );

    // ── Scenario 3 ───────────────────────────────────────────────────────────

    it(
      "tenant A's own exhausted inquiry is unaffected when only tenant B's ID is passed",
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

        // Record tenant A's fail count before.
        mockSession.tenantId = tenantIdA;
        const countABefore = await getEmailFailCount();
        expect(countABefore).toBeGreaterThanOrEqual(1);

        // Tenant A session, but only tenant B's ID is passed — tenant A's own
        // inquiry is not touched (the clause filters by both id AND tenantId).
        mockSession.tenantId = tenantIdA;
        await bulkSetInquiriesArchived([inqIdB], true);

        // Tenant A's own inquiry must still be unarchived.
        const [rowA] = await db
          .select({ archivedAt: inquiriesTable.archivedAt })
          .from(inquiriesTable)
          .where(eq(inquiriesTable.id, inqIdA));

        expect(rowA).toBeDefined();
        expect(rowA!.archivedAt).toBeNull();

        // And tenant A's fail count is also unchanged.
        const countAAfter = await getEmailFailCount();
        expect(countAAfter).toBe(countABefore);
      },
    );

    // ── Scenario 4 (Task #1026) ─────────────────────────────────────────────

    it(
      "tenant B's pure-foreign archive batch leaves tenant A and tenant B inquiries unchanged",
      { timeout: 30_000 },
      async () => {
        // Seed tenant A with two active inquiries.
        const tenantIdA = makeId("tenant-a");
        await insertTenant(tenantIdA);
        const artworkIdA = makeId("artwork-a");
        await insertArtwork(artworkIdA, tenantIdA);
        const inqIdA1 = makeId("inq-a1");
        const inqIdA2 = makeId("inq-a2");
        await insertExhaustedInquiry(inqIdA1, tenantIdA, artworkIdA);
        await insertExhaustedInquiry(inqIdA2, tenantIdA, artworkIdA);

        // Seed tenant B with its own active inquiry so its state can be
        // checked independently of the foreign IDs submitted below.
        const tenantIdB = makeId("tenant-b");
        await insertTenant(tenantIdB);
        const artworkIdB = makeId("artwork-b");
        await insertArtwork(artworkIdB, tenantIdB);
        const inqIdB = makeId("inq-b");
        await insertExhaustedInquiry(inqIdB, tenantIdB, artworkIdB);

        // Tenant B submits a batch containing only tenant A's IDs. The action
        // must resolve cleanly even though no rows match both predicates.
        mockSession.tenantId = tenantIdB;
        const result = await bulkSetInquiriesArchived([inqIdA1, inqIdA2], true);
        expect(result).toEqual({ updated: 0, skipped: 2 });

        // Tenant A's inquiries must remain active.
        const rowsA = await db
          .select({
            id: inquiriesTable.id,
            archivedAt: inquiriesTable.archivedAt,
          })
          .from(inquiriesTable)
          .where(inArray(inquiriesTable.id, [inqIdA1, inqIdA2]));

        expect(rowsA).toHaveLength(2);
        expect(rowsA.every((row) => row.archivedAt === null)).toBe(true);

        // Tenant B's own inquiry must also remain active.
        const [rowB] = await db
          .select({ archivedAt: inquiriesTable.archivedAt })
          .from(inquiriesTable)
          .where(eq(inquiriesTable.id, inqIdB));

        expect(rowB).toBeDefined();
        expect(rowB!.archivedAt).toBeNull();
      },
    );
  },
);
