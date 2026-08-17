/**
 * requeueAllFailedInquiries + retryFailedInquiryNotifications — real-DB integration.
 *
 * lib/email-sweep.ts: requeueAllFailedInquiries(tenantId)
 * app/(admin)/settings/actions.ts: retryFailedInquiryNotifications()
 *
 * Tests:
 *  1.  requeueAllFailedInquiries resets emailAttempts to 0 and emailLastAttemptAt
 *      to null for all inquiries with a non-null emailError.
 *  2.  requeueAllFailedInquiries preserves emailError on every reset row so the
 *      sweep's `emailError IS NOT NULL` candidate filter can still select them.
 *  3.  requeueAllFailedInquiries resets rows regardless of error type (SMTP
 *      errors, no-contact-email sentinel, custom strings — all treated the same).
 *  4.  requeueAllFailedInquiries does NOT touch inquiries with a null emailError
 *      (rows that are already sweep-eligible or successfully delivered).
 *  5.  requeueAllFailedInquiries is scoped to the specified tenant — a second
 *      tenant's stuck inquiries are left completely untouched.
 *  6.  requeueAllFailedInquiries returns the exact count of rows that were reset.
 *  7.  requeueAllFailedInquiries is idempotent — calling it twice leaves every
 *      row at emailAttempts=0, emailLastAttemptAt=null.
 *  8.  retryFailedInquiryNotifications action resets all failed inquiries for
 *      the authenticated tenant and redirects to /settings?retry_result=<count>.
 *  9.  retryFailedInquiryNotifications is scoped to the session tenant — a
 *      concurrent tenant's stuck inquiries are left untouched.
 *  10. retryFailedInquiryNotifications redirects to /settings?retry_result=0
 *      when no stuck inquiries exist (no-op path).
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
import { requeueAllFailedInquiries, MAX_EMAIL_ATTEMPTS } from "@/lib/email-sweep";

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

describeIntegration("requeueAllFailedInquiries + retryFailedInquiryNotifications — real-DB integration", () => {
  it("resets emailAttempts to 0 and emailLastAttemptAt to null for all inquiries with a non-null emailError", async () => {
    const { tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId);

    const id1 = await createFailedInquiry(tenantId, artworkId, "550 mailbox not found");
    const id2 = await createFailedInquiry(tenantId, artworkId, "SMTP connection timeout");
    const id3 = await createFailedInquiry(tenantId, artworkId, "no gallery contact email");

    // All three start exhausted.
    for (const id of [id1, id2, id3]) {
      const row = await inquiryRow(id);
      expect(row?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
      expect(row?.emailLastAttemptAt).not.toBeNull();
    }

    await requeueAllFailedInquiries(tenantId);

    // All three must now have emailAttempts=0 and emailLastAttemptAt=null.
    for (const [label, id] of [["id1", id1], ["id2", id2], ["id3", id3]] as const) {
      const row = await inquiryRow(id);
      expect(row?.emailAttempts, `${label}: emailAttempts`).toBe(0);
      expect(row?.emailLastAttemptAt, `${label}: emailLastAttemptAt`).toBeNull();
    }
  });

  it("preserves emailError on every reset row so the sweep candidate filter still selects them", async () => {
    const { tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId);

    const smtpId = await createFailedInquiry(tenantId, artworkId, "550 mailbox not found");
    const noEmailId = await createFailedInquiry(tenantId, artworkId, "no gallery contact email");

    await requeueAllFailedInquiries(tenantId);

    // emailError must be preserved — the sweep uses `emailError IS NOT NULL`
    // to select candidates.  Clearing it would make the row invisible to the sweep.
    const smtpRow = await inquiryRow(smtpId);
    expect(smtpRow?.emailError).toBe("550 mailbox not found");

    const noEmailRow = await inquiryRow(noEmailId);
    expect(noEmailRow?.emailError).toBe("no gallery contact email");
  });

  it("resets rows regardless of error type — SMTP errors, no-contact sentinel, and custom strings all treated the same", async () => {
    const { tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId);

    const ids = await Promise.all([
      createFailedInquiry(tenantId, artworkId, "550 mailbox not found"),
      createFailedInquiry(tenantId, artworkId, "no gallery contact email"),
      createFailedInquiry(tenantId, artworkId, "SMTP connection refused"),
      createFailedInquiry(tenantId, artworkId, "custom error string"),
    ]);

    await requeueAllFailedInquiries(tenantId);

    for (const [i, id] of ids.entries()) {
      const row = await inquiryRow(id);
      expect(row?.emailAttempts, `id[${i}]: emailAttempts`).toBe(0);
      expect(row?.emailLastAttemptAt, `id[${i}]: emailLastAttemptAt`).toBeNull();
    }
  });

  it("does NOT touch inquiries with a null emailError", async () => {
    const { tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId);

    const cleanId = await createCleanInquiry(tenantId, artworkId);
    const failedId = await createFailedInquiry(tenantId, artworkId, "SMTP error");

    await requeueAllFailedInquiries(tenantId);

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
    await requeueAllFailedInquiries(tenantA);

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

  it("returns the exact count of rows that were reset", async () => {
    const { tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId);

    // 3 failed, 1 clean.
    await createFailedInquiry(tenantId, artworkId, "error 1");
    await createFailedInquiry(tenantId, artworkId, "error 2");
    await createFailedInquiry(tenantId, artworkId, "error 3");
    await createCleanInquiry(tenantId, artworkId);

    const count = await requeueAllFailedInquiries(tenantId);
    // Must return 3 — only the failed rows are counted, not the clean one.
    expect(count).toBe(3);
  });

  it("returns 0 when there are no stuck inquiries (idempotent no-op)", async () => {
    const { tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId);
    await createCleanInquiry(tenantId, artworkId);

    const count = await requeueAllFailedInquiries(tenantId);
    expect(count).toBe(0);
  });

  it("is idempotent — calling it twice leaves every row at emailAttempts=0 and emailLastAttemptAt=null", async () => {
    const { tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const id = await createFailedInquiry(tenantId, artworkId, "SMTP error");

    const count1 = await requeueAllFailedInquiries(tenantId);
    expect(count1).toBe(1);

    // Second call: row is already at emailAttempts=0; it will be selected again
    // because emailError is still non-null (preserved by the first call).
    const count2 = await requeueAllFailedInquiries(tenantId);
    expect(count2).toBe(1);

    // Row remains correctly reset after both calls.
    const row = await inquiryRow(id);
    expect(row?.emailAttempts).toBe(0);
    expect(row?.emailLastAttemptAt).toBeNull();
    expect(row?.emailError).toBe("SMTP error");
  });

  it("retryFailedInquiryNotifications action resets all failed inquiries for the authenticated tenant and redirects to /settings?retry_result=<count>", async () => {
    const { tenantId } = await createTenant("Gallery With Failed Inquiries");
    const artworkId = await createArtwork(tenantId);

    const id1 = await createFailedInquiry(tenantId, artworkId, "550 mailbox not found");
    const id2 = await createFailedInquiry(tenantId, artworkId, "SMTP connection timeout");

    let caughtError: unknown;
    try {
      await retryFailedInquiryNotifications();
    } catch (e) {
      caughtError = e;
    }

    // Must redirect to /settings?retry_result=2 (both rows reset).
    expect(String(caughtError)).toContain("REDIRECT:/settings?retry_result=2");

    // Both inquiries must have been reset.
    for (const [label, id] of [["id1", id1], ["id2", id2]] as const) {
      const row = await inquiryRow(id);
      expect(row?.emailAttempts, `${label}: emailAttempts`).toBe(0);
      expect(row?.emailLastAttemptAt, `${label}: emailLastAttemptAt`).toBeNull();
    }
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
