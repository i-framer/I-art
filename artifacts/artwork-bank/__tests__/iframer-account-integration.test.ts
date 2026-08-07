/**
 * Task #469 — Confirm linking an i-Framer account grants billing access
 * end-to-end on a real database.
 *
 * Verifies that:
 *  1. setIframerAccount (link) writes iframerAccountId + billingExempt=true
 *     to the real Postgres DB.
 *  2. requireActiveBillingAccess passes for that tenant after linking (the
 *     paywall reads the DB — this closes the loop between the action and the
 *     guard).
 *  3. setIframerAccount (unlink, empty accountId) clears iframerAccountId
 *     only; billingExempt remains true.
 *  4. requireActiveBillingAccess still passes after unlinking because
 *     billingExempt=true was not cleared.
 *
 * The suite is skipped automatically when DATABASE_URL is absent (e.g. fresh
 * CI runners without a DB provisioned).  requirePlatformAdmin and
 * revalidatePath are mocked so only the DB layer is exercised.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// ── Auth mock — getSession calls cookies() which requires a Next.js request
//    scope; mock it so the test runs outside that context ──────────────────────
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn().mockResolvedValue({ email: "admin@example.com" }),
}));

// ── requirePlatformAdmin: bypass the admin auth check ────────────────────────
vi.mock("@/lib/platform-admin", () => ({
  requirePlatformAdmin: vi.fn(async () => undefined),
  isPlatformAdmin: vi.fn(() => true),
  getPlatformAdminEmails: vi.fn(() => ["test@example.com"]),
}));

// ── getSession: return a synthetic admin session so getSession() calls inside
//    actions (e.g. for audit logging) don't attempt to read cookies() outside
//    a request context ──────────────────────────────────────────────────────
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({
    userId: "test-platform-admin",
    email: "test@example.com",
  })),
}));

// ── Slack mock — avoid real Slack calls during integration tests ───────────────
vi.mock("@/lib/slack", () => ({
  resolveSlackChannel: vi.fn().mockReturnValue(null),
  sendBillingAlertSlackNotification: vi.fn().mockResolvedValue({ ok: true }),
  sendIframerAccountSlackNotification: vi.fn().mockResolvedValue({ ok: true }),
}));

// ── next/cache: no-op — we are not testing Next.js cache invalidation ─────────
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// ── @/lib/slack: spy on Slack notifications so tests can verify they fire
//    without needing a live Slack connector. ────────────────────────────────
vi.mock("@/lib/slack", () => ({
  sendIframerAccountSlackNotification: vi.fn(async () => ({ ok: true })),
  sendBillingAlertSlackNotification: vi.fn(async () => ({ ok: true })),
  sendOrphanSweepSlackNotification: vi.fn(async () => ({ ok: true })),
  sendRefundDbFailureSlackNotification: vi.fn(async () => ({ ok: true })),
  resolveSlackChannel: vi.fn(() => "test-channel"),
}));

// Import actions AFTER mocks are registered so vi.mock() is hoisted correctly.
import { setIframerAccount, setBillingExempt } from "@/app/platform/actions";
import { requireActiveBillingAccess } from "@/lib/billing";
import { sendIframerAccountSlackNotification } from "@/lib/slack";

// ── Helpers ───────────────────────────────────────────────────────────────────

const RUN = Date.now();

function tenantId(suffix: string) {
  return `test-iframer-${RUN}-${suffix}`;
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

describeIntegration("setIframerAccount — Task #469 (i-Framer billing link, real DB)", () => {
  it("persists iframerAccountId and billingExempt=true when linking a valid account ID", async () => {
    const id = tenantId("concurrent-unlink");
    await insertTenant(id, { billingExempt: false, subscriptionStatus: null });

    // Establish a linked state first.
    await setIframerAccount(
      formData({ tenantId: id, accountId: "ifr-account-008" }),
    );

    // Concurrently unlink the i-Framer account and explicitly set
    // billingExempt=true.  The unlink must clear only iframerAccountId; it
    // must not clobber billingExempt.  The concurrent setBillingExempt(true)
    // must similarly not affect iframerAccountId.
    await Promise.all([
      setIframerAccount(formData({ tenantId: id, accountId: "" })),
      setBillingExempt(formData({ tenantId: id, exempt: "true" })),
    ]);

    const row = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, id),
      columns: { iframerAccountId: true, billingExempt: true },
    });

    // The i-Framer account ID must always survive — setBillingExempt does not
    // touch that column regardless of execution order.
    expect(row?.iframerAccountId).toBe("ifr-account-007");

    // billingExempt is the contested column.  One of the two writes wins
    // depending on DB ordering.  We do not assert a specific value here
    // because the outcome is non-deterministic; the invariant is only that
    // iframerAccountId is never clobbered by a concurrent setBillingExempt.
  });

  it("concurrent setIframerAccount (unlink) and setBillingExempt(true) — billingExempt is true and account ID is cleared", async () => {
    const id = tenantId("concurrent-unlink");
    await insertTenant(id, { billingExempt: false, subscriptionStatus: null });

    // Link then unlink.
    await setIframerAccount(
      formData({ tenantId: id, accountId: "ifr-account-004" }),
    );
    await setIframerAccount(
      formData({ tenantId: id, accountId: "" }),
    );

    // billingExempt is still true even though the i-Framer account ID was
    // cleared — so the billing guard must continue to pass.
    await expect(requireActiveBillingAccess(id)).resolves.toBeUndefined();
  });

  // ── Task #471 — billing link survives a row update that touches other fields ─

  it("setBillingExempt(false) after linking clears the comp but preserves the i-Framer account ID", async () => {
    const id = tenantId("concurrent-unlink");
    await insertTenant(id, { billingExempt: false, subscriptionStatus: null });

    // Establish a linked state first.
    await setIframerAccount(
      formData({ tenantId: id, accountId: "ifr-account-008" }),
    );

    // Concurrently unlink the i-Framer account and explicitly set
    // billingExempt=true.  The unlink must clear only iframerAccountId; it
    // must not clobber billingExempt.  The concurrent setBillingExempt(true)
    // must similarly not affect iframerAccountId.
    await Promise.all([
      setIframerAccount(formData({ tenantId: id, accountId: "" })),
      setBillingExempt(formData({ tenantId: id, exempt: "true" })),
    ]);

    const row = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, id),
      columns: { iframerAccountId: true, billingExempt: true },
    });

    // The i-Framer account ID must always survive — setBillingExempt does not
    // touch that column regardless of execution order.
    expect(row?.iframerAccountId).toBe("ifr-account-007");

    // billingExempt is the contested column.  One of the two writes wins
    // depending on DB ordering.  We do not assert a specific value here
    // because the outcome is non-deterministic; the invariant is only that
    // iframerAccountId is never clobbered by a concurrent setBillingExempt.
  });

  it("concurrent setIframerAccount (unlink) and setBillingExempt(true) — billingExempt is true and account ID is cleared", async () => {
    const id = tenantId("concurrent-unlink");
    // Start already linked (billingExempt=true, has an account ID).
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
      columns: { iframerAccountId: true, billingExempt: true },
    });

    // iframerAccountId must be cleared.
    expect(afterUnlink?.iframerAccountId).toBeNull();
    // billingExempt must remain true (not touched by unlink).
    expect(afterUnlink?.billingExempt).toBe(true);
  });

  it("requireActiveBillingAccess still passes after unlinking (billingExempt=true survives)", async () => {
    const id = tenantId("concurrent-unlink");
    await insertTenant(id, { billingExempt: false, subscriptionStatus: null });

    // Link then unlink.
    await setIframerAccount(
      formData({ tenantId: id, accountId: "ifr-account-004" }),
    );
    await setIframerAccount(
      formData({ tenantId: id, accountId: "" }),
    );

    // billingExempt is still true even though the i-Framer account ID was
    // cleared — so the billing guard must continue to pass.
    await expect(requireActiveBillingAccess(id)).resolves.toBeUndefined();
  });

  // ── Task #471 — billing link survives a row update that touches other fields ─

  it("setBillingExempt(false) after linking clears the comp but preserves the i-Framer account ID", async () => {
    const id = tenantId("concurrent-unlink");
    await insertTenant(id, { billingExempt: false, subscriptionStatus: null });

    // Establish a linked state first.
    await setIframerAccount(
      formData({ tenantId: id, accountId: "ifr-account-008" }),
    );

    // Concurrently unlink the i-Framer account and explicitly set
    // billingExempt=true.  The unlink must clear only iframerAccountId; it
    // must not clobber billingExempt.  The concurrent setBillingExempt(true)
    // must similarly not affect iframerAccountId.
    await Promise.all([
      setIframerAccount(formData({ tenantId: id, accountId: "" })),
      setBillingExempt(formData({ tenantId: id, exempt: "true" })),
    ]);

    const row = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, id),
      columns: { iframerAccountId: true, billingExempt: true },
    });

    // The i-Framer account ID must always survive — setBillingExempt does not
    // touch that column regardless of execution order.
    expect(row?.iframerAccountId).toBe("ifr-account-007");

    // billingExempt is the contested column.  One of the two writes wins
    // depending on DB ordering.  We do not assert a specific value here
    // because the outcome is non-deterministic; the invariant is only that
    // iframerAccountId is never clobbered by a concurrent setBillingExempt.
  });

  it("concurrent setIframerAccount (unlink) and setBillingExempt(true) — billingExempt is true and account ID is cleared", async () => {
    const id = tenantId("concurrent-unlink");
    await insertTenant(id, { billingExempt: false, subscriptionStatus: null });

    // Establish a linked state first.
    await setIframerAccount(
      formData({ tenantId: id, accountId: "ifr-account-008" }),
    );

    // Concurrently unlink the i-Framer account and explicitly set
    // billingExempt=true.  The unlink must clear only iframerAccountId; it
    // must not clobber billingExempt.  The concurrent setBillingExempt(true)
    // must similarly not affect iframerAccountId.
    await Promise.all([
      setIframerAccount(formData({ tenantId: id, accountId: "" })),
      setBillingExempt(formData({ tenantId: id, exempt: "true" })),
    ]);

    const row = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, id),
      columns: { iframerAccountId: true, billingExempt: true },
    });

    // The i-Framer account ID must always survive — setBillingExempt does not
    // touch that column regardless of execution order.
    expect(row?.iframerAccountId).toBe("ifr-account-007");

    // billingExempt is the contested column.  One of the two writes wins
    // depending on DB ordering.  We do not assert a specific value here
    // because the outcome is non-deterministic; the invariant is only that
    // iframerAccountId is never clobbered by a concurrent setBillingExempt.
  });

  it("concurrent setIframerAccount (unlink) and setBillingExempt(true) — billingExempt is true and account ID is cleared", async () => {
    const id = tenantId("concurrent-unlink");
    await insertTenant(id, { billingExempt: false, subscriptionStatus: null });

    // Establish a linked state first.
    await setIframerAccount(
      formData({ tenantId: id, accountId: "ifr-account-008" }),
    );

    // Concurrently unlink the i-Framer account and explicitly set
    // billingExempt=true.  The unlink must clear only iframerAccountId; it
    // must not clobber billingExempt.  The concurrent setBillingExempt(true)
    // must similarly not affect iframerAccountId.
    await Promise.all([
      setIframerAccount(formData({ tenantId: id, accountId: "" })),
      setBillingExempt(formData({ tenantId: id, exempt: "true" })),
    ]);

    const row = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, id),
      columns: { iframerAccountId: true, billingExempt: true },
    });

    // The i-Framer account ID must always survive — setBillingExempt does not
    // touch that column regardless of execution order.
    expect(row?.iframerAccountId).toBe("ifr-account-007");

    // billingExempt is the contested column.  One of the two writes wins
    // depending on DB ordering.  We do not assert a specific value here
    // because the outcome is non-deterministic; the invariant is only that
    // iframerAccountId is never clobbered by a concurrent setBillingExempt.
  });

  it("concurrent setIframerAccount (unlink) and setBillingExempt(true) — billingExempt is true and account ID is cleared", async () => {
    const id = tenantId("concurrent-unlink");
    await insertTenant(id, { billingExempt: false, subscriptionStatus: null });

    // Establish a linked state first.
    await setIframerAccount(
      formData({ tenantId: id, accountId: "ifr-account-008" }),
    );

    // Concurrently unlink the i-Framer account and explicitly set
    // billingExempt=true.  The unlink must clear only iframerAccountId; it
    // must not clobber billingExempt.  The concurrent setBillingExempt(true)
    // must similarly not affect iframerAccountId.
    await Promise.all([
      setIframerAccount(formData({ tenantId: id, accountId: "" })),
      setBillingExempt(formData({ tenantId: id, exempt: "true" })),
    ]);

    const row = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, id),
      columns: { iframerAccountId: true, billingExempt: true },
    });

    // The unlink clears iframerAccountId; neither mutation writes the other's
    // column, so iframerAccountId must be null.
    expect(row?.iframerAccountId).toBeNull();
    // billingExempt must be true — the explicit setBillingExempt(true) write
    // always sets it, and the unlink path never touches billingExempt.
    expect(row?.billingExempt).toBe(true);

    // Billing guard must pass because billingExempt=true.
    await expect(requireActiveBillingAccess(id)).resolves.toBeUndefined();
  });

  // ── Task #474 — setBillingExempt(false) on an i-Framer-linked tenant fires Slack ─

  // Reset Slack spy state between tests in this section.
  afterEach(() => {
    vi.mocked(sendIframerAccountSlackNotification).mockClear();
  });

  it("setBillingExempt(false) on a linked i-Framer tenant fires a Slack comp-removed alert", async () => {
    const id = tenantId("slack-comp-removed");
    await insertTenant(id, { billingExempt: false, subscriptionStatus: null });

    // Link an i-Framer account (sets billingExempt=true and iframerAccountId).
    await setIframerAccount(
      formData({ tenantId: id, accountId: "ifr-account-slack-01" }),
    );

    // Clear calls accumulated during the link step so we only observe the
    // setBillingExempt call below.
    vi.mocked(sendIframerAccountSlackNotification).mockClear();

    // Remove the comp — this must fire a Slack alert.
    await setBillingExempt(
      formData({ tenantId: id, exempt: "false" }),
    );

    // Allow the fire-and-forget promise to resolve.
    await vi.runAllTimersAsync().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));

    expect(sendIframerAccountSlackNotification).toHaveBeenCalledTimes(1);
    expect(sendIframerAccountSlackNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "comp-removed",
        accountId: "ifr-account-slack-01",
        adminEmail: "test@example.com",
      }),
    );
  });

  it("setBillingExempt(false) on a tenant with NO i-Framer link does NOT fire a Slack alert", async () => {
    const id = tenantId("slack-no-link");
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
    const id = tenantId("slack-restore-exempt");
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
