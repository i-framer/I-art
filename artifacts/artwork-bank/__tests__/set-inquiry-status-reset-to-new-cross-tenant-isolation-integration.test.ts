/**
 * Task #1030 — Confirm resetting an inquiry back to NEW can't touch another
 * gallery's records.
 *
 * Background:
 *   setInquiryStatus scopes its UPDATE by the session tenantId, so a gallery
 *   can never reset another gallery's HANDLED inquiry back to NEW.
 *   This integration test proves that on a real PostgreSQL database by reading
 *   the row status directly after a cross-tenant call.
 *
 * Scenarios:
 *  1. Tenant B calling setInquiryStatus(idA, "NEW") does NOT change tenant A's
 *     HANDLED inquiry — the row status remains "HANDLED" in the DB, and the
 *     action either throws "Inquiry not found." or silently no-ops.
 *  2. Direct DB assertion: after the cross-tenant attempt the row status is
 *     still "HANDLED".
 *  3. Same-tenant call (status → "NEW") succeeds and the DB row reflects "NEW"
 *     — confirming the guard is scoped to tenantId, not a blanket no-op.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable, inquiriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockSession = {
  userId: "u-1030-test",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test-1030",
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
  return `t1030-${RUN}-${++seq}-${label}`;
}

async function insertTenant(id: string): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Tenant Isolation Test Gallery 1030",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: null,
    contactEmail: "owner-1030@gallery.test",
  } as any);
}

async function insertArtwork(id: string, tenantId: string): Promise<void> {
  CREATED_ARTWORK_IDS.push(id);
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork 1030",
    sku: `sku-1030-${RUN}-${id.slice(-6)}`,
    status: "AVAILABLE",
  } as any);
}

/** Insert a HANDLED inquiry owned by tenantId. */
async function insertHandledInquiry(
  id: string,
  tenantId: string,
  artworkId: string,
): Promise<void> {
  CREATED_INQUIRY_IDS.push(id);
  await db.insert(inquiriesTable).values({
    id,
    tenantId,
    artworkId,
    artworkTitle: "Test Artwork 1030",
    buyerName: "Cross-Tenant Reset Test Buyer",
    buyerEmail: "buyer-1030@example.com",
    message: "Is this still available?",
    status: "HANDLED",
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
  "setInquiryStatus reset-to-NEW cross-tenant isolation — real DB (Task #1030)",
  () => {
    // ── Scenario 1 ───────────────────────────────────────────────────────────

    it(
      "tenant B calling setInquiryStatus(idA, 'NEW') does not change tenant A's HANDLED inquiry and action throws or no-ops",
      { timeout: 30_000 },
      async () => {
        // Seed tenant A with a HANDLED inquiry.
        const tenantIdA = makeId("tenantA");
        await insertTenant(tenantIdA);
        const artworkIdA = makeId("artworkA");
        await insertArtwork(artworkIdA, tenantIdA);
        const inqIdA = makeId("inqA");
        await insertHandledInquiry(inqIdA, tenantIdA, artworkIdA);

        // Seed tenant B (no artworks or inquiries needed).
        const tenantIdB = makeId("tenantB");
        await insertTenant(tenantIdB);

        // Switch session to tenant B and attempt to reset tenant A's HANDLED
        // inquiry back to NEW. The action must not touch the foreign row — it
        // may either throw "Inquiry not found." or silently skip; both are
        // acceptable.
        mockSession.tenantId = tenantIdB;
        try {
          await setInquiryStatus(statusFormData(inqIdA, "NEW"));
        } catch {
          // "Inquiry not found." is acceptable — the row was not touched.
        }

        // Direct DB read — status must still be "HANDLED".
        const row = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, inqIdA),
        });
        expect(row).toBeDefined();
        expect(row?.status).toBe("HANDLED");
      },
    );

    // ── Scenario 2 ───────────────────────────────────────────────────────────

    it(
      "after a cross-tenant reset attempt the DB row still has status 'HANDLED' (direct DB assertion)",
      { timeout: 30_000 },
      async () => {
        const tenantIdA = makeId("tenantA-s2");
        await insertTenant(tenantIdA);
        const artworkIdA = makeId("artworkA-s2");
        await insertArtwork(artworkIdA, tenantIdA);
        const inqIdA = makeId("inqA-s2");
        await insertHandledInquiry(inqIdA, tenantIdA, artworkIdA);

        const tenantIdB = makeId("tenantB-s2");
        await insertTenant(tenantIdB);

        mockSession.tenantId = tenantIdB;
        try {
          await setInquiryStatus(statusFormData(inqIdA, "NEW"));
        } catch {
          // acceptable
        }

        // Direct DB read — status must still be "HANDLED".
        const row = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, inqIdA),
        });
        expect(row).toBeDefined();
        expect(row?.status).toBe("HANDLED");
      },
    );

    // ── Scenario 3 ───────────────────────────────────────────────────────────
    // Confirms the guard lives in the tenantId WHERE clause, not a blanket
    // no-op: the same action succeeds when called by the owning tenant.

    it(
      "same-tenant setInquiryStatus('NEW') succeeds and DB row reflects NEW, proving the guard is scoped not global",
      { timeout: 30_000 },
      async () => {
        const tenantIdA = makeId("tenantA-s3");
        await insertTenant(tenantIdA);
        const artworkIdA = makeId("artworkA-s3");
        await insertArtwork(artworkIdA, tenantIdA);
        const inqIdA = makeId("inqA-s3");
        await insertHandledInquiry(inqIdA, tenantIdA, artworkIdA);

        // Pre-condition: status is "HANDLED".
        mockSession.tenantId = tenantIdA;
        const rowBefore = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, inqIdA),
        });
        expect(rowBefore?.status).toBe("HANDLED");

        // Owner resets their own inquiry back to NEW.
        await setInquiryStatus(statusFormData(inqIdA, "NEW"));

        // DB row must now reflect "NEW".
        const rowAfter = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, inqIdA),
        });
        expect(rowAfter?.status).toBe("NEW");
      },
    );
  },
);
