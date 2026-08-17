/**
 * Task #939 — Confirm the retry count matches exactly what the banner shows as
 * permanently failed.
 *
 * The Inquiries page shows a "permanently failed" alert banner whose count is
 * driven by getEmailFailCount (emailError IS NOT NULL AND emailAttempts >=
 * MAX_EMAIL_ATTEMPTS AND archivedAt IS NULL).
 *
 * The retry button on that banner calls retryFailedInquiryNotifications from
 * inquiries/actions.ts, which calls requeueExhaustedInquiries.  That function
 * applies exactly the same predicate (emailError IS NOT NULL, emailAttempts >=
 * MAX_EMAIL_ATTEMPTS, archivedAt IS NULL), so the redirect count must equal the
 * banner count for any combination of seeded rows.
 *
 * This suite seeds rows at every relevant boundary condition and asserts that:
 *
 *  1. Rows below MAX_EMAIL_ATTEMPTS are NOT included in the banner count and
 *     are NOT touched by the action.
 *  2. Rows at exactly MAX_EMAIL_ATTEMPTS ARE included in both.
 *  3. Rows above MAX_EMAIL_ATTEMPTS ARE included in both (sweep can bump past
 *     the cap in some edge paths, e.g. artwork-deleted terminal write).
 *  4. Archived rows at MAX_EMAIL_ATTEMPTS are excluded from both.
 *  5. The no-contact-email sentinel below MAX_EMAIL_ATTEMPTS is excluded from
 *     both because the attempt count is the gate — it sits in its own banner
 *     bucket (getNoContactEmailInquiryCount) and has not yet exhausted retries.
 *  6. The action redirect count equals the banner count before the action runs —
 *     proving the two stay in sync regardless of what other rows exist.
 */
import { afterAll, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable, inquiriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { MAX_EMAIL_ATTEMPTS, NO_CONTACT_EMAIL_ERROR } from "@/lib/email-sweep";

// ── Auth mock ─────────────────────────────────────────────────────────────────
const mockSession = {
  userId: "u-939",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test-939",
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// getEmailFailCount and retryFailedInquiryNotifications must hit the real DB.
import { getEmailFailCount } from "@/app/(admin)/_actions/inquiry-count";
import { retryFailedInquiryNotifications } from "@/app/(admin)/(gated)/inquiries/actions";

// ── Helpers ───────────────────────────────────────────────────────────────────

const RUN = randomUUID().slice(0, 8);
const CREATED_TENANT_IDS: string[] = [];
const CREATED_ARTWORK_IDS: string[] = [];
const CREATED_INQUIRY_IDS: string[] = [];

function makeId(label: string) {
  return `test-939-${RUN}-${label}`;
}

async function insertTenant(id: string): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Banner Count Test Gallery",
    type: "ARTIST",
    contactEmail: "owner@banner-939.test",
    billingExempt: true,
    subscriptionStatus: null,
  } as any);
}

async function insertArtwork(id: string, tenantId: string): Promise<void> {
  CREATED_ARTWORK_IDS.push(id);
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork 939",
    sku: `sku-939-${RUN}-${id.slice(-6)}`,
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
    archivedAt?: Date | null;
  } = {},
): Promise<void> {
  CREATED_INQUIRY_IDS.push(id);
  // Use explicit undefined check so callers can pass null for emailError
  // without the ?? operator substituting the default.
  const emailError =
    overrides.emailError !== undefined
      ? overrides.emailError
      : "SMTP connection refused";
  await db.insert(inquiriesTable).values({
    id,
    tenantId,
    artworkId,
    artworkTitle: "Test Artwork 939",
    buyerName: "Test Buyer",
    buyerEmail: "buyer@example.com",
    message: "Is this available?",
    emailError,
    emailAttempts: overrides.emailAttempts ?? 0,
    emailLastAttemptAt: overrides.emailLastAttemptAt ?? new Date("2024-01-01"),
    archivedAt: overrides.archivedAt ?? null,
  });
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

afterAll(async () => {
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
  "banner count ↔ retry action consistency — real DB (Task #939)",
  () => {
    /**
     * Seeds the full boundary matrix and verifies the banner count equals the
     * action's redirect count.
     *
     * Seeded rows for the target tenant:
     *   A — attempts below MAX (still retrying)          → excluded from both
     *   B — attempts exactly at MAX                      → included in both
     *   C — attempts above MAX (terminal write)          → included in both
     *   D — attempts at MAX but archived                 → excluded from both
     *   E — no-contact sentinel, attempts below MAX      → excluded from both
     *       (the attempts gate kicks in before the sentinel check matters)
     *
     * Expected banner count = 2 (rows B and C).
     * Expected redirect count = 2.
     */
    it(
      "banner count equals redirect count across all attempt-count boundaries",
      async () => {
        const tenantId = makeId("tenant-matrix");
        await insertTenant(tenantId);

        // One artwork per row to keep FKs clean.
        const artworkA = makeId("aw-A");
        const artworkB = makeId("aw-B");
        const artworkC = makeId("aw-C");
        const artworkD = makeId("aw-D");
        const artworkE = makeId("aw-E");

        for (const id of [artworkA, artworkB, artworkC, artworkD, artworkE]) {
          await insertArtwork(id, tenantId);
        }

        const inqA = makeId("inq-A"); // below MAX — still retrying
        const inqB = makeId("inq-B"); // exactly at MAX — exhausted
        const inqC = makeId("inq-C"); // above MAX — terminal bump
        const inqD = makeId("inq-D"); // at MAX but archived
        const inqE = makeId("inq-E"); // no-contact sentinel, below MAX

        const below = MAX_EMAIL_ATTEMPTS - 1; // e.g. 4
        const exact = MAX_EMAIL_ATTEMPTS;      // 5
        const above = MAX_EMAIL_ATTEMPTS + 2;  // 7

        await insertInquiry(inqA, tenantId, artworkA, {
          emailError: "SMTP timeout",
          emailAttempts: below,
        });
        await insertInquiry(inqB, tenantId, artworkB, {
          emailError: "550 mailbox not found",
          emailAttempts: exact,
        });
        await insertInquiry(inqC, tenantId, artworkC, {
          emailError: "artwork deleted",
          emailAttempts: above,
        });
        await insertInquiry(inqD, tenantId, artworkD, {
          emailError: "SMTP connection refused",
          emailAttempts: exact,
          archivedAt: new Date("2024-06-01"),
        });
        // No-contact sentinel intentionally below MAX — the attempt-count gate
        // (emailAttempts >= MAX_EMAIL_ATTEMPTS) excludes it from both the banner
        // and the action before the sentinel value is even inspected.
        await insertInquiry(inqE, tenantId, artworkE, {
          emailError: NO_CONTACT_EMAIL_ERROR,
          emailAttempts: below,
        });

        // ── Assert banner count before action ─────────────────────────────────

        mockSession.tenantId = tenantId;
        mockSession.role = "owner";

        const bannerCountBefore = await getEmailFailCount();
        // Only inqB (at MAX) and inqC (above MAX), non-archived.
        // inqA is excluded (below MAX), inqD is excluded (archived),
        // inqE is excluded (below MAX — the sentinel check is never reached).
        expect(bannerCountBefore).toBe(2);

        // ── Run the action ────────────────────────────────────────────────────

        const error = await retryFailedInquiryNotifications().catch((e) => e);
        expect(error).toBeInstanceOf(Error);
        // The redirect count must equal the banner count that was shown.
        expect(error.message).toBe(`REDIRECT:/inquiries?retry_result=2`);

        // ── Assert post-action row states ─────────────────────────────────────

        const rowA = await db.query.inquiriesTable.findFirst({ where: eq(inquiriesTable.id, inqA) });
        const rowB = await db.query.inquiriesTable.findFirst({ where: eq(inquiriesTable.id, inqB) });
        const rowC = await db.query.inquiriesTable.findFirst({ where: eq(inquiriesTable.id, inqC) });
        const rowD = await db.query.inquiriesTable.findFirst({ where: eq(inquiriesTable.id, inqD) });
        const rowE = await db.query.inquiriesTable.findFirst({ where: eq(inquiriesTable.id, inqE) });

        // A — below MAX: untouched (still retrying, not shown in banner)
        expect(rowA?.emailAttempts).toBe(below);
        expect(rowA?.emailLastAttemptAt).not.toBeNull();

        // B — at MAX: reset (was in banner, should be re-queued)
        expect(rowB?.emailAttempts).toBe(0);
        expect(rowB?.emailLastAttemptAt).toBeNull();

        // C — above MAX: reset (was in banner, terminal writes can go past cap)
        expect(rowC?.emailAttempts).toBe(0);
        expect(rowC?.emailLastAttemptAt).toBeNull();

        // D — archived at MAX: untouched (excluded from banner by archivedAt IS NULL)
        expect(rowD?.emailAttempts).toBe(exact);
        expect(rowD?.archivedAt).not.toBeNull();

        // E — no-contact sentinel below MAX: untouched (attempts gate excludes it)
        expect(rowE?.emailAttempts).toBe(below);
        expect(rowE?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);

        // ── Banner count after action must drop to 0 ──────────────────────────
        // Both exhausted rows were re-queued (emailAttempts reset to 0 which is
        // below MAX_EMAIL_ATTEMPTS), so neither qualifies for the banner anymore.
        const bannerCountAfter = await getEmailFailCount();
        expect(bannerCountAfter).toBe(0);
      },
    );

    /**
     * Confirms a tenant with no exhausted rows (only partially-failed rows
     * still below MAX) sees a banner count of 0 and a redirect of
     * ?retry_result=0 — so the action never surprises the owner with a count
     * higher than the banner showed.
     */
    it(
      "tenant with only partial-failure rows shows banner=0 and redirect count=0",
      async () => {
        const tenantId = makeId("tenant-partial");
        await insertTenant(tenantId);

        const artworkId = makeId("aw-partial");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq-partial");
        await insertInquiry(inqId, tenantId, artworkId, {
          emailError: "SMTP connection refused",
          emailAttempts: MAX_EMAIL_ATTEMPTS - 1, // still retrying
        });

        mockSession.tenantId = tenantId;
        mockSession.role = "owner";

        // Banner should show 0 (the row hasn't exhausted yet)
        const bannerCount = await getEmailFailCount();
        expect(bannerCount).toBe(0);

        // Action should redirect with 0 — no surprises
        const error = await retryFailedInquiryNotifications().catch((e) => e);
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe("REDIRECT:/inquiries?retry_result=0");

        // The still-retrying row is untouched
        const row = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, inqId),
        });
        expect(row?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS - 1);
        expect(row?.emailLastAttemptAt).not.toBeNull();
      },
    );

    /**
     * Confirms that archived exhausted rows are excluded from both the banner
     * and the action count, so archiving a failed inquiry removes it from the
     * banner and the re-queue is a no-op for that row.
     */
    it(
      "archived exhausted rows are excluded from banner count and action",
      async () => {
        const tenantId = makeId("tenant-archived");
        await insertTenant(tenantId);

        const artworkId1 = makeId("aw-arc-1");
        const artworkId2 = makeId("aw-arc-2");
        await insertArtwork(artworkId1, tenantId);
        await insertArtwork(artworkId2, tenantId);

        // One archived (excluded) and one not (included)
        const inqArchived = makeId("inq-arc-archived");
        const inqActive = makeId("inq-arc-active");

        await insertInquiry(inqArchived, tenantId, artworkId1, {
          emailError: "SMTP connection refused",
          emailAttempts: MAX_EMAIL_ATTEMPTS,
          archivedAt: new Date("2024-03-01"),
        });
        await insertInquiry(inqActive, tenantId, artworkId2, {
          emailError: "550 mailbox not found",
          emailAttempts: MAX_EMAIL_ATTEMPTS,
        });

        mockSession.tenantId = tenantId;
        mockSession.role = "owner";

        // Banner shows only the non-archived row
        const bannerCount = await getEmailFailCount();
        expect(bannerCount).toBe(1);

        // Action resets exactly 1 — matches the banner
        const error = await retryFailedInquiryNotifications().catch((e) => e);
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe("REDIRECT:/inquiries?retry_result=1");

        // Archived row untouched
        const rowArchived = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, inqArchived),
        });
        expect(rowArchived?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
        expect(rowArchived?.archivedAt).not.toBeNull();

        // Active exhausted row was reset
        const rowActive = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, inqActive),
        });
        expect(rowActive?.emailAttempts).toBe(0);
        expect(rowActive?.emailLastAttemptAt).toBeNull();
      },
    );
  },
);
