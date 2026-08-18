/**
 * Task #1033 — Confirm a buyer's email address can't be read by another gallery
 * via the inquiry detail page.
 *
 * Background:
 *   The inquiry detail loader (getInquiryDetail) fetches a single inquiry
 *   scoped by BOTH the inquiryId AND the session tenantId.  A regression
 *   that removes the tenantId WHERE clause would allow gallery B to retrieve
 *   gallery A's buyer contact details (name, email, message) by knowing or
 *   guessing the inquiry ID.
 *
 * Scenarios:
 *  1. Tenant B's session calling getInquiryDetail(idA) receives undefined —
 *     the row is not returned and the buyer email is not present anywhere in
 *     the result.
 *  2. The same call succeeds for Tenant A — confirms the guard is on
 *     tenantId, not a blanket block.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  inquiriesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockSession = {
  userId: "u-1033-test",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test-1033",
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { getInquiryDetail } from "@/app/(admin)/(gated)/inquiries/actions";

// ── Helpers ───────────────────────────────────────────────────────────────────

const RUN = randomUUID().slice(0, 8);
let seq = 0;
const CREATED_TENANT_IDS: string[] = [];
const CREATED_ARTWORK_IDS: string[] = [];
const CREATED_INQUIRY_IDS: string[] = [];

function makeId(label: string) {
  return `t1033-${RUN}-${++seq}-${label}`;
}

async function insertTenant(id: string): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Inquiry Detail Isolation Test Gallery 1033",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: null,
    contactEmail: "owner-1033@gallery.test",
  } as any);
}

async function insertArtwork(id: string, tenantId: string): Promise<void> {
  CREATED_ARTWORK_IDS.push(id);
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork 1033",
    sku: `sku-1033-${RUN}-${id.slice(-6)}`,
    status: "AVAILABLE",
  } as any);
}

async function insertInquiry(
  id: string,
  tenantId: string,
  artworkId: string,
  buyerEmail: string,
): Promise<void> {
  CREATED_INQUIRY_IDS.push(id);
  await db.insert(inquiriesTable).values({
    id,
    tenantId,
    artworkId,
    artworkTitle: "Test Artwork 1033",
    buyerName: "Cross-Tenant Detail Test Buyer",
    buyerEmail,
    message: "Is this artwork available for purchase?",
    status: "NEW",
  } as any);
}

// ── Teardown ──────────────────────────────────────────────────────────────────

async function cleanUp() {
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

afterEach(cleanUp);
afterAll(cleanUp);

// ── Suite ─────────────────────────────────────────────────────────────────────

describeIntegration(
  "getInquiryDetail — cross-tenant buyer email isolation — real DB",
  () => {
    // ── Scenario 1 ─────────────────────────────────────────────────────────────
    // Tenant B's session calls getInquiryDetail with Tenant A's inquiry ID.
    // The function must return undefined; the buyer email must not be present.

    it(
      "cross-tenant getInquiryDetail returns undefined — buyer email is not exposed",
      { timeout: 30_000 },
      async () => {
        const tenantIdA = makeId("tenantA-s1");
        const tenantIdB = makeId("tenantB-s1");
        await insertTenant(tenantIdA);
        await insertTenant(tenantIdB);

        const artworkIdA = makeId("artworkA-s1");
        await insertArtwork(artworkIdA, tenantIdA);

        const BUYER_EMAIL = "secret-buyer-1033@example.com";
        const inqIdA = makeId("inqA-s1");
        await insertInquiry(inqIdA, tenantIdA, artworkIdA, BUYER_EMAIL);

        // Switch session to Tenant B — simulates another gallery's authenticated user.
        mockSession.tenantId = tenantIdB;

        const result = await getInquiryDetail(inqIdA);

        // The production query must not return Tenant A's row.
        expect(result).toBeUndefined();

        // Belt-and-suspenders: confirm the buyer email is absent from whatever
        // the function returned (guards against future shape changes that
        // return a partial row instead of undefined).
        const resultStr = JSON.stringify(result ?? null);
        expect(resultStr).not.toContain(BUYER_EMAIL);
      },
    );

    // ── Scenario 2 ─────────────────────────────────────────────────────────────
    // Confirms the guard lives in the tenantId WHERE clause, not a blanket
    // block: the owning tenant can still retrieve its own inquiry and buyer
    // email via the same function.

    it(
      "same-tenant getInquiryDetail returns the inquiry with buyer email intact",
      { timeout: 30_000 },
      async () => {
        const tenantIdA = makeId("tenantA-s2");
        await insertTenant(tenantIdA);

        const artworkIdA = makeId("artworkA-s2");
        await insertArtwork(artworkIdA, tenantIdA);

        const BUYER_EMAIL = "legitimate-buyer-1033@example.com";
        const inqIdA = makeId("inqA-s2");
        await insertInquiry(inqIdA, tenantIdA, artworkIdA, BUYER_EMAIL);

        // Switch session to the owning tenant.
        mockSession.tenantId = tenantIdA;

        const result = await getInquiryDetail(inqIdA);

        // The production query must return the full row.
        expect(result).toBeDefined();
        expect(result?.id).toBe(inqIdA);
        expect(result?.tenantId).toBe(tenantIdA);
        expect(result?.buyerEmail).toBe(BUYER_EMAIL);
        expect(result?.buyerName).toBe("Cross-Tenant Detail Test Buyer");
        expect(result?.message).toBe("Is this artwork available for purchase?");
      },
    );
  },
);
