/**
 * retrySmtpErrorInquiries + retryFailedInquiryNotifications — real-DB integration.
 *
 * lib/email-sweep.ts: retrySmtpErrorInquiries(tenantId)
 * app/(admin)/settings/actions.ts: retryFailedInquiryNotifications()
 *
 * Tests:
 *  1.  retrySmtpErrorInquiries resets emailAttempts to 0 and emailLastAttemptAt
 *      to null for SMTP-error inquiries and leaves the "no gallery contact email"
 *      sentinel row completely untouched.
 *  2.  retrySmtpErrorInquiries preserves emailError on every reset row so the
 *      sweep's `emailError IS NOT NULL` candidate filter can still select them.
 *  3.  retrySmtpErrorInquiries does NOT reset the "no gallery contact email"
 *      sentinel — that sentinel is managed exclusively by the automatic
 *      email-change requeue path (requeueNoContactEmailInquiries).
 *  4.  retrySmtpErrorInquiries does NOT touch inquiries with a null emailError
 *      (rows that are already sweep-eligible or successfully delivered).
 *  5.  retrySmtpErrorInquiries is scoped to the specified tenant — a second
 *      tenant's stuck inquiries are left completely untouched.
 *  6.  retrySmtpErrorInquiries returns the exact count of rows that were reset
 *      (sentinel rows excluded from the count).
 *  7.  retrySmtpErrorInquiries is idempotent — calling it twice leaves every
 *      SMTP-error row at emailAttempts=0, emailLastAttemptAt=null.
 *  8.  retryFailedInquiryNotifications action resets only SMTP-error inquiries
 *      and redirects to /settings?retry_result=<count>; the "no gallery contact
 *      email" sentinel row is NOT reset and NOT counted.
 *  9.  retryFailedInquiryNotifications is scoped to the session tenant — a
 *      concurrent tenant's stuck inquiries are left untouched.
 *  10. retryFailedInquiryNotifications redirects to /settings?retry_result=0
 *      when no SMTP-error inquiries exist (no-op path).
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  usersTable,
  tenantUsersTable,
  artworksTable,
  inquiriesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { retrySmtpErrorInquiries, MAX_EMAIL_ATTEMPTS } from "@/lib/email-sweep";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdInquiryIds: string[] = [];

function uid() { return `${randomUUID()}-rfin-${RUN}-${++seq}`; }

const mockSession = { value: { userId: "u-rfin-test", tenantId: "PLACEHOLDER", role: "owner" } };

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => mockSession.value),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

import { retryFailedInquiryNotifications } from "@/app/(admin)/settings/actions";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function createTenant(businessName = "RFIN Test Gallery") {
  const id = uid();
  const userId = uid();
  await db.insert(usersTable).values({ id: userId, email: `u-${userId}@test.com`, passwordHash: "x" } as any);
  createdUserIds.push(userId);
  mockSession.value = { userId, tenantId: id, role: "owner" };
  await db.insert(tenantsTable).values({
    id, slug: id, businessName, type: "ARTIST",
    contactEmail: "owner@test.com",
  } as any);
  createdTenantIds.push(id);
  await db.insert(tenantUsersTable).values({ tenantId: id, userId, role: "owner" } as any);
  return { tenantId: id, userId };
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "RFIN Test Artwork",
    sku: `sku-${id}`,
    status: "AVAILABLE",
    showInGallery: true,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

/** Creates an inquiry with a non-null emailError and emailAttempts=MAX_EMAIL_ATTEMPTS. */
async function createFailedInquiry(tenantId: string, artworkId: string, emailError: string) {
  const id = uid();
  await db.insert(inquiriesTable).values({
    id,
    tenantId,
    artworkId,
    artworkTitle: "RFIN Test Artwork",
    buyerName: "Test Buyer",
    buyerEmail: `buyer-${id}@test.com`,
    message: "Is this available?",
    emailError,
    emailAttempts: MAX_EMAIL_ATTEMPTS,
    emailLastAttemptAt: new Date(Date.now() - 60_000),
  } as any);
  createdInquiryIds.push(id);
  return id;
}

/** Creates an inquiry with null emailError (fresh / successfully delivered). */
async function createCleanInquiry(tenantId: string, artworkId: string) {
  const id = uid();
  await db.insert(inquiriesTable).values({
    id,
    tenantId,
    artworkId,
    artworkTitle: "RFIN Test Artwork",
    buyerName: "Clean Buyer",
    buyerEmail: `clean-${id}@test.com`,
    message: "Available?",
    emailError: null,
    emailAttempts: 0,
    emailLastAttemptAt: null,
  } as any);
  createdInquiryIds.push(id);
  return id;
}

async function inquiryRow(id: string) {
  return db.query.inquiriesTable.findFirst({ where: eq(inquiriesTable.id, id) });
}

async function cleanup() {
  for (const id of createdInquiryIds.splice(0)) {
    await db.delete(inquiriesTable).where(eq(inquiriesTable.id, id)).catch(() => {});
  }
  for (const id of createdArtworkIds.splice(0)) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantUsersTable).where(eq(tenantUsersTable.tenantId, id)).catch(() => {});
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
  for (const id of createdUserIds.splice(0)) {
    await db.delete(usersTable).where(eq(usersTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─── Tests ───────────────────────────────────────────────────────────────────

describeIntegration("retrySmtpErrorInquiries + retryFailedInquiryNotifications — real-DB integration", () => {
  it("resets SMTP-error inquiries and leaves the 'no gallery contact email' sentinel row completely untouched", async () => {
    const { tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId);

    const id1 = await createFailedInquiry(tenantId, artworkId, "550 mailbox not found");
    const id2 = await createFailedInquiry(tenantId, artworkId, "SMTP connection timeout");
    const sentinelId = await createFailedInquiry(tenantId, artworkId, "no gallery contact email");

    // All three start exhausted.
    for (const id of [id1, id2, sentinelId]) {
      const row = await inquiryRow(id);
      expect(row?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
      expect(row?.emailLastAttemptAt).not.toBeNull();
    }

    await retrySmtpErrorInquiries(tenantId);

    // SMTP-error rows must be reset.
    for (const [label, id] of [["id1", id1], ["id2", id2]] as const) {
      const row = await inquiryRow(id);
      expect(row?.emailAttempts, `${label}: emailAttempts`).toBe(0);
      expect(row?.emailLastAttemptAt, `${label}: emailLastAttemptAt`).toBeNull();
    }

    // Sentinel row must be completely untouched.
    const sentinelRow = await inquiryRow(sentinelId);
    expect(sentinelRow?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
    expect(sentinelRow?.emailLastAttemptAt).not.toBeNull();
    expect(sentinelRow?.emailError).toBe("no gallery contact email");
  });

  it("preserves emailError on every reset row so the sweep candidate filter still selects them", async () => {
    const { tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId);

    const smtpId = await createFailedInquiry(tenantId, artworkId, "550 mailbox not found");
    const timeoutId = await createFailedInquiry(tenantId, artworkId, "SMTP connection timeout");

    await retrySmtpErrorInquiries(tenantId);

    // emailError must be preserved — the sweep uses `emailError IS NOT NULL`
    // to select candidates.  Clearing it would make the row invisible to the sweep.
    const smtpRow = await inquiryRow(smtpId);
    expect(smtpRow?.emailError).toBe("550 mailbox not found");
    expect(smtpRow?.emailAttempts).toBe(0);

    const timeoutRow = await inquiryRow(timeoutId);
    expect(timeoutRow?.emailError).toBe("SMTP connection timeout");
    expect(timeoutRow?.emailAttempts).toBe(0);
  });

  it("does NOT reset the 'no gallery contact email' sentinel — that sentinel is managed by the automatic email-change requeue path", async () => {
    // This is the key exclusion boundary: retrySmtpErrorInquiries must skip
    // the sentinel so that gallery owners who haven't set a contact email do
    // not accidentally get their "no contact email" rows reset via the manual
    // retry action.  Those rows are only reset by requeueNoContactEmailInquiries
    // (triggered automatically when the gallery owner saves a contact email).
    const { tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId);

    const sentinelId = await createFailedInquiry(tenantId, artworkId, "no gallery contact email");
    const smtpId = await createFailedInquiry(tenantId, artworkId, "550 mailbox not found");

    const resetCount = await retrySmtpErrorInquiries(tenantId);

    // Only the SMTP-error row is counted; the sentinel is not.
    expect(resetCount).toBe(1);

    // Sentinel row: every field must be exactly as it was before the call.
    const sentinelRow = await inquiryRow(sentinelId);
    expect(sentinelRow?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
    expect(sentinelRow?.emailLastAttemptAt).not.toBeNull();
    expect(sentinelRow?.emailError).toBe("no gallery contact email");

    // SMTP-error row: reset as expected.
    const smtpRow = await inquiryRow(smtpId);
    expect(smtpRow?.emailAttempts).toBe(0);
    expect(smtpRow?.emailLastAttemptAt).toBeNull();
  });

  it("does NOT touch inquiries with a null emailError", async () => {
    const { tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId);

    const cleanId = await createCleanInquiry(tenantId, artworkId);
    const failedId = await createFailedInquiry(tenantId, artworkId, "SMTP error");

    await retrySmtpErrorInquiries(tenantId);

    // The clean inquiry must be completely untouched.
    const cleanRow = await inquiryRow(cleanId);
    expect(cleanRow?.emailAttempts).toBe(0);
    expect(cleanRow?.emailLastAttemptAt).toBeNull();
    expect(cleanRow?.emailError).toBeNull();

    // The failed one must be reset.
    const failedRow = await inquiryRow(failedId);
    expect(failedRow?.emailAttempts).toBe(0);
    expect(failedRow?.emailLastAttemptAt).toBeNull();
  });

  it("is scoped to the specified tenant — a second tenant's stuck inquiries are left completely untouched", async () => {
    const { tenantId: tenantA } = await createTenant("Gallery A");
    const { tenantId: tenantB } = await createTenant("Gallery B");

    const artworkA = await createArtwork(tenantA);
    const artworkB = await createArtwork(tenantB);

    const idA = await createFailedInquiry(tenantA, artworkA, "SMTP error");
    const idB = await createFailedInquiry(tenantB, artworkB, "SMTP error");

    // Reset only tenant A's inquiries.
    await retrySmtpErrorInquiries(tenantA);

    // Tenant A's inquiry must be reset.
    const rowA = await inquiryRow(idA);
    expect(rowA?.emailAttempts).toBe(0);
    expect(rowA?.emailLastAttemptAt).toBeNull();

    // Tenant B's inquiry must be completely untouched.
    const rowB = await inquiryRow(idB);
    expect(rowB?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
    expect(rowB?.emailLastAttemptAt).not.toBeNull();
    expect(rowB?.emailError).toBe("SMTP error");
  });

  it("returns the exact count of SMTP-error rows reset (sentinel and clean rows excluded from count)", async () => {
    const { tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId);

    // 2 genuine SMTP errors, 1 sentinel, 1 clean.
    await createFailedInquiry(tenantId, artworkId, "550 mailbox not found");
    await createFailedInquiry(tenantId, artworkId, "SMTP connection refused");
    await createFailedInquiry(tenantId, artworkId, "no gallery contact email");
    await createCleanInquiry(tenantId, artworkId);

    const count = await retrySmtpErrorInquiries(tenantId);
    // Must return 2 — only the SMTP-error rows are counted.
    expect(count).toBe(2);
  });

  it("returns 0 when there are no SMTP-error inquiries (no-op path)", async () => {
    const { tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId);
    // Only a clean inquiry and a sentinel — no SMTP errors to reset.
    await createCleanInquiry(tenantId, artworkId);
    await createFailedInquiry(tenantId, artworkId, "no gallery contact email");

    const count = await retrySmtpErrorInquiries(tenantId);
    expect(count).toBe(0);
  });

  it("is idempotent — calling it twice leaves every SMTP-error row at emailAttempts=0 and emailLastAttemptAt=null", async () => {
    const { tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const id = await createFailedInquiry(tenantId, artworkId, "SMTP error");

    const count1 = await retrySmtpErrorInquiries(tenantId);
    expect(count1).toBe(1);

    // Second call: row is at emailAttempts=0 but emailError is still non-null,
    // so the WHERE clause matches again.
    const count2 = await retrySmtpErrorInquiries(tenantId);
    expect(count2).toBe(1);

    // Row remains correctly reset after both calls.
    const row = await inquiryRow(id);
    expect(row?.emailAttempts).toBe(0);
    expect(row?.emailLastAttemptAt).toBeNull();
    expect(row?.emailError).toBe("SMTP error");
  });

  it("retryFailedInquiryNotifications resets all exhausted inquiries (SMTP-error + no-contact sentinel) and redirect count matches the banner count", async () => {
    const { tenantId } = await createTenant("Gallery With Failed Inquiries");
    const artworkId = await createArtwork(tenantId);

    const smtpId1 = await createFailedInquiry(tenantId, artworkId, "550 mailbox not found");
    const smtpId2 = await createFailedInquiry(tenantId, artworkId, "SMTP connection timeout");
    // Exhausted no-contact sentinel row: counted by getEmailFailCount and reset
    // by requeueExhaustedInquiries (same predicate — emailError IS NOT NULL AND
    // emailAttempts >= MAX AND archivedAt IS NULL).
    const sentinelId = await createFailedInquiry(tenantId, artworkId, "no gallery contact email");

    let caughtError: unknown;
    try {
      await retryFailedInquiryNotifications();
    } catch (e) {
      caughtError = e;
    }

    // Must redirect to /settings?retry_result=3 — all 3 exhausted rows.
    expect(String(caughtError)).toContain("REDIRECT:/settings?retry_result=3");

    // All three exhausted rows must have been reset.
    for (const [label, id] of [["smtpId1", smtpId1], ["smtpId2", smtpId2], ["sentinelId", sentinelId]] as const) {
      const row = await inquiryRow(id);
      expect(row?.emailAttempts, `${label}: emailAttempts`).toBe(0);
      expect(row?.emailLastAttemptAt, `${label}: emailLastAttemptAt`).toBeNull();
    }

    // Sentinel emailError is preserved so the no-contact banner can still find it.
    const sentinelRow = await inquiryRow(sentinelId);
    expect(sentinelRow?.emailError).toBe("no gallery contact email");
  });

  it("retryFailedInquiryNotifications is scoped to the session tenant — a concurrent tenant's stuck inquiries are left untouched", async () => {
    const { tenantId: tenantA, userId: userA } = await createTenant("Gallery A");
    const { tenantId: tenantB } = await createTenant("Gallery B");

    const artworkA = await createArtwork(tenantA);
    const artworkB = await createArtwork(tenantB);

    const idA = await createFailedInquiry(tenantA, artworkA, "SMTP error");
    const idB = await createFailedInquiry(tenantB, artworkB, "SMTP error");

    // Act as tenant A.
    mockSession.value = { userId: userA, tenantId: tenantA, role: "owner" };

    let caughtError: unknown;
    try {
      await retryFailedInquiryNotifications();
    } catch (e) {
      caughtError = e;
    }

    // Must redirect to /settings?retry_result=1 (only tenant A's row).
    expect(String(caughtError)).toContain("REDIRECT:/settings?retry_result=1");

    // Tenant A's inquiry is reset.
    const rowA = await inquiryRow(idA);
    expect(rowA?.emailAttempts).toBe(0);
    expect(rowA?.emailLastAttemptAt).toBeNull();

    // Tenant B's inquiry is untouched.
    const rowB = await inquiryRow(idB);
    expect(rowB?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
    expect(rowB?.emailLastAttemptAt).not.toBeNull();
  });

  it("retryFailedInquiryNotifications redirects to /settings?retry_result=0 when no stuck inquiries exist", async () => {
    const { tenantId } = await createTenant("Gallery With No Stuck Inquiries");
    const artworkId = await createArtwork(tenantId);
    await createCleanInquiry(tenantId, artworkId);

    let caughtError: unknown;
    try {
      await retryFailedInquiryNotifications();
    } catch (e) {
      caughtError = e;
    }

    expect(String(caughtError)).toContain("REDIRECT:/settings?retry_result=0");
  });

  it("retryFailedInquiryNotifications redirects to /settings?retry_result=unauthorized and leaves inquiries untouched when called by a staff-role session", async () => {
    const { tenantId, userId } = await createTenant("Gallery With Staff Member");
    const artworkId = await createArtwork(tenantId);

    const id1 = await createFailedInquiry(tenantId, artworkId, "SMTP error");
    const id2 = await createFailedInquiry(tenantId, artworkId, "no gallery contact email");

    // Act as a staff member (not owner) for this tenant.
    mockSession.value = { userId, tenantId, role: "staff" };

    let caughtError: unknown;
    try {
      await retryFailedInquiryNotifications();
    } catch (e) {
      caughtError = e;
    }

    // Must redirect with unauthorized result, not reset the queue.
    expect(String(caughtError)).toContain("REDIRECT:/settings?retry_result=unauthorized");

    // Both inquiries must remain untouched — staff cannot trigger the reset.
    for (const [label, id] of [["id1", id1], ["id2", id2]] as const) {
      const row = await inquiryRow(id);
      expect(row?.emailAttempts, `${label}: emailAttempts`).toBe(MAX_EMAIL_ATTEMPTS);
      expect(row?.emailLastAttemptAt, `${label}: emailLastAttemptAt`).not.toBeNull();
      expect(row?.emailError, `${label}: emailError`).not.toBeNull();
    }
  });
});
