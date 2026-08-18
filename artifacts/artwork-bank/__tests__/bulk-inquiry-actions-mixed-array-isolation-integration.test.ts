/**
 * Task #1044 — Confirm a mixed array of own and foreign inquiry IDs in a bulk
 * action only updates the caller's own rows.
 *
 * Background:
 *   The existing cross-tenant isolation tests (task #1043) send arrays
 *   containing ONLY Tenant A's IDs from Tenant B's session.  A more
 *   adversarial case is a mixed array — Tenant B injects their own IDs
 *   alongside Tenant A's IDs in the same bulk call.  The tenantId WHERE
 *   clause should silently skip the foreign rows and only touch the caller's
 *   own rows, but no real-DB test covers this combined scenario.
 *
 * Scenarios:
 *  1. Tenant B calls bulkSetInquiriesStatus([tenantB_inq, tenantA_inq],
 *     "HANDLED") → Tenant B's own inquiry is updated to "HANDLED" AND
 *     Tenant A's inquiry remains "NEW".
 *  2. Tenant B calls bulkSetInquiriesArchived([tenantB_inq, tenantA_inq],
 *     true) → Tenant B's own inquiry is archived AND Tenant A's inquiry
 *     remains unarchived (archivedAt = null).
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
  userId: "u-1044-test",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test-1044",
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
  return `t1044-${RUN}-${++seq}-${label}`;
}

async function insertTenant(id: string): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Mixed Array Isolation Test Gallery 1044",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: null,
    contactEmail: "owner-1044@gallery.test",
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
    title: "Test Artwork 1044",
    sku: `sku-1044-${RUN}-${id.slice(-6)}`,
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
    artworkTitle: "Test Artwork 1044",
    buyerName: "Mixed Array Test Buyer",
    buyerEmail: "buyer-1044@example.com",
    message: "Is this artwork still available?",
    status: "NEW",
  } as any);
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describeIntegration(
  "Bulk inquiry actions — mixed-array cross-tenant isolation — real DB",
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
    // Tenant B passes a MIXED array [tenantB_inq, tenantA_inq] to
    // bulkSetInquiriesStatus.  Only Tenant B's own inquiry must be updated;
    // Tenant A's inquiry must remain "NEW".

    it(
      "mixed-array bulkSetInquiriesStatus updates only caller's own inquiry",
      { timeout: 30_000 },
      async () => {
        const tenantIdA = makeId("tenantA-s1");
        const tenantIdB = makeId("tenantB-s1");
        await insertTenant(tenantIdA);
        await insertTenant(tenantIdB);

        const artworkIdA = makeId("artworkA-s1");
        const artworkIdB = makeId("artworkB-s1");
        await insertArtwork(artworkIdA, tenantIdA);
        await insertArtwork(artworkIdB, tenantIdB);

        const userIdB = makeId("userB-s1");
        await insertUser(userIdB, tenantIdB);

        const inqIdA = makeId("inqA-s1");
        const inqIdB = makeId("inqB-s1");
        await insertInquiry(inqIdA, tenantIdA, artworkIdA);
        await insertInquiry(inqIdB, tenantIdB, artworkIdB);

        // Pre-condition: both inquiries are "NEW".
        const inqsBefore = await db
          .select({ id: inquiriesTable.id, status: inquiriesTable.status })
          .from(inquiriesTable)
          .where(inArray(inquiriesTable.id, [inqIdA, inqIdB]));
        expect(inqsBefore).toHaveLength(2);
        expect(inqsBefore.every((r) => r.status === "NEW")).toBe(true);

        // Tenant B calls bulk status update with a MIXED array containing both
        // their own inquiry ID and Tenant A's inquiry ID.
        mockSession.tenantId = tenantIdB;
        mockSession.userId = userIdB;
        await bulkSetInquiriesStatus([inqIdB, inqIdA], "HANDLED");

        // Tenant B's own inquiry must now be "HANDLED".
        const inqB = await db
          .select({ id: inquiriesTable.id, status: inquiriesTable.status })
          .from(inquiriesTable)
          .where(eq(inquiriesTable.id, inqIdB));
        expect(inqB).toHaveLength(1);
        expect(inqB[0].status).toBe("HANDLED");

        // Tenant A's inquiry must still be "NEW".
        const inqA = await db
          .select({ id: inquiriesTable.id, status: inquiriesTable.status })
          .from(inquiriesTable)
          .where(eq(inquiriesTable.id, inqIdA));
        expect(inqA).toHaveLength(1);
        expect(inqA[0].status).toBe("NEW");
      },
    );

    // ── Scenario 2 ─────────────────────────────────────────────────────────────
    // Tenant B passes a MIXED array [tenantB_inq, tenantA_inq] to
    // bulkSetInquiriesArchived.  Only Tenant B's own inquiry must be archived;
    // Tenant A's inquiry must remain unarchived (archivedAt = null).

    it(
      "mixed-array bulkSetInquiriesArchived archives only caller's own inquiry",
      { timeout: 30_000 },
      async () => {
        const tenantIdA = makeId("tenantA-s2");
        const tenantIdB = makeId("tenantB-s2");
        await insertTenant(tenantIdA);
        await insertTenant(tenantIdB);

        const artworkIdA = makeId("artworkA-s2");
        const artworkIdB = makeId("artworkB-s2");
        await insertArtwork(artworkIdA, tenantIdA);
        await insertArtwork(artworkIdB, tenantIdB);

        const userIdB = makeId("userB-s2");
        await insertUser(userIdB, tenantIdB);

        const inqIdA = makeId("inqA-s2");
        const inqIdB = makeId("inqB-s2");
        await insertInquiry(inqIdA, tenantIdA, artworkIdA);
        await insertInquiry(inqIdB, tenantIdB, artworkIdB);

        // Pre-condition: both inquiries are unarchived.
        const inqsBefore = await db
          .select({
            id: inquiriesTable.id,
            archivedAt: inquiriesTable.archivedAt,
          })
          .from(inquiriesTable)
          .where(inArray(inquiriesTable.id, [inqIdA, inqIdB]));
        expect(inqsBefore).toHaveLength(2);
        expect(inqsBefore.every((r) => r.archivedAt === null)).toBe(true);

        // Tenant B calls bulk archive with a MIXED array containing both their
        // own inquiry ID and Tenant A's inquiry ID.
        mockSession.tenantId = tenantIdB;
        mockSession.userId = userIdB;
        await bulkSetInquiriesArchived([inqIdB, inqIdA], true);

        // Tenant B's own inquiry must now be archived (archivedAt non-null).
        const inqB = await db
          .select({
            id: inquiriesTable.id,
            archivedAt: inquiriesTable.archivedAt,
          })
          .from(inquiriesTable)
          .where(eq(inquiriesTable.id, inqIdB));
        expect(inqB).toHaveLength(1);
        expect(inqB[0].archivedAt).not.toBeNull();

        // Tenant A's inquiry must still be unarchived.
        const inqA = await db
          .select({
            id: inquiriesTable.id,
            archivedAt: inquiriesTable.archivedAt,
          })
          .from(inquiriesTable)
          .where(eq(inquiriesTable.id, inqIdA));
        expect(inqA).toHaveLength(1);
        expect(inqA[0].archivedAt).toBeNull();
      },
    );
  },
);
