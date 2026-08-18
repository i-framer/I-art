/**
 * Task #1028 — Confirm bulk mark-as-read/handled can't touch another gallery's
 * archived inquiries via a mixed list.
 *
 * Background:
 *   bulkSetInquiriesStatus scopes its UPDATE to the session tenant via
 *   AND eq(inquiriesTable.tenantId, session.tenantId). The cross-tenant test
 *   (Task #73) confirmed this for NEW foreign inquiries. This test covers the
 *   specific case where the foreign inquiry is ARCHIVED (archivedAt IS NOT NULL)
 *   — i.e. tenant B's archived inquiry must not have its status changed and must
 *   remain archived after tenant A's mixed-list bulk call.
 *
 * Scenarios:
 *  1. Tenant A's NEW inquiry becomes HANDLED; tenant B's archived inquiry stays
 *     NEW and its archivedAt remains set — status and archive state both intact.
 *  2. The reverse toggle (HANDLED → NEW) also leaves tenant B's archived inquiry
 *     untouched (status stays HANDLED, archivedAt stays set).
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
  userId: "u-1028-test",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test-1028",
}));

vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath }));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { bulkSetInquiriesStatus } from "@/app/(admin)/(gated)/inquiries/actions";

// ── Helpers ───────────────────────────────────────────────────────────────────

const RUN = randomUUID().slice(0, 8);
let seq = 0;
const CREATED_TENANT_IDS: string[] = [];
const CREATED_ARTWORK_IDS: string[] = [];
const CREATED_INQUIRY_IDS: string[] = [];

function makeId(label: string) {
  return `t1028-${RUN}-${++seq}-${label}`;
}

async function insertTenant(id: string): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Bulk Handled Archived Isolation Test Gallery",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: null,
    contactEmail: "owner-1028@gallery.test",
  } as any);
}

async function insertArtwork(id: string, tenantId: string): Promise<void> {
  CREATED_ARTWORK_IDS.push(id);
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork 1028",
    sku: `sku-1028-${RUN}-${id.slice(-6)}`,
    status: "AVAILABLE",
  } as any);
}

/** Insert a plain NEW inquiry (not archived). */
async function insertNewInquiry(
  id: string,
  tenantId: string,
  artworkId: string,
): Promise<void> {
  CREATED_INQUIRY_IDS.push(id);
  await db.insert(inquiriesTable).values({
    id,
    tenantId,
    artworkId,
    artworkTitle: "Test Artwork 1028",
    buyerName: "Mixed-IDs Archived Test Buyer",
    buyerEmail: "buyer-1028@example.com",
    message: "Is this available?",
    status: "NEW",
  } as any);
}

/** Insert a NEW inquiry that is also archived (archivedAt set). */
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
    artworkTitle: "Test Artwork 1028",
    buyerName: "Mixed-IDs Archived Test Buyer",
    buyerEmail: "buyer-1028@example.com",
    message: "Is this available?",
    status: "NEW",
    archivedAt: new Date(Date.now() - 120_000),
  } as any);
}

/** Insert a HANDLED inquiry that is also archived (archivedAt set). */
async function insertArchivedHandledInquiry(
  id: string,
  tenantId: string,
  artworkId: string,
): Promise<void> {
  CREATED_INQUIRY_IDS.push(id);
  await db.insert(inquiriesTable).values({
    id,
    tenantId,
    artworkId,
    artworkTitle: "Test Artwork 1028",
    buyerName: "Mixed-IDs Archived Test Buyer",
    buyerEmail: "buyer-1028@example.com",
    message: "Is this available?",
    status: "HANDLED",
    archivedAt: new Date(Date.now() - 120_000),
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
  "Bulk mark-as-handled mixed own+foreign IDs — archived foreign inquiry stays untouched — real DB (Task #1028)",
  () => {
    // ── Scenario 1 ───────────────────────────────────────────────────────────

    it(
      "bulkSetInquiriesStatus([ownId, foreignArchivedId], 'HANDLED') marks own inquiry HANDLED and leaves foreign archived inquiry's status and archivedAt intact",
      { timeout: 30_000 },
      async () => {
        // Seed tenant A with a NEW (unarchived) inquiry.
        const tenantIdA = makeId("tenant-a");
        await insertTenant(tenantIdA);
        const artworkIdA = makeId("artwork-a");
        await insertArtwork(artworkIdA, tenantIdA);
        const inqIdA = makeId("inq-a");
        await insertNewInquiry(inqIdA, tenantIdA, artworkIdA);

        // Seed tenant B with a NEW inquiry that is also archived.
        const tenantIdB = makeId("tenant-b");
        await insertTenant(tenantIdB);
        const artworkIdB = makeId("artwork-b");
        await insertArtwork(artworkIdB, tenantIdB);
        const inqIdB = makeId("inq-b");
        await insertArchivedInquiry(inqIdB, tenantIdB, artworkIdB);

        // Session is tenant A — submit a mixed list.
        mockSession.tenantId = tenantIdA;
        await bulkSetInquiriesStatus([inqIdA, inqIdB], "HANDLED");

        // Tenant A's inquiry must now be HANDLED.
        const [rowA] = await db
          .select({ status: inquiriesTable.status })
          .from(inquiriesTable)
          .where(eq(inquiriesTable.id, inqIdA));

        expect(rowA).toBeDefined();
        expect(rowA!.status).toBe("HANDLED");

        // Tenant B's archived inquiry must still be NEW and still archived.
        const [rowB] = await db
          .select({
            status: inquiriesTable.status,
            archivedAt: inquiriesTable.archivedAt,
          })
          .from(inquiriesTable)
          .where(eq(inquiriesTable.id, inqIdB));

        expect(rowB).toBeDefined();
        expect(rowB!.status).toBe("NEW");
        expect(rowB!.archivedAt).not.toBeNull();
      },
    );

    // ── Scenario 2 ───────────────────────────────────────────────────────────

    it(
      "bulkSetInquiriesStatus([ownId, foreignArchivedId], 'NEW') toggling own inquiry back to NEW leaves foreign archived HANDLED inquiry's status and archivedAt intact",
      { timeout: 30_000 },
      async () => {
        // Seed tenant A with a HANDLED (unarchived) inquiry to toggle back.
        const tenantIdA = makeId("tenant-a");
        await insertTenant(tenantIdA);
        const artworkIdA = makeId("artwork-a");
        await insertArtwork(artworkIdA, tenantIdA);
        const inqIdA = makeId("inq-a");
        // Insert as NEW then set to HANDLED so we have something to toggle.
        await insertNewInquiry(inqIdA, tenantIdA, artworkIdA);
        await db
          .update(inquiriesTable)
          .set({ status: "HANDLED" })
          .where(eq(inquiriesTable.id, inqIdA));

        // Seed tenant B with a HANDLED inquiry that is also archived.
        const tenantIdB = makeId("tenant-b");
        await insertTenant(tenantIdB);
        const artworkIdB = makeId("artwork-b");
        await insertArtwork(artworkIdB, tenantIdB);
        const inqIdB = makeId("inq-b");
        await insertArchivedHandledInquiry(inqIdB, tenantIdB, artworkIdB);

        // Capture tenant B's archivedAt value before the call.
        const [rowBBefore] = await db
          .select({ archivedAt: inquiriesTable.archivedAt })
          .from(inquiriesTable)
          .where(eq(inquiriesTable.id, inqIdB));
        expect(rowBBefore?.archivedAt).not.toBeNull();
        const archivedAtBefore = rowBBefore!.archivedAt;

        // Session is tenant A — toggle own inquiry back to NEW, include foreign ID.
        mockSession.tenantId = tenantIdA;
        await bulkSetInquiriesStatus([inqIdA, inqIdB], "NEW");

        // Tenant A's inquiry must now be NEW.
        const [rowA] = await db
          .select({ status: inquiriesTable.status })
          .from(inquiriesTable)
          .where(eq(inquiriesTable.id, inqIdA));

        expect(rowA).toBeDefined();
        expect(rowA!.status).toBe("NEW");

        // Tenant B's archived HANDLED inquiry must remain HANDLED and archived.
        const [rowB] = await db
          .select({
            status: inquiriesTable.status,
            archivedAt: inquiriesTable.archivedAt,
          })
          .from(inquiriesTable)
          .where(eq(inquiriesTable.id, inqIdB));

        expect(rowB).toBeDefined();
        expect(rowB!.status).toBe("HANDLED");
        expect(rowB!.archivedAt?.getTime()).toBe(archivedAtBefore!.getTime());
      },
    );
  },
);
