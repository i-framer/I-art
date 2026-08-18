/**
 * Task #1025 — Confirm a bulk-unarchive call with mixed own and foreign IDs only
 * un-archives own inquiries.
 *
 * Background:
 *   bulkSetInquiriesArchived scopes its UPDATE to the session tenant via an
 *   AND eq(inquiriesTable.tenantId, session.tenantId) clause. Task #1021
 *   confirmed the archiving (archived=true) direction with mixed IDs. This test
 *   covers the inverse: un-archiving (archived=false) with a list that mixes the
 *   caller's own already-archived inquiry with a foreign already-archived inquiry.
 *
 * Scenarios:
 *  1. Only the caller's own inquiry is un-archived when the list is mixed —
 *     tenant A's inquiry becomes unarchived, tenant B's stays archived.
 *  2. getEmailFailCount for tenant B is unchanged after the mixed-list un-archive
 *     call — tenant B's email-fail banner stays accurate.
 *  3. getEmailFailCount for tenant A rises after un-archiving its own exhausted
 *     inquiry via a mixed-list call (the un-archived inquiry re-enters the count).
 *
 * All assertions run against a real PostgreSQL database.
 * revalidatePath is mocked so we can import the server action without a live
 * Next.js renderer.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable, inquiriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockSession = {
  userId: "u-1025-test",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test-1025",
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
  return `t1025-${RUN}-${++seq}-${label}`;
}

async function insertTenant(id: string): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Mixed-IDs Unarchive Isolation Test Gallery",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: null,
    contactEmail: "owner-1025@gallery.test",
  } as any);
}

async function insertArtwork(id: string, tenantId: string): Promise<void> {
  CREATED_ARTWORK_IDS.push(id);
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork 1025",
    sku: `sku-1025-${RUN}-${id.slice(-6)}`,
    status: "AVAILABLE",
  } as any);
}

/**
 * Insert an exhausted inquiry that is already archived — all MAX_EMAIL_ATTEMPTS
 * used, emailError set, archivedAt set to a past timestamp.
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
    artworkTitle: "Test Artwork 1025",
    buyerName: "Mixed-IDs Unarchive Test Buyer",
    buyerEmail: "buyer-1025@example.com",
    message: "Is this available?",
    emailError: "smtp: connection refused (1025)",
    emailAttempts: MAX_EMAIL_ATTEMPTS,
    emailLastAttemptAt: new Date(Date.now() - 60_000),
    archivedAt: new Date(Date.now() - 3_600_000),
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
  "Bulk-unarchive mixed own+foreign IDs — real DB (Task #1025)",
  () => {
    // ── Scenario 1 ───────────────────────────────────────────────────────────

    it(
      "calling bulkSetInquiriesArchived with [ownId, foreignId] and archived=false un-archives only the own inquiry and leaves the foreign inquiry archived",
      { timeout: 30_000 },
      async () => {
        // Seed tenant A with one already-archived exhausted inquiry.
        const tenantIdA = makeId("tenant-a");
        await insertTenant(tenantIdA);
        const artworkIdA = makeId("artwork-a");
        await insertArtwork(artworkIdA, tenantIdA);
        const inqIdA = makeId("inq-a");
        await insertArchivedExhaustedInquiry(inqIdA, tenantIdA, artworkIdA);

        // Seed tenant B with one already-archived exhausted inquiry.
        const tenantIdB = makeId("tenant-b");
        await insertTenant(tenantIdB);
        const artworkIdB = makeId("artwork-b");
        await insertArtwork(artworkIdB, tenantIdB);
        const inqIdB = makeId("inq-b");
        await insertArchivedExhaustedInquiry(inqIdB, tenantIdB, artworkIdB);

        // Session is tenant A — pass both own and foreign IDs with archived=false.
        mockSession.tenantId = tenantIdA;
        await bulkSetInquiriesArchived([inqIdA, inqIdB], false);

        // Tenant A's own inquiry must be un-archived (archivedAt IS NULL).
        const [rowA] = await db
          .select({ archivedAt: inquiriesTable.archivedAt })
          .from(inquiriesTable)
          .where(eq(inquiriesTable.id, inqIdA));

        expect(rowA).toBeDefined();
        expect(rowA!.archivedAt).toBeNull();

        // Tenant B's inquiry must still be archived (archivedAt IS NOT NULL).
        const [rowB] = await db
          .select({ archivedAt: inquiriesTable.archivedAt })
          .from(inquiriesTable)
          .where(eq(inquiriesTable.id, inqIdB));

        expect(rowB).toBeDefined();
        expect(rowB!.archivedAt).not.toBeNull();
      },
    );

    // ── Scenario 2 ───────────────────────────────────────────────────────────

    it(
      "getEmailFailCount for tenant B is unchanged after tenant A's mixed-list bulk-unarchive call",
      { timeout: 30_000 },
      async () => {
        // Seed tenant A.
        const tenantIdA = makeId("tenant-a");
        await insertTenant(tenantIdA);
        const artworkIdA = makeId("artwork-a");
        await insertArtwork(artworkIdA, tenantIdA);
        const inqIdA = makeId("inq-a");
        await insertArchivedExhaustedInquiry(inqIdA, tenantIdA, artworkIdA);

        // Seed tenant B.
        const tenantIdB = makeId("tenant-b");
        await insertTenant(tenantIdB);
        const artworkIdB = makeId("artwork-b");
        await insertArtwork(artworkIdB, tenantIdB);
        const inqIdB = makeId("inq-b");
        await insertArchivedExhaustedInquiry(inqIdB, tenantIdB, artworkIdB);

        // Record tenant B's fail count before the mixed-list call.
        // Tenant B's inquiry is archived so it should not appear in the fail
        // count — we simply capture whatever the baseline is.
        mockSession.tenantId = tenantIdB;
        const countBBefore = await getEmailFailCount();

        // Switch to tenant A and pass both own and foreign IDs with archived=false.
        mockSession.tenantId = tenantIdA;
        await bulkSetInquiriesArchived([inqIdA, inqIdB], false);

        // Tenant B's fail count must be unchanged (tenant B's inquiry is still
        // archived and was never touched by tenant A's call).
        mockSession.tenantId = tenantIdB;
        const countBAfter = await getEmailFailCount();
        expect(countBAfter).toBe(countBBefore);
      },
    );

    // ── Scenario 3 ───────────────────────────────────────────────────────────

    it(
      "getEmailFailCount for tenant A rises after un-archiving its own exhausted inquiry via a mixed-list call",
      { timeout: 30_000 },
      async () => {
        // Seed tenant A.
        const tenantIdA = makeId("tenant-a");
        await insertTenant(tenantIdA);
        const artworkIdA = makeId("artwork-a");
        await insertArtwork(artworkIdA, tenantIdA);
        const inqIdA = makeId("inq-a");
        await insertArchivedExhaustedInquiry(inqIdA, tenantIdA, artworkIdA);

        // Seed tenant B.
        const tenantIdB = makeId("tenant-b");
        await insertTenant(tenantIdB);
        const artworkIdB = makeId("artwork-b");
        await insertArtwork(artworkIdB, tenantIdB);
        const inqIdB = makeId("inq-b");
        await insertArchivedExhaustedInquiry(inqIdB, tenantIdB, artworkIdB);

        // Record tenant A's fail count before — its own inquiry is archived so
        // it should not be counted yet.
        mockSession.tenantId = tenantIdA;
        const countABefore = await getEmailFailCount();

        // Tenant A session — mixed list with its own ID and tenant B's ID,
        // archived=false to un-archive.
        mockSession.tenantId = tenantIdA;
        await bulkSetInquiriesArchived([inqIdA, inqIdB], false);

        // Tenant A's fail count must increase by exactly 1 (its own inquiry is
        // now un-archived, so getEmailFailCount should include it again).
        mockSession.tenantId = tenantIdA;
        const countAAfter = await getEmailFailCount();
        expect(countAAfter).toBe(countABefore + 1);
      },
    );
  },
);
