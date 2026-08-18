/**
 * Task #1045 — Confirm a mixed bulk action can't silently succeed when Tenant B
 * owns none of the IDs.
 *
 * Background:
 *   The mixed-array isolation tests (task #1044) confirm that when Tenant B
 *   sends [ownId, foreignId], only their own row is touched.  A related edge
 *   case is when every ID in the array belongs to foreign tenants — the update
 *   should silently touch zero rows and return without error (not throw "No
 *   inquiries selected").  No integration test currently verifies this
 *   silent-no-op path with a real database for the bulk actions.
 *
 * Scenarios:
 *  1. Tenant B calls bulkSetInquiriesStatus([tenantA_inq1, tenantA_inq2],
 *     "HANDLED") with a non-empty array of purely foreign IDs → call completes
 *     without throwing AND Tenant A's inquiries remain "NEW".
 *  2. Tenant B calls bulkSetInquiriesArchived([tenantA_inq1, tenantA_inq2],
 *     true) with a non-empty array of purely foreign IDs → call completes
 *     without throwing AND Tenant A's inquiries remain unarchived
 *     (archivedAt = null).
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
  userId: "u-1045-test",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test-1045",
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
  return `t1045-${RUN}-${++seq}-${label}`;
}

async function insertTenant(id: string): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "All-Foreign IDs Isolation Test Gallery 1045",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: null,
    contactEmail: "owner-1045@gallery.test",
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
    title: "Test Artwork 1045",
    sku: `sku-1045-${RUN}-${id.slice(-6)}`,
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
    artworkTitle: "Test Artwork 1045",
    buyerName: "All-Foreign IDs Test Buyer",
    buyerEmail: "buyer-1045@example.com",
    message: "Is this artwork still available?",
    status: "NEW",
  } as any);
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describeIntegration(
  "Bulk inquiry actions — all-foreign-IDs silent no-op — real DB",
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
    // Tenant B passes an array containing ONLY Tenant A's inquiry IDs to
    // bulkSetInquiriesStatus.  The call must complete without throwing, and
    // Tenant A's inquiries must remain "NEW".

    it(
      "all-foreign bulkSetInquiriesStatus completes without error and leaves Tenant A's inquiries unchanged",
      { timeout: 30_000 },
      async () => {
        const tenantIdA = makeId("tenantA-s1");
        const tenantIdB = makeId("tenantB-s1");
        await insertTenant(tenantIdA);
        await insertTenant(tenantIdB);

        const userIdB = makeId("userB-s1");
        await insertUser(userIdB, tenantIdB);

        const artworkIdA = makeId("artworkA-s1");
        await insertArtwork(artworkIdA, tenantIdA);

        const inqIdA1 = makeId("inqA1-s1");
        const inqIdA2 = makeId("inqA2-s1");
        await insertInquiry(inqIdA1, tenantIdA, artworkIdA);
        await insertInquiry(inqIdA2, tenantIdA, artworkIdA);

        // Pre-condition: both of Tenant A's inquiries are "NEW".
        const inqsBefore = await db
          .select({ id: inquiriesTable.id, status: inquiriesTable.status })
          .from(inquiriesTable)
          .where(inArray(inquiriesTable.id, [inqIdA1, inqIdA2]));
        expect(inqsBefore).toHaveLength(2);
        expect(inqsBefore.every((r) => r.status === "NEW")).toBe(true);

        // Tenant B calls bulk status update with ONLY Tenant A's inquiry IDs.
        // The call must not throw even though zero rows match.
        mockSession.tenantId = tenantIdB;
        mockSession.userId = userIdB;
        await expect(
          bulkSetInquiriesStatus([inqIdA1, inqIdA2], "HANDLED"),
        ).resolves.not.toThrow();

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
    // Tenant B passes an array containing ONLY Tenant A's inquiry IDs to
    // bulkSetInquiriesArchived.  The call must complete without throwing, and
    // Tenant A's inquiries must remain unarchived (archivedAt = null).

    it(
      "all-foreign bulkSetInquiriesArchived completes without error and leaves Tenant A's inquiries unarchived",
      { timeout: 30_000 },
      async () => {
        const tenantIdA = makeId("tenantA-s2");
        const tenantIdB = makeId("tenantB-s2");
        await insertTenant(tenantIdA);
        await insertTenant(tenantIdB);

        const userIdB = makeId("userB-s2");
        await insertUser(userIdB, tenantIdB);

        const artworkIdA = makeId("artworkA-s2");
        await insertArtwork(artworkIdA, tenantIdA);

        const inqIdA1 = makeId("inqA1-s2");
        const inqIdA2 = makeId("inqA2-s2");
        await insertInquiry(inqIdA1, tenantIdA, artworkIdA);
        await insertInquiry(inqIdA2, tenantIdA, artworkIdA);

        // Pre-condition: both of Tenant A's inquiries are unarchived.
        const inqsBefore = await db
          .select({
            id: inquiriesTable.id,
            archivedAt: inquiriesTable.archivedAt,
          })
          .from(inquiriesTable)
          .where(inArray(inquiriesTable.id, [inqIdA1, inqIdA2]));
        expect(inqsBefore).toHaveLength(2);
        expect(inqsBefore.every((r) => r.archivedAt === null)).toBe(true);

        // Tenant B calls bulk archive with ONLY Tenant A's inquiry IDs.
        // The call must not throw even though zero rows match.
        mockSession.tenantId = tenantIdB;
        mockSession.userId = userIdB;
        await expect(
          bulkSetInquiriesArchived([inqIdA1, inqIdA2], true),
        ).resolves.not.toThrow();

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
  },
);
