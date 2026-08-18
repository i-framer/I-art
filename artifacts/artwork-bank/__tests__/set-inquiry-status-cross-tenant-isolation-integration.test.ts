/**
 * Task #1029 — Confirm marking an inquiry as handled can't reach another
 * gallery's records.
 *
 * Background:
 *   setInquiryStatus scopes its UPDATE by the session tenantId, so a gallery
 *   can never mark another gallery's inquiry as HANDLED (or reset it to NEW).
 *   This integration test proves that on a real PostgreSQL database by reading
 *   the row status directly after a cross-tenant call.
 *
 * Scenarios:
 *  1. Tenant B calling setInquiryStatus(idA, "HANDLED") does NOT change
 *     tenant A's NEW inquiry — the row status remains "NEW" in the DB, and
 *     the action either throws "Inquiry not found." or silently no-ops.
 *  2. Direct DB assertion: after the cross-tenant attempt the row status is
 *     still "NEW".
 *  3. Same-tenant call (status → "HANDLED") succeeds and the DB row reflects
 *     "HANDLED" — confirming the guard lives in the tenantId WHERE clause,
 *     not a blanket no-op.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable, inquiriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockSession = {
  userId: "u-1029-test",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test-1029",
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

import { setInquiryStatus } from "@/app/(admin)/(gated)/inquiries/actions";

// ── Helpers ───────────────────────────────────────────────────────────────────

const RUN = randomUUID().slice(0, 8);
let seq = 0;
const CREATED_TENANT_IDS: string[] = [];
const CREATED_ARTWORK_IDS: string[] = [];
const CREATED_INQUIRY_IDS: string[] = [];

function makeId(label: string) {
  return `t1029-${RUN}-${++seq}-${label}`;
}

async function insertTenant(id: string): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Tenant Isolation Test Gallery 1029",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: null,
    contactEmail: "owner-1029@gallery.test",
  } as any);
}

async function insertArtwork(id: string, tenantId: string): Promise<void> {
  CREATED_ARTWORK_IDS.push(id);
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork 1029",
    sku: `sku-1029-${RUN}-${id.slice(-6)}`,
    status: "AVAILABLE",
  } as any);
}

/** Insert a NEW inquiry (no emailError, no archiving) owned by tenantId. */
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
    artworkTitle: "Test Artwork 1029",
    buyerName: "Cross-Tenant Status Test Buyer",
    buyerEmail: "buyer-1029@example.com",
    message: "Is this available?",
    status: "NEW",
  } as any);
}

function statusFormData(inquiryId: string, status: "NEW" | "HANDLED"): FormData {
  const fd = new FormData();
  fd.set("inquiryId", inquiryId);
  fd.set("status", status);
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
  "setInquiryStatus cross-tenant isolation — real DB (Task #1029)",
  () => {
    // ── Scenario 1 ───────────────────────────────────────────────────────────

    it(
      "tenant B calling setInquiryStatus(idA, 'HANDLED') does not change tenant A's NEW inquiry and action throws or no-ops",
      { timeout: 30_000 },
      async () => {
        // Seed tenant A with a NEW inquiry.
        const tenantIdA = makeId("tenantA");
        await insertTenant(tenantIdA);
        const artworkIdA = makeId("artworkA");
        await insertArtwork(artworkIdA, tenantIdA);
        const inqIdA = makeId("inqA");
        await insertNewInquiry(inqIdA, tenantIdA, artworkIdA);

        // Seed tenant B.
        const tenantIdB = makeId("tenantB");
        await insertTenant(tenantIdB);

        // Switch session to tenant B and attempt to mark tenant A's inquiry
        // as HANDLED. The action must not touch the foreign row — it may either
        // throw "Inquiry not found." or silently skip; both are acceptable.
        mockSession.tenantId = tenantIdB;
        try {
          await setInquiryStatus(statusFormData(inqIdA, "HANDLED"));
        } catch {
          // "Inquiry not found." is acceptable — the row was not touched.
        }

        // Switch back to tenant A and confirm the row is still "NEW".
        mockSession.tenantId = tenantIdA;
        const row = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, inqIdA),
        });
        expect(row).toBeDefined();
        expect(row?.status).toBe("NEW");
      },
    );

    // ── Scenario 2 ───────────────────────────────────────────────────────────

    it(
      "after a cross-tenant status attempt the DB row still has status 'NEW' (direct DB assertion)",
      { timeout: 30_000 },
      async () => {
        const tenantIdA = makeId("tenantA-s2");
        await insertTenant(tenantIdA);
        const artworkIdA = makeId("artworkA-s2");
        await insertArtwork(artworkIdA, tenantIdA);
        const inqIdA = makeId("inqA-s2");
        await insertNewInquiry(inqIdA, tenantIdA, artworkIdA);

        const tenantIdB = makeId("tenantB-s2");
        await insertTenant(tenantIdB);

        mockSession.tenantId = tenantIdB;
        try {
          await setInquiryStatus(statusFormData(inqIdA, "HANDLED"));
        } catch {
          // acceptable
        }

        // Direct DB read — status must still be "NEW".
        const row = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, inqIdA),
        });
        expect(row).toBeDefined();
        expect(row?.status).toBe("NEW");
      },
    );

    // ── Scenario 3 ───────────────────────────────────────────────────────────
    // Confirms the guard lives in the tenantId WHERE clause, not a blanket
    // no-op: the same action succeeds when called by the owning tenant.

    it(
      "same-tenant setInquiryStatus('HANDLED') succeeds and DB row reflects HANDLED, proving the guard is scoped not global",
      { timeout: 30_000 },
      async () => {
        const tenantIdA = makeId("tenantA-s3");
        await insertTenant(tenantIdA);
        const artworkIdA = makeId("artworkA-s3");
        await insertArtwork(artworkIdA, tenantIdA);
        const inqIdA = makeId("inqA-s3");
        await insertNewInquiry(inqIdA, tenantIdA, artworkIdA);

        // Pre-condition: status is "NEW".
        mockSession.tenantId = tenantIdA;
        const rowBefore = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, inqIdA),
        });
        expect(rowBefore?.status).toBe("NEW");

        // Owner marks their own inquiry as HANDLED.
        await setInquiryStatus(statusFormData(inqIdA, "HANDLED"));

        // DB row must now reflect "HANDLED".
        const rowAfter = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, inqIdA),
        });
        expect(rowAfter?.status).toBe("HANDLED");
      },
    );
  },
);
