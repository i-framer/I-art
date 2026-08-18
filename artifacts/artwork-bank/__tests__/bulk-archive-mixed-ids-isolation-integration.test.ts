/**
 * Task #1021 — Confirm a bulk-archive call with mixed own and foreign IDs only
 * archives own inquiries.
 *
 * Background:
 *   bulkSetInquiriesArchived scopes its UPDATE to the session tenant via an
 *   AND eq(inquiriesTable.tenantId, session.tenantId) clause. The cross-tenant
 *   test (Task #1017) confirmed that passing *only* a foreign ID touches zero
 *   rows. This test covers the more realistic attack: a list that mixes the
 *   caller's own IDs with foreign IDs.
 *
 * Scenarios:
 *  1. Only the caller's own inquiry is archived when the list is mixed —
 *     tenant A's inquiry becomes archived, tenant B's stays unarchived.
 *  2. getEmailFailCount for tenant B is unchanged after the mixed-list call —
 *     the email-fail banner for tenant B stays accurate.
 *  3. getEmailFailCount for tenant A reflects the archive (count drops by 1).
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
  userId: "u-1021-test",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test-1021",
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
  return `t1021-${RUN}-${++seq}-${label}`;
}

async function insertTenant(id: string): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Mixed-IDs Isolation Test Gallery",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: null,
    contactEmail: "owner-1021@gallery.test",
  } as any);
}

async function insertArtwork(id: string, tenantId: string): Promise<void> {
  CREATED_ARTWORK_IDS.push(id);
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork 1021",
    sku: `sku-1021-${RUN}-${id.slice(-6)}`,
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
    artworkTitle: "Test Artwork 1021",
    buyerName: "Mixed-IDs Test Buyer",
    buyerEmail: "buyer-1021@example.com",
    message: "Is this available?",
    emailError: "smtp: connection refused (1021)",
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
  "Bulk-archive mixed own+foreign IDs — real DB (Task #1021)",
  () => {
    // ── Scenario 1 ───────────────────────────────────────────────────────────

    it(
      "calling bulkSetInquiriesArchived with [ownId, foreignId] archives only the own inquiry and leaves the foreign inquiry unarchived",
      { timeout: 30_000 },
      async () => {
        // Seed tenant A with one exhausted inquiry.
        const tenantIdA = makeId("tenant-a");
        await insertTenant(tenantIdA);
        const artworkIdA = makeId("artwork-a");
        await insertArtwork(artworkIdA, tenantIdA);
        const inqIdA = makeId("inq-a");
        await insertExhaustedInquiry(inqIdA, tenantIdA, artworkIdA);

        // Seed tenant B with one exhausted inquiry.
        const tenantIdB = makeId("tenant-b");
        await insertTenant(tenantIdB);
        const artworkIdB = makeId("artwork-b");
        await insertArtwork(artworkIdB, tenantIdB);
        const inqIdB = makeId("inq-b");
        await insertExhaustedInquiry(inqIdB, tenantIdB, artworkIdB);

        // Session is tenant A — pass both own and foreign IDs.
        mockSession.tenantId = tenantIdA;
        await bulkSetInquiriesArchived([inqIdA, inqIdB], true);

        // Tenant A's own inquiry must be archived (archivedAt IS NOT NULL).
        const [rowA] = await db
          .select({ archivedAt: inquiriesTable.archivedAt })
          .from(inquiriesTable)
          .where(eq(inquiriesTable.id, inqIdA));

        expect(rowA).toBeDefined();
        expect(rowA!.archivedAt).not.toBeNull();

        // Tenant B's inquiry must still be unarchived (archivedAt IS NULL).
        const [rowB] = await db
          .select({ archivedAt: inquiriesTable.archivedAt })
          .from(inquiriesTable)
          .where(eq(inquiriesTable.id, inqIdB));

        expect(rowB).toBeDefined();
        expect(rowB!.archivedAt).toBeNull();
      },
    );

    // ── Scenario 2 ───────────────────────────────────────────────────────────

    it(
      "getEmailFailCount for tenant B is unchanged after tenant A's mixed-list bulk-archive call",
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

        // Record tenant B's fail count before the mixed-list call.
        mockSession.tenantId = tenantIdB;
        const countBBefore = await getEmailFailCount();
        expect(countBBefore).toBeGreaterThanOrEqual(1);

        // Switch to tenant A and pass both own and foreign IDs.
        mockSession.tenantId = tenantIdA;
        await bulkSetInquiriesArchived([inqIdA, inqIdB], true);

        // Tenant B's fail count must be unchanged.
        mockSession.tenantId = tenantIdB;
        const countBAfter = await getEmailFailCount();
        expect(countBAfter).toBe(countBBefore);
      },
    );

    // ── Scenario 3 ───────────────────────────────────────────────────────────

    it(
      "getEmailFailCount for tenant A drops after archiving its own exhausted inquiry via a mixed-list call",
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

        // Tenant A session — mixed list with its own ID and tenant B's ID.
        mockSession.tenantId = tenantIdA;
        await bulkSetInquiriesArchived([inqIdA, inqIdB], true);

        // Tenant A's fail count must decrease by exactly 1 (its own inquiry
        // is now archived, so getEmailFailCount should exclude it).
        mockSession.tenantId = tenantIdA;
        const countAAfter = await getEmailFailCount();
        expect(countAAfter).toBe(countABefore - 1);
      },
    );
  },
);
