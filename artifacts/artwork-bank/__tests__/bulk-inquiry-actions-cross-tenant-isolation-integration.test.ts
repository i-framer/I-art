/**
 * Task #1043 — Confirm bulk status and archive actions can't touch another
 * gallery's inquiries on a real database.
 *
 * Background:
 *   The single-inquiry actions (setInquiryStatus, setInquiryArchived,
 *   replyToInquiry) are covered by cross-tenant isolation tests in prior tasks.
 *   The bulk equivalents — bulkSetInquiriesStatus and bulkSetInquiriesArchived —
 *   accept arrays of IDs and touch multiple rows in one UPDATE.  A cross-tenant
 *   caller who injects foreign IDs into the array must be blocked by the
 *   tenantId WHERE clause.
 *
 * Scenarios:
 *  1. Tenant B calls bulkSetInquiriesStatus([tenantA_inq1, tenantA_inq2],
 *     "HANDLED") → Tenant A's inquiry statuses remain "NEW".
 *  2. Tenant B calls bulkSetInquiriesArchived([tenantA_inq1, tenantA_inq2],
 *     true) → Tenant A's inquiries remain unarchived (archivedAt = null).
 *  3. Same-tenant sanity check: Tenant A can bulk-update their own inquiries,
 *     confirming the guard is scoped to tenantId, not a blanket block.
 */
import { afterAll, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  usersTable,
  tenantUsersTable,
  artworksTable,
  inquiriesTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockSession = {
  userId: "u-1043-test",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test-1043",
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

import {
  bulkSetInquiriesStatus,
  bulkSetInquiriesArchived,
} from "@/app/(admin)/(gated)/inquiries/actions";

// ── Helpers ───────────────────────────────────────────────────────────────────

const RUN = randomUUID().slice(0, 8);
let seq = 0;
const CREATED_TENANT_IDS: string[] = [];
const CREATED_USER_IDS: string[] = [];
const CREATED_ARTWORK_IDS: string[] = [];
const CREATED_INQUIRY_IDS: string[] = [];

function makeId(label: string) {
  return `t1043-${RUN}-${++seq}-${label}`;
}

async function insertTenant(id: string): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Bulk Action Isolation Test Gallery 1043",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: null,
    contactEmail: "owner-1043@gallery.test",
  } as any);
}

async function insertUser(id: string, tenantId: string): Promise<void> {
  CREATED_USER_IDS.push(id);
  await db.insert(usersTable).values({
    id,
    email: `${id}@gallery.test`,
    passwordHash: "hash",
  } as any);
  await db.insert(tenantUsersTable).values({
    userId: id,
    tenantId,
    role: "owner",
  } as any);
}

async function insertArtwork(id: string, tenantId: string): Promise<void> {
  CREATED_ARTWORK_IDS.push(id);
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork 1043",
    sku: `sku-1043-${RUN}-${id.slice(-6)}`,
    status: "AVAILABLE",
  } as any);
}

async function insertInquiry(
  id: string,
  tenantId: string,
  artworkId: string,
): Promise<void> {
  CREATED_INQUIRY_IDS.push(id);
  await db.insert(inquiriesTable).values({
    id,
    tenantId,
    artworkId,
    artworkTitle: "Test Artwork 1043",
    buyerName: "Bulk Isolation Test Buyer",
    buyerEmail: "buyer-1043@example.com",
    message: "Is this artwork still available?",
    status: "NEW",
  } as any);
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describeIntegration(
  "Bulk inquiry actions — cross-tenant isolation — real DB",
  () => {
    afterAll(async () => {
      // Clean up in dependency order.
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
      for (const id of CREATED_USER_IDS.splice(0)) {
        await db
          .delete(usersTable)
          .where(eq(usersTable.id, id))
          .catch(() => {});
      }
      for (const id of CREATED_TENANT_IDS.splice(0)) {
        await db
          .delete(tenantsTable)
          .where(eq(tenantsTable.id, id))
          .catch(() => {});
      }
    });

    // ── Scenario 1 ─────────────────────────────────────────────────────────────
    // Tenant B calls bulkSetInquiriesStatus with Tenant A's inquiry IDs.
    // Both of Tenant A's inquiries must remain "NEW".

    it(
      "cross-tenant bulkSetInquiriesStatus leaves Tenant A's inquiry statuses unchanged",
      { timeout: 30_000 },
      async () => {
        const tenantIdA = makeId("tenantA-s1");
        const tenantIdB = makeId("tenantB-s1");
        await insertTenant(tenantIdA);
        await insertTenant(tenantIdB);

        const artworkIdA = makeId("artworkA-s1");
        await insertArtwork(artworkIdA, tenantIdA);

        const inqIdA1 = makeId("inqA1-s1");
        const inqIdA2 = makeId("inqA2-s1");
        await insertInquiry(inqIdA1, tenantIdA, artworkIdA);
        await insertInquiry(inqIdA2, tenantIdA, artworkIdA);

        // Pre-condition: both inquiries are "NEW".
        const inqsBefore = await db
          .select({ id: inquiriesTable.id, status: inquiriesTable.status })
          .from(inquiriesTable)
          .where(inArray(inquiriesTable.id, [inqIdA1, inqIdA2]));
        expect(inqsBefore).toHaveLength(2);
        expect(inqsBefore.every((r) => r.status === "NEW")).toBe(true);

        // Tenant B calls bulk status update with Tenant A's inquiry IDs.
        mockSession.tenantId = tenantIdB;
        await bulkSetInquiriesStatus([inqIdA1, inqIdA2], "HANDLED");

        // Tenant A's inquiries must still be "NEW".
        const inqsAfter = await db
          .select({ id: inquiriesTable.id, status: inquiriesTable.status })
          .from(inquiriesTable)
          .where(inArray(inquiriesTable.id, [inqIdA1, inqIdA2]));
        expect(inqsAfter).toHaveLength(2);
        expect(inqsAfter.every((r) => r.status === "NEW")).toBe(true);
      },
    );

    // ── Scenario 2 ─────────────────────────────────────────────────────────────
    // Tenant B calls bulkSetInquiriesArchived with Tenant A's inquiry IDs.
    // Both of Tenant A's inquiries must remain unarchived (archivedAt = null).

    it(
      "cross-tenant bulkSetInquiriesArchived leaves Tenant A's inquiries unarchived",
      { timeout: 30_000 },
      async () => {
        const tenantIdA = makeId("tenantA-s2");
        const tenantIdB = makeId("tenantB-s2");
        await insertTenant(tenantIdA);
        await insertTenant(tenantIdB);

        const artworkIdA = makeId("artworkA-s2");
        await insertArtwork(artworkIdA, tenantIdA);

        const inqIdA1 = makeId("inqA1-s2");
        const inqIdA2 = makeId("inqA2-s2");
        await insertInquiry(inqIdA1, tenantIdA, artworkIdA);
        await insertInquiry(inqIdA2, tenantIdA, artworkIdA);

        // Pre-condition: both inquiries are unarchived.
        const inqsBefore = await db
          .select({
            id: inquiriesTable.id,
            archivedAt: inquiriesTable.archivedAt,
          })
          .from(inquiriesTable)
          .where(inArray(inquiriesTable.id, [inqIdA1, inqIdA2]));
        expect(inqsBefore).toHaveLength(2);
        expect(inqsBefore.every((r) => r.archivedAt === null)).toBe(true);

        // Tenant B calls bulk archive with Tenant A's inquiry IDs.
        mockSession.tenantId = tenantIdB;
        await bulkSetInquiriesArchived([inqIdA1, inqIdA2], true);

        // Tenant A's inquiries must still be unarchived.
        const inqsAfter = await db
          .select({
            id: inquiriesTable.id,
            archivedAt: inquiriesTable.archivedAt,
          })
          .from(inquiriesTable)
          .where(inArray(inquiriesTable.id, [inqIdA1, inqIdA2]));
        expect(inqsAfter).toHaveLength(2);
        expect(inqsAfter.every((r) => r.archivedAt === null)).toBe(true);
      },
    );

    // ── Scenario 3 ─────────────────────────────────────────────────────────────
    // Same-tenant sanity check: Tenant A can bulk-update their own inquiries,
    // confirming the guards are scoped to tenantId, not blanket blocks.

    it(
      "same-tenant bulkSetInquiriesStatus and bulkSetInquiriesArchived succeed for own inquiries",
      { timeout: 30_000 },
      async () => {
        const tenantIdA = makeId("tenantA-s3");
        await insertTenant(tenantIdA);

        const userId = makeId("user-s3");
        await insertUser(userId, tenantIdA);

        const artworkIdA = makeId("artworkA-s3");
        await insertArtwork(artworkIdA, tenantIdA);

        const inqIdA1 = makeId("inqA1-s3");
        const inqIdA2 = makeId("inqA2-s3");
        await insertInquiry(inqIdA1, tenantIdA, artworkIdA);
        await insertInquiry(inqIdA2, tenantIdA, artworkIdA);

        // Tenant A bulk-marks their own inquiries as HANDLED.
        mockSession.tenantId = tenantIdA;
        mockSession.userId = userId;
        await bulkSetInquiriesStatus([inqIdA1, inqIdA2], "HANDLED");

        // Both must now be "HANDLED".
        const inqsAfterStatus = await db
          .select({ id: inquiriesTable.id, status: inquiriesTable.status })
          .from(inquiriesTable)
          .where(inArray(inquiriesTable.id, [inqIdA1, inqIdA2]));
        expect(inqsAfterStatus).toHaveLength(2);
        expect(inqsAfterStatus.every((r) => r.status === "HANDLED")).toBe(true);

        // Tenant A bulk-archives their own inquiries.
        await bulkSetInquiriesArchived([inqIdA1, inqIdA2], true);

        // Both must now be archived (archivedAt non-null).
        const inqsAfterArchive = await db
          .select({
            id: inquiriesTable.id,
            archivedAt: inquiriesTable.archivedAt,
          })
          .from(inquiriesTable)
          .where(inArray(inquiriesTable.id, [inqIdA1, inqIdA2]));
        expect(inqsAfterArchive).toHaveLength(2);
        expect(inqsAfterArchive.every((r) => r.archivedAt !== null)).toBe(true);
      },
    );
  },
);
