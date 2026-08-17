/**
 * Task #937 — Confirm the owner role can successfully retry failed inquiry
 * notifications on a real database.
 *
 * `retryFailedInquiryNotifications` in settings/actions.ts calls
 * `retrySmtpErrorInquiries` (from email-sweep.ts) when the session role is
 * "owner".  That function resets emailAttempts → 0 and emailLastAttemptAt →
 * null for every inquiry belonging to the tenant whose emailError is non-null
 * and is not the "no gallery contact email" sentinel.
 *
 * This suite hits a live PostgreSQL database to confirm the happy path from
 * end to end:
 *
 *  1. Owner calls the action with N seeded SMTP-error inquiries → throws
 *     REDIRECT:/settings?retry_result=N
 *  2. Each seeded inquiry has emailAttempts=0 and emailLastAttemptAt=null
 *     after the call
 *  3. A "no gallery contact email" inquiry is NOT reset (different bucket)
 *  4. Rows belonging to a different tenant are untouched
 */
import { afterAll, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable, inquiriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Auth mock — owner role ────────────────────────────────────────────────────
const mockSession = {
  userId: "u-937",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test-937",
}));

// redirect() throws a recognisable error so we can assert on the URL without
// needing the full Next.js runtime.
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// NOTE: @/lib/email-sweep is intentionally NOT mocked here.
// retrySmtpErrorInquiries must run against the real database so the integration
// test validates the full DB write path.

import { retryFailedInquiryNotifications } from "@/app/(admin)/settings/actions";
import { NO_CONTACT_EMAIL_ERROR } from "@/lib/email-sweep";

// ── Helpers ───────────────────────────────────────────────────────────────────

const RUN = randomUUID().slice(0, 8);
const CREATED_TENANT_IDS: string[] = [];
const CREATED_ARTWORK_IDS: string[] = [];
const CREATED_INQUIRY_IDS: string[] = [];

function makeId(label: string) {
  return `test-937-${RUN}-${label}`;
}

async function insertTenant(id: string): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Retry Owner Test Gallery",
    type: "ARTIST",
    contactEmail: "owner@retry-owner-937.test",
    billingExempt: true,
    subscriptionStatus: null,
  } as any);
}

async function insertArtwork(id: string, tenantId: string): Promise<void> {
  CREATED_ARTWORK_IDS.push(id);
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork 937",
    sku: `sku-937-${RUN}-${id.slice(-4)}`,
    status: "AVAILABLE",
  } as any);
}

async function insertInquiry(
  id: string,
  tenantId: string,
  artworkId: string,
  overrides: {
    emailError?: string | null;
    emailAttempts?: number;
    emailLastAttemptAt?: Date | null;
  } = {},
): Promise<void> {
  CREATED_INQUIRY_IDS.push(id);
  await db.insert(inquiriesTable).values({
    id,
    tenantId,
    artworkId,
    artworkTitle: "Test Artwork 937",
    buyerName: "Test Buyer",
    buyerEmail: "buyer@example.com",
    message: "Is this available?",
    emailError: overrides.emailError ?? "SMTP connection refused",
    emailAttempts: overrides.emailAttempts ?? 3,
    emailLastAttemptAt: overrides.emailLastAttemptAt ?? new Date("2024-01-01T00:00:00Z"),
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
  "retryFailedInquiryNotifications — owner happy path — real DB (Task #937)",
  () => {
    it(
      "owner role + SMTP-error inquiries → redirects to /settings?retry_result=<N> " +
        "and resets emailAttempts+emailLastAttemptAt on each row",
      async () => {
        const tenantId = makeId("tenant");
        const artworkId1 = makeId("artwork-1");
        const artworkId2 = makeId("artwork-2");
        const inquiryId1 = makeId("inquiry-1");
        const inquiryId2 = makeId("inquiry-2");

        await insertTenant(tenantId);
        await insertArtwork(artworkId1, tenantId);
        await insertArtwork(artworkId2, tenantId);

        // Two inquiries with genuine SMTP errors — both should be reset.
        await insertInquiry(inquiryId1, tenantId, artworkId1, {
          emailError: "SMTP connection refused",
          emailAttempts: 3,
          emailLastAttemptAt: new Date("2024-01-01T00:00:00Z"),
        });
        await insertInquiry(inquiryId2, tenantId, artworkId2, {
          emailError: "550 mailbox not found",
          emailAttempts: 5,
          emailLastAttemptAt: new Date("2024-01-02T00:00:00Z"),
        });

        // Confirm baseline state
        const before1 = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, inquiryId1),
        });
        const before2 = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, inquiryId2),
        });
        expect(before1?.emailAttempts).toBe(3);
        expect(before2?.emailAttempts).toBe(5);
        expect(before1?.emailLastAttemptAt).not.toBeNull();
        expect(before2?.emailLastAttemptAt).not.toBeNull();

        // Act as owner
        mockSession.tenantId = tenantId;
        mockSession.role = "owner";

        // The action always terminates with redirect(), which throws in our mock.
        const error = await retryFailedInquiryNotifications().catch((e) => e);
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe("REDIRECT:/settings?retry_result=2");

        // Both SMTP-error rows must be reset
        const after1 = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, inquiryId1),
        });
        const after2 = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, inquiryId2),
        });

        expect(after1?.emailAttempts).toBe(0);
        expect(after1?.emailLastAttemptAt).toBeNull();
        expect(after1?.emailError).toBe("SMTP connection refused"); // error kept

        expect(after2?.emailAttempts).toBe(0);
        expect(after2?.emailLastAttemptAt).toBeNull();
        expect(after2?.emailError).toBe("550 mailbox not found"); // error kept
      },
    );

    it(
      "no-contact-email inquiry is NOT reset by owner retry action",
      async () => {
        const tenantId = makeId("tenant-nc");
        const artworkId = makeId("artwork-nc");
        const inquiryId = makeId("inquiry-nc");

        await insertTenant(tenantId);
        await insertArtwork(artworkId, tenantId);

        // Inquiry whose error is the no-contact sentinel — retrySmtpErrorInquiries
        // explicitly excludes this bucket.
        await insertInquiry(inquiryId, tenantId, artworkId, {
          emailError: NO_CONTACT_EMAIL_ERROR,
          emailAttempts: 2,
          emailLastAttemptAt: new Date("2024-01-03T00:00:00Z"),
        });

        mockSession.tenantId = tenantId;
        mockSession.role = "owner";

        // 0 SMTP-error rows for this tenant → redirect with count=0
        const error = await retryFailedInquiryNotifications().catch((e) => e);
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe("REDIRECT:/settings?retry_result=0");

        // The no-contact-email row must be completely untouched
        const after = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, inquiryId),
        });
        expect(after?.emailAttempts).toBe(2);
        expect(after?.emailLastAttemptAt).not.toBeNull();
        expect(after?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);
      },
    );

    it(
      "owner cannot reset inquiries belonging to a different tenant",
      async () => {
        const ownerTenantId = makeId("tenant-owner");
        const otherTenantId = makeId("tenant-other");
        const ownerArtworkId = makeId("artwork-owner");
        const otherArtworkId = makeId("artwork-other");
        const ownerInquiryId = makeId("inquiry-owner");
        const otherInquiryId = makeId("inquiry-other");

        await insertTenant(ownerTenantId);
        await insertTenant(otherTenantId);
        await insertArtwork(ownerArtworkId, ownerTenantId);
        await insertArtwork(otherArtworkId, otherTenantId);

        await insertInquiry(ownerInquiryId, ownerTenantId, ownerArtworkId, {
          emailError: "SMTP timeout",
          emailAttempts: 2,
          emailLastAttemptAt: new Date("2024-01-04T00:00:00Z"),
        });
        await insertInquiry(otherInquiryId, otherTenantId, otherArtworkId, {
          emailError: "SMTP timeout",
          emailAttempts: 4,
          emailLastAttemptAt: new Date("2024-01-04T00:00:00Z"),
        });

        // Authenticate as the owner tenant — must only touch their own rows
        mockSession.tenantId = ownerTenantId;
        mockSession.role = "owner";

        const error = await retryFailedInquiryNotifications().catch((e) => e);
        expect(error).toBeInstanceOf(Error);
        // Only the 1 inquiry belonging to ownerTenantId is reset
        expect(error.message).toBe("REDIRECT:/settings?retry_result=1");

        // Owner's inquiry is reset
        const afterOwner = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, ownerInquiryId),
        });
        expect(afterOwner?.emailAttempts).toBe(0);
        expect(afterOwner?.emailLastAttemptAt).toBeNull();

        // Other tenant's inquiry is completely untouched
        const afterOther = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, otherInquiryId),
        });
        expect(afterOther?.emailAttempts).toBe(4);
        expect(afterOther?.emailLastAttemptAt).not.toBeNull();
      },
    );
  },
);
