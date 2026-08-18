/**
 * Task #1019 — Confirm bulk un-archiving can't restore another gallery's
 * exhausted inquiries.
 *
 * Background:
 *   bulkSetInquiriesArchived includes an AND tenantId = session.tenantId clause
 *   so cross-tenant writes are blocked at the DB level.  This integration test
 *   verifies that the guard holds on a real PostgreSQL database: tenant B
 *   calling bulkSetInquiriesArchived with IDs belonging to tenant A must leave
 *   tenant A's rows untouched (still archived, still absent from
 *   getEmailFailCount).
 *
 * Scenarios:
 *  1. Tenant B un-archiving tenant A's exhausted IDs → A's rows remain archived
 *     (getEmailFailCount for tenant A stays 0).
 *  2. Tenant B's own fail count is 0 — the foreign IDs don't bleed across.
 *  3. Mixed batch: tenant B submits its own ID plus tenant A's IDs → only B's
 *     own row is un-archived; A's rows remain archived.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable, inquiriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockSession = {
  userId: "u-1019-test",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test-1019",
}));

vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
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
  return `t1019-${RUN}-${++seq}-${label}`;
}

async function insertTenant(id: string): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Cross-Tenant Un-Archive Test Gallery",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: null,
    contactEmail: "owner-1019@gallery.test",
  } as any);
}

async function insertArtwork(id: string, tenantId: string): Promise<void> {
  CREATED_ARTWORK_IDS.push(id);
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork 1019",
    sku: `sku-1019-${RUN}-${id.slice(-6)}`,
    status: "AVAILABLE",
  } as any);
}

/**
 * Insert an exhausted inquiry that is already archived (excluded from
 * getEmailFailCount until un-archived).
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
    artworkTitle: "Test Artwork 1019",
    buyerName: "Cross-Tenant Test Buyer",
    buyerEmail: "buyer-1019@example.com",
    message: "Is this still available? (cross-tenant test)",
    emailError: "smtp: connection refused (1019)",
    emailAttempts: MAX_EMAIL_ATTEMPTS,
    emailLastAttemptAt: new Date(Date.now() - 60_000),
    archivedAt: new Date(Date.now() - 120_000),
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

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration(
  "bulkSetInquiriesArchived — cross-tenant isolation — real-DB integration",
  () => {
    it(
      "tenant B un-archiving tenant A's IDs → A's rows remain archived (fail count stays 0)",
      async () => {
        // Set up tenant A with two archived exhausted inquiries.
        const tenantAId = makeId("tenantA");
        const tenantBId = makeId("tenantB");
        await insertTenant(tenantAId);
        await insertTenant(tenantBId);

        const artworkAId = makeId("artA");
        await insertArtwork(artworkAId, tenantAId);

        const inqA1 = makeId("inqA1");
        const inqA2 = makeId("inqA2");
        await insertArchivedExhaustedInquiry(inqA1, tenantAId, artworkAId);
        await insertArchivedExhaustedInquiry(inqA2, tenantAId, artworkAId);

        // Confirm tenant A's fail count is 0 (both rows are archived).
        mockSession.tenantId = tenantAId;
        const countABefore = await getEmailFailCount();
        expect(countABefore).toBe(0);

        // Tenant B attempts to un-archive tenant A's IDs.
        mockSession.tenantId = tenantBId;
        await bulkSetInquiriesArchived([inqA1, inqA2], false);

        // Tenant A's fail count must still be 0 — rows remain archived.
        mockSession.tenantId = tenantAId;
        const countAAfter = await getEmailFailCount();
        expect(countAAfter).toBe(0);
      },
    );

    it(
      "tenant B's own fail count is 0 — foreign IDs don't bleed across",
      async () => {
        // Tenant A has archived exhausted inquiries.
        const tenantAId = makeId("tenantA");
        const tenantBId = makeId("tenantB");
        await insertTenant(tenantAId);
        await insertTenant(tenantBId);

        const artworkAId = makeId("artA");
        await insertArtwork(artworkAId, tenantAId);

        const inqA1 = makeId("inqA1");
        const inqA2 = makeId("inqA2");
        await insertArchivedExhaustedInquiry(inqA1, tenantAId, artworkAId);
        await insertArchivedExhaustedInquiry(inqA2, tenantAId, artworkAId);

        // Tenant B calls un-archive with tenant A's IDs.
        mockSession.tenantId = tenantBId;
        await bulkSetInquiriesArchived([inqA1, inqA2], false);

        // Tenant B's own fail count must be 0 — no foreign rows surfaced.
        const countB = await getEmailFailCount();
        expect(countB).toBe(0);
      },
    );

    it(
      "mixed batch: only tenant B's own row is un-archived; tenant A's rows remain archived",
      async () => {
        const tenantAId = makeId("tenantA");
        const tenantBId = makeId("tenantB");
        await insertTenant(tenantAId);
        await insertTenant(tenantBId);

        const artworkAId = makeId("artA");
        const artworkBId = makeId("artB");
        await insertArtwork(artworkAId, tenantAId);
        await insertArtwork(artworkBId, tenantBId);

        // Tenant A: two archived exhausted inquiries.
        const inqA1 = makeId("inqA1");
        const inqA2 = makeId("inqA2");
        await insertArchivedExhaustedInquiry(inqA1, tenantAId, artworkAId);
        await insertArchivedExhaustedInquiry(inqA2, tenantAId, artworkAId);

        // Tenant B: one archived exhausted inquiry.
        const inqB1 = makeId("inqB1");
        await insertArchivedExhaustedInquiry(inqB1, tenantBId, artworkBId);

        // Tenant A baseline: 0 (all archived).
        mockSession.tenantId = tenantAId;
        expect(await getEmailFailCount()).toBe(0);

        // Tenant B baseline: 0 (all archived).
        mockSession.tenantId = tenantBId;
        expect(await getEmailFailCount()).toBe(0);

        // Tenant B submits a mixed batch: its own ID plus tenant A's IDs.
        mockSession.tenantId = tenantBId;
        await bulkSetInquiriesArchived([inqB1, inqA1, inqA2], false);

        // Tenant B's own row is now un-archived → fail count = 1.
        mockSession.tenantId = tenantBId;
        const countBAfter = await getEmailFailCount();
        expect(countBAfter).toBe(1);

        // Tenant A's rows remain archived → fail count still 0.
        mockSession.tenantId = tenantAId;
        const countAAfter = await getEmailFailCount();
        expect(countAAfter).toBe(0);
      },
    );
  },
);
