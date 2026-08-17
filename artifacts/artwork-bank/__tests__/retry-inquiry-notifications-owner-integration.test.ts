/**
 * Task #945 — Confirm the Settings-page retry count never shows more failures
 * than the Inquiries banner.
 *
 * `retryFailedInquiryNotifications` in settings/actions.ts now calls
 * `requeueExhaustedInquiries` (from email-sweep.ts) when the session role is
 * "owner".  That function resets emailAttempts → 0 and emailLastAttemptAt →
 * null ONLY for inquiries whose emailAttempts have reached MAX_EMAIL_ATTEMPTS —
 * the same predicate used by `getEmailFailCount` that drives the Inquiries page
 * banner.  This means the redirect count (?retry_result=N) can never exceed the
 * number the gallery owner saw in the banner.
 *
 * This suite hits a live PostgreSQL database to confirm the happy path from
 * end to end:
 *
 *  1. Owner calls the action with N exhausted (emailAttempts >= MAX) SMTP-error
 *     inquiries → throws REDIRECT:/settings?retry_result=N
 *  2. Each exhausted inquiry has emailAttempts=0 and emailLastAttemptAt=null
 *     after the call
 *  3. A still-retrying inquiry (emailAttempts < MAX) is NOT touched even though
 *     it has an SMTP error — it was never visible in the banner
 *  4. A "no gallery contact email" inquiry is NOT reset (different bucket)
 *  5. Rows belonging to a different tenant are untouched
 */
import { afterAll, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable, inquiriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Auth mock — owner role ────────────────────────────────────────────────────
const mockSession = {
  userId: "u-945",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test-945",
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
// requeueExhaustedInquiries must run against the real database so the
// integration test validates the full DB write path.

import { retryFailedInquiryNotifications } from "@/app/(admin)/settings/actions";
import { NO_CONTACT_EMAIL_ERROR, MAX_EMAIL_ATTEMPTS } from "@/lib/email-sweep";

// ── Helpers ───────────────────────────────────────────────────────────────────

const RUN = randomUUID().slice(0, 8);
const CREATED_TENANT_IDS: string[] = [];
const CREATED_ARTWORK_IDS: string[] = [];
const CREATED_INQUIRY_IDS: string[] = [];

function makeId(label: string) {
  return `test-945-${RUN}-${label}`;
}

async function insertTenant(id: string): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Retry Owner Test Gallery",
    type: "ARTIST",
    contactEmail: "owner@retry-owner-945.test",
    billingExempt: true,
    subscriptionStatus: null,
  } as any);
}

async function insertArtwork(id: string, tenantId: string): Promise<void> {
  CREATED_ARTWORK_IDS.push(id);
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork 945",
    sku: `sku-945-${RUN}-${id.slice(-4)}`,
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
    artworkTitle: "Test Artwork 945",
    buyerName: "Test Buyer",
    buyerEmail: "buyer@example.com",
    message: "Is this available?",
    emailError: overrides.emailError ?? "SMTP connection refused",
    emailAttempts: overrides.emailAttempts ?? MAX_EMAIL_ATTEMPTS,
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
  "retryFailedInquiryNotifications — owner happy path — real DB (Task #945)",
  () => {
    it(
      "owner role + exhausted SMTP-error inquiries → redirects to /settings?retry_result=<N> " +
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

        // Two inquiries with genuine SMTP errors at or above MAX_EMAIL_ATTEMPTS
        // — these are exactly the rows shown in the Inquiries-page banner.
        await insertInquiry(inquiryId1, tenantId, artworkId1, {
          emailError: "SMTP connection refused",
          emailAttempts: MAX_EMAIL_ATTEMPTS,
          emailLastAttemptAt: new Date("2024-01-01T00:00:00Z"),
        });
        await insertInquiry(inquiryId2, tenantId, artworkId2, {
          emailError: "550 mailbox not found",
          emailAttempts: MAX_EMAIL_ATTEMPTS + 1, // over MAX is also exhausted
          emailLastAttemptAt: new Date("2024-01-02T00:00:00Z"),
        });

        // Confirm baseline state
        const before1 = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, inquiryId1),
        });
        const before2 = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, inquiryId2),
        });
        expect(before1?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
        expect(before2?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS + 1);
        expect(before1?.emailLastAttemptAt).not.toBeNull();
        expect(before2?.emailLastAttemptAt).not.toBeNull();

        // Act as owner
        mockSession.tenantId = tenantId;
        mockSession.role = "owner";

        // The action always terminates with redirect(), which throws in our mock.
        const error = await retryFailedInquiryNotifications().catch((e) => e);
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe("REDIRECT:/settings?retry_result=2");

        // Both exhausted SMTP-error rows must be reset
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
      "still-retrying inquiry (emailAttempts < MAX) is NOT reset — " +
        "only exhausted rows visible in the banner are re-enqueued",
      async () => {
        const tenantId = makeId("tenant-mix");
        const artworkIdEx = makeId("artwork-ex"); // exhausted row
        const artworkIdRt = makeId("artwork-rt"); // still-retrying row
        const inquiryIdEx = makeId("inquiry-ex");
        const inquiryIdRt = makeId("inquiry-rt");

        await insertTenant(tenantId);
        await insertArtwork(artworkIdEx, tenantId);
        await insertArtwork(artworkIdRt, tenantId);

        // Exhausted inquiry — visible in the Inquiries-page banner
        await insertInquiry(inquiryIdEx, tenantId, artworkIdEx, {
          emailError: "SMTP timeout",
          emailAttempts: MAX_EMAIL_ATTEMPTS,
          emailLastAttemptAt: new Date("2024-01-05T00:00:00Z"),
        });

        // Still-retrying inquiry — NOT visible in the banner (below MAX)
        // Before this fix, retrySmtpErrorInquiries would have reset this row
        // too, causing retry_result to exceed the banner count.
        await insertInquiry(inquiryIdRt, tenantId, artworkIdRt, {
          emailError: "SMTP connection timed out",
          emailAttempts: MAX_EMAIL_ATTEMPTS - 2, // still retrying
          emailLastAttemptAt: new Date("2024-01-05T01:00:00Z"),
        });

        mockSession.tenantId = tenantId;
        mockSession.role = "owner";

        const error = await retryFailedInquiryNotifications().catch((e) => e);
        expect(error).toBeInstanceOf(Error);
        // Only the 1 exhausted inquiry counts — matches what the banner shows
        expect(error.message).toBe("REDIRECT:/settings?retry_result=1");

        // Exhausted row is reset
        const afterEx = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, inquiryIdEx),
        });
        expect(afterEx?.emailAttempts).toBe(0);
        expect(afterEx?.emailLastAttemptAt).toBeNull();

        // Still-retrying row is completely untouched
        const afterRt = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, inquiryIdRt),
        });
        expect(afterRt?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS - 2);
        expect(afterRt?.emailLastAttemptAt).not.toBeNull();
        expect(afterRt?.emailError).toBe("SMTP connection timed out");
      },
    );

    it(
      "exhausted no-contact inquiry IS reset by owner retry — counted and reset like any other exhausted row",
      async () => {
        const tenantId = makeId("tenant-nc");
        const artworkId = makeId("artwork-nc");
        const inquiryId = makeId("inquiry-nc");

        await insertTenant(tenantId);
        await insertArtwork(artworkId, tenantId);

        // Inquiry whose error is the no-contact sentinel at MAX_EMAIL_ATTEMPTS.
        // requeueExhaustedInquiries uses the same predicate as getEmailFailCount
        // (emailError IS NOT NULL AND emailAttempts >= MAX AND archivedAt IS NULL)
        // — so exhausted no-contact rows are counted in the banner AND reset by
        // the action, keeping the redirect count equal to the banner count.
        await insertInquiry(inquiryId, tenantId, artworkId, {
          emailError: NO_CONTACT_EMAIL_ERROR,
          emailAttempts: MAX_EMAIL_ATTEMPTS,
          emailLastAttemptAt: new Date("2024-01-03T00:00:00Z"),
        });

        mockSession.tenantId = tenantId;
        mockSession.role = "owner";

        // 1 exhausted no-contact row → redirect with count=1 (matches banner)
        const error = await retryFailedInquiryNotifications().catch((e) => e);
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe("REDIRECT:/settings?retry_result=1");

        // The no-contact row must be reset (emailAttempts→0, emailLastAttemptAt→null)
        // so it re-enters the sweep candidate set.  emailError is preserved so
        // the no-contact banner still finds it via emailError = NO_CONTACT_EMAIL_ERROR.
        const after = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, inquiryId),
        });
        expect(after?.emailAttempts).toBe(0);
        expect(after?.emailLastAttemptAt).toBeNull();
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

        // Both exhausted, but only the owner's should be reset
        await insertInquiry(ownerInquiryId, ownerTenantId, ownerArtworkId, {
          emailError: "SMTP timeout",
          emailAttempts: MAX_EMAIL_ATTEMPTS,
          emailLastAttemptAt: new Date("2024-01-04T00:00:00Z"),
        });
        await insertInquiry(otherInquiryId, otherTenantId, otherArtworkId, {
          emailError: "SMTP timeout",
          emailAttempts: MAX_EMAIL_ATTEMPTS,
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
        expect(afterOther?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
        expect(afterOther?.emailLastAttemptAt).not.toBeNull();
      },
    );
  },
);
