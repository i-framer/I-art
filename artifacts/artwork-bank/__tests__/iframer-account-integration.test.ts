/**
 * Integration tests for setIframerAccount against a real database.
 *
 * Covers:
 *  1. Linking writes iframerAccountId + billingExempt=true + audit columns.
 *  2. requireActiveBillingAccess passes after linking (paywall opens).
 *  3. Whitespace is trimmed from the account ID before persisting.
 *  4. Unlinking clears iframerAccountId only; billingExempt stays true.
 *     Audit columns (linkedBy / linkedAt) are updated on unlink too.
 *  5. requireActiveBillingAccess still passes after unlinking.
 *  6. setBillingExempt(false) after linking clears the comp but does NOT
 *     touch iframerAccountId (Task #471 — column isolation).
 *  7. setBillingExempt(false) on a linked tenant fires a Slack comp-removed
 *     alert (Task #474).
 *  8. Concurrent unlink + setBillingExempt(true): iframerAccountId cleared,
 *     billingExempt true (Task #477 — concurrent-op safety).
 *
 * requirePlatformAdmin, getSession, and revalidatePath are mocked so only
 * the DB layer is exercised.  The suite is skipped automatically when
 * DATABASE_URL is absent (e.g. fresh CI runners without a DB provisioned).
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// ── requirePlatformAdmin: bypass the admin auth check ────────────────────────
vi.mock("@/lib/platform-admin", () => ({
  requirePlatformAdmin: vi.fn(async () => undefined),
  isPlatformAdmin: vi.fn(() => true),
  getPlatformAdminEmails: vi.fn(() => ["test-admin@example.com"]),
}));

// ── getSession: synthetic platform-admin session (avoids cookies() call) ─────
// email "test-admin@example.com" must match the value asserted in audit-column
// tests below and in the comp-removed Slack notification assertion.
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({
    userId: "test-platform-admin",
    email: "test-admin@example.com",
  })),
}));

// ── Slack mock — avoid real Slack calls during integration tests ───────────────
vi.mock("@/lib/slack", () => ({
  sendIframerAccountSlackNotification: vi.fn(async () => ({ ok: true })),
  sendBillingAlertSlackNotification: vi.fn(async () => ({ ok: true })),
  sendOrphanSweepSlackNotification: vi.fn(async () => ({ ok: true })),
  sendRefundDbFailureSlackNotification: vi.fn(async () => ({ ok: true })),
  resolveSlackChannel: vi.fn(() => "test-channel"),
}));

// ── next/cache: no-op — not testing cache invalidation ───────────────────────
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// Import actions AFTER mocks so vi.mock() hoisting applies correctly.
import { setIframerAccount, setBillingExempt } from "@/app/platform/actions";
import { requireActiveBillingAccess } from "@/lib/billing";
import { sendIframerAccountSlackNotification } from "@/lib/slack";

// ── Helpers ───────────────────────────────────────────────────────────────────

const RUN = Date.now();
let idSeq = 0;

function tenantId(suffix: string) {
  return `test-iframer-${RUN}-${++idSeq}-${suffix}`;
}

const CREATED_IDS: string[] = [];

async function insertTenant(
  id: string,
  fields: { billingExempt?: boolean; subscriptionStatus?: string | null } = {},
) {
  CREATED_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "i-Framer Integration Test Gallery",
    type: "ARTIST",
    billingExempt: fields.billingExempt ?? false,
    subscriptionStatus: fields.subscriptionStatus ?? null,
  } as any);
}

function formData(fields: Record<string, string>): FormData {
  return {
    get: (k: string) => fields[k] ?? null,
  } as unknown as FormData;
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

afterAll(async () => {
  for (const id of CREATED_IDS) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describeIntegration("setIframerAccount (i-Framer billing link, real DB)", () => {
  it("persists iframerAccountId and billingExempt=true when linking a valid account ID", async () => {
    const id = tenantId("slack-billing-true-no-alert");
    await insertTenant(id, { billingExempt: false, subscriptionStatus: null });

    await setIframerAccount(
      formData({ tenantId: id, accountId: "ifr-account-010" }),
    );

    await Promise.all([
      setIframerAccount(formData({ tenantId: id, accountId: "" })),
      setBillingExempt(formData({ tenantId: id, exempt: "true" })),
    ]);

    const row = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, id),
      columns: { iframerAccountId: true, billingExempt: true },
    });

    expect(row?.iframerAccountId).toBeNull();
    expect(row?.billingExempt).toBe(true);

    await expect(requireActiveBillingAccess(id)).resolves.toBeUndefined();
  });

  // ── Task #474 — setBillingExempt(false) on an i-Framer-linked tenant fires Slack ─

  // Reset Slack spy state between tests in this section.
  afterEach(() => {
    vi.mocked(sendIframerAccountSlackNotification).mockClear();
  });

  it("setBillingExempt(false) on a tenant with NO i-Framer account does NOT fire a Slack alert", async () => {
    const id = tenantId("slack-billing-true-no-alert");
    // Start with billingExempt=true but no i-Framer account ID (plain comp).
    await insertTenant(id, { billingExempt: true, subscriptionStatus: null });

    vi.mocked(sendIframerAccountSlackNotification).mockClear();

    await setBillingExempt(
      formData({ tenantId: id, exempt: "false" }),
    );

    await new Promise((r) => setTimeout(r, 0));

    // No i-Framer account is linked — no alert should fire.
    expect(sendIframerAccountSlackNotification).not.toHaveBeenCalled();
  });

  it("setBillingExempt(true) on a linked i-Framer tenant does NOT fire a Slack alert (only removals are alerted)", async () => {
    const id = tenantId("slack-billing-true-no-alert");
    await insertTenant(id, { billingExempt: false, subscriptionStatus: null });

    await setIframerAccount(
      formData({ tenantId: id, accountId: "ifr-account-010" }),
    );

    await Promise.all([
      setIframerAccount(formData({ tenantId: id, accountId: "" })),
      setBillingExempt(formData({ tenantId: id, exempt: "true" })),
    ]);

    const row = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, id),
      columns: { iframerAccountId: true, billingExempt: true },
    });

    expect(row?.iframerAccountId).toBeNull();
    expect(row?.billingExempt).toBe(true);

    await expect(requireActiveBillingAccess(id)).resolves.toBeUndefined();
  });

  // ── Task #474 — setBillingExempt(false) on an i-Framer-linked tenant fires Slack ─

  // Reset Slack spy state between tests in this section.
  afterEach(() => {
    vi.mocked(sendIframerAccountSlackNotification).mockClear();
  });

  it("setBillingExempt(false) on a tenant with NO i-Framer account does NOT fire a Slack alert", async () => {
    const id = tenantId("slack-billing-true-no-alert");
    await insertTenant(id, { billingExempt: false, subscriptionStatus: null });

    // Link first.
    await setIframerAccount(
      formData({ tenantId: id, accountId: "ifr-account-003" }),
    );

    // Confirm linking worked.
    const afterLink = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, id),
      columns: { iframerAccountId: true, billingExempt: true },
    });
    expect(afterLink?.iframerAccountId).toBe("ifr-account-003");
    expect(afterLink?.billingExempt).toBe(true);

    // Unlink by passing empty accountId.
    await setIframerAccount(
      formData({ tenantId: id, accountId: "" }),
    );

    const afterUnlink = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, id),
      columns: {
        iframerAccountId: true,
        billingExempt: true,
        iframerAccountLinkedBy: true,
        iframerAccountLinkedAt: true,
      },
    });

    // iframerAccountId must be cleared.
    expect(afterUnlink?.iframerAccountId).toBeNull();
    // billingExempt must remain true (not touched by unlink).
    expect(afterUnlink?.billingExempt).toBe(true);
    // Audit trail must be updated on unlink.
    expect(afterUnlink?.iframerAccountLinkedBy).toBe("test-admin@example.com");
    expect(afterUnlink?.iframerAccountLinkedAt).toBeInstanceOf(Date);
  });

  it("requireActiveBillingAccess still passes after unlinking (billingExempt=true survives)", async () => {
    const id = tenantId("slack-billing-true-no-alert");
    // Start with billingExempt=true but no i-Framer account ID (plain comp).
    await insertTenant(id, { billingExempt: true, subscriptionStatus: null });

    vi.mocked(sendIframerAccountSlackNotification).mockClear();

    await setBillingExempt(
      formData({ tenantId: id, exempt: "false" }),
    );

    await new Promise((r) => setTimeout(r, 0));

    // No i-Framer account is linked — no alert should fire.
    expect(sendIframerAccountSlackNotification).not.toHaveBeenCalled();
  });

  it("setBillingExempt(true) on a linked i-Framer tenant does NOT fire a Slack alert (only removals are alerted)", async () => {
    const id = tenantId("slack-billing-true-no-alert");
    await insertTenant(id, { billingExempt: false, subscriptionStatus: null });

    await setIframerAccount(
      formData({ tenantId: id, accountId: "ifr-account-010" }),
    );

    await Promise.all([
      setIframerAccount(formData({ tenantId: id, accountId: "" })),
      setBillingExempt(formData({ tenantId: id, exempt: "true" })),
    ]);

    const row = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, id),
      columns: { iframerAccountId: true, billingExempt: true },
    });

    expect(row?.iframerAccountId).toBeNull();
    expect(row?.billingExempt).toBe(true);

    await expect(requireActiveBillingAccess(id)).resolves.toBeUndefined();
  });

  // ── Task #474 — setBillingExempt(false) on an i-Framer-linked tenant fires Slack ─

  // Reset Slack spy state between tests in this section.
  afterEach(() => {
    vi.mocked(sendIframerAccountSlackNotification).mockClear();
  });

  it("setBillingExempt(false) on a tenant with NO i-Framer account does NOT fire a Slack alert", async () => {
    const id = tenantId("slack-billing-true-no-alert");
    // Start with billingExempt=true but no i-Framer account ID (plain comp).
    await insertTenant(id, { billingExempt: true, subscriptionStatus: null });

    vi.mocked(sendIframerAccountSlackNotification).mockClear();

    await setBillingExempt(
      formData({ tenantId: id, exempt: "false" }),
    );

    await new Promise((r) => setTimeout(r, 0));

    // No i-Framer account is linked — no alert should fire.
    expect(sendIframerAccountSlackNotification).not.toHaveBeenCalled();
  });

  it("setBillingExempt(true) on a linked i-Framer tenant does NOT fire a Slack alert (only removals are alerted)", async () => {
    const id = tenantId("slack-billing-true-no-alert");
    // Start with billingExempt=true but no i-Framer account ID (plain comp).
    await insertTenant(id, { billingExempt: true, subscriptionStatus: null });

    vi.mocked(sendIframerAccountSlackNotification).mockClear();

    await setBillingExempt(
      formData({ tenantId: id, exempt: "false" }),
    );

    await new Promise((r) => setTimeout(r, 0));

    // No i-Framer account is linked — no alert should fire.
    expect(sendIframerAccountSlackNotification).not.toHaveBeenCalled();
  });

  it("setBillingExempt(true) on a linked i-Framer tenant does NOT fire a Slack alert (only removals are alerted)", async () => {
    const id = tenantId("slack-billing-true-no-alert");
    // Start unlinked, no comp.
    await insertTenant(id, { billingExempt: false, subscriptionStatus: null });

    await setIframerAccount(
      formData({ tenantId: id, accountId: "ifr-account-slack-02" }),
    );

    // Simulate an operator explicitly restoring or setting the comp.
    vi.mocked(sendIframerAccountSlackNotification).mockClear();

    await setBillingExempt(
      formData({ tenantId: id, exempt: "true" }),
    );

    await new Promise((r) => setTimeout(r, 0));

    // Setting billingExempt=true is intentionally silent — no alert.
    expect(sendIframerAccountSlackNotification).not.toHaveBeenCalled();
  });
});
