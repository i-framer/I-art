/**
 * Task #936 — Confirm the inquiry-notification retry is blocked for staff
 * on a real database.
 *
 * `retryFailedInquiryNotifications` in settings/actions.ts checks
 * `session.role !== "owner"` and redirects to
 * `/settings?retry_result=unauthorized` before calling
 * `requeueAllFailedInquiries`.  This suite hits a live PostgreSQL database to
 * confirm the guard fires before any DB write, covering the full server-action
 * path.
 *
 *  1. Calling the action as staff → throws REDIRECT:/settings?retry_result=unauthorized
 *  2. `requeueAllFailedInquiries` is never invoked (no sweep write)
 *  3. The seeded inquiry row is completely untouched after the call
 */
import { afterAll, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable, inquiriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Auth mock — mutable so tests can switch role ──────────────────────────────
const mockSession = {
  userId: "u-936",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test-936",
}));

// redirect() throws a recognisable error so we can assert on the URL without
// needing the full Next.js runtime.
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

// Spy on email-sweep so we can assert requeueAllFailedInquiries is never
// called when the staff guard fires.  vi.hoisted() runs before vi.mock()
// factory evaluation, so the spy reference is available inside the factory.
const { requeueAllFailedInquiriesSpy } = vi.hoisted(() => ({
  requeueAllFailedInquiriesSpy: vi.fn(async () => 0),
}));
vi.mock("@/lib/email-sweep", () => ({
  requeueNoContactEmailInquiries: vi.fn(async () => {}),
  requeueAllFailedInquiries: requeueAllFailedInquiriesSpy,
  NO_CONTACT_EMAIL_ERROR: "no gallery contact email",
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { retryFailedInquiryNotifications } from "@/app/(admin)/settings/actions";

// ── Helpers ───────────────────────────────────────────────────────────────────

const RUN = randomUUID().slice(0, 8);
const CREATED_TENANT_IDS: string[] = [];
const CREATED_ARTWORK_IDS: string[] = [];
const CREATED_INQUIRY_IDS: string[] = [];

function makeId(label: string) {
  return `test-936-${RUN}-${label}`;
}

async function insertTenant(id: string): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Retry Guard Test Gallery",
    type: "ARTIST",
    contactEmail: "owner@retry-guard-936.test",
    billingExempt: true,
    subscriptionStatus: null,
  } as any);
}

async function insertArtwork(id: string, tenantId: string): Promise<void> {
  CREATED_ARTWORK_IDS.push(id);
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork 936",
    sku: `sku-936-${RUN}`,
    status: "AVAILABLE",
  } as any);
}

async function insertFailedInquiry(
  id: string,
  tenantId: string,
  artworkId: string,
): Promise<void> {
  CREATED_INQUIRY_IDS.push(id);
  await db.insert(inquiriesTable).values({
    id,
    tenantId,
    artworkId,
    artworkTitle: "Test Artwork 936",
    buyerName: "Test Buyer",
    buyerEmail: "buyer@example.com",
    message: "Is this available?",
    emailError: "SMTP connection refused",
    emailAttempts: 3,
  });
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

afterAll(async () => {
  // Order: inquiries first (FK → artworks → tenants)
  for (const id of CREATED_INQUIRY_IDS) {
    await db.delete(inquiriesTable).where(eq(inquiriesTable.id, id)).catch(() => {});
  }
  for (const id of CREATED_ARTWORK_IDS) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of CREATED_TENANT_IDS) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
});

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration(
  "retryFailedInquiryNotifications — staff guard — real DB (Task #936)",
  () => {
    it(
      "staff role → redirects to /settings?retry_result=unauthorized " +
        "and makes zero DB writes to inquiry rows",
      async () => {
        const tenantId = makeId("tenant");
        const artworkId = makeId("artwork");
        const inquiryId = makeId("inquiry");

        await insertTenant(tenantId);
        await insertArtwork(artworkId, tenantId);
        await insertFailedInquiry(inquiryId, tenantId, artworkId);

        // Confirm baseline state before the call
        const before = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, inquiryId),
        });
        expect(before?.emailError).toBe("SMTP connection refused");
        expect(before?.emailAttempts).toBe(3);

        // Act as staff
        mockSession.tenantId = tenantId;
        mockSession.role = "staff";
        requeueAllFailedInquiriesSpy.mockClear();

        await expect(retryFailedInquiryNotifications()).rejects.toThrow(
          "REDIRECT:/settings?retry_result=unauthorized",
        );

        // requeueAllFailedInquiries must never have been called
        expect(requeueAllFailedInquiriesSpy).not.toHaveBeenCalled();

        // Inquiry row must be completely unchanged
        const after = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, inquiryId),
        });
        expect(after?.emailError).toBe("SMTP connection refused");
        expect(after?.emailAttempts).toBe(3);
        expect(after?.emailLastAttemptAt).toBeNull();
      },
    );
  },
);
