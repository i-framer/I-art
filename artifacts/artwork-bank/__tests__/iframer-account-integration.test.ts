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
import { afterAll, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

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

// ── next/cache: no-op — we are not testing Next.js cache invalidation ─────────
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// Import actions AFTER mocks are registered so vi.mock() is hoisted correctly.
import { setIframerAccount, setBillingExempt } from "@/app/platform/actions";
import { requireActiveBillingAccess } from "@/lib/billing";

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
    const id = tenantId("link");
    await insertTenant(id, { billingExempt: false, subscriptionStatus: null });

    await setIframerAccount(
      formData({ tenantId: id, accountId: "ifr-account-001" }),
    );

    const row = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, id),
      columns: { iframerAccountId: true, billingExempt: true },
    });

    expect(row?.iframerAccountId).toBe("ifr-account-001");
    expect(row?.billingExempt).toBe(true);
  });

  it("requireActiveBillingAccess passes after linking (paywall opens for i-Framer tenant)", async () => {
    const id = tenantId("paywall-link");
    // Start with no subscription and billing NOT exempt.
    await insertTenant(id, { billingExempt: false, subscriptionStatus: null });

    // Confirm the tenant is initially locked out (sanity-check).
    await expect(requireActiveBillingAccess(id)).rejects.toThrow(
      "Subscription required",
    );

    // Link an i-Framer account — this must flip billingExempt to true.
    await setIframerAccount(
      formData({ tenantId: id, accountId: "ifr-account-002" }),
    );

    // The billing guard reads the DB — it must now pass.
    await expect(requireActiveBillingAccess(id)).resolves.toBeUndefined();
  });

  it("trims whitespace from the account ID before persisting", async () => {
    const id = tenantId("trim");
    await insertTenant(id, { billingExempt: false, subscriptionStatus: null });

    await setIframerAccount(
      formData({ tenantId: id, accountId: "  ifr-account-trim  " }),
    );

    const row = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, id),
      columns: { iframerAccountId: true },
    });

    expect(row?.iframerAccountId).toBe("ifr-account-trim");
  });

  it("unlinking clears iframerAccountId and leaves billingExempt=true unchanged", async () => {
    const id = tenantId("unlink");
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
    const id = tenantId("paywall-unlink");
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
    const id = tenantId("clobber-exempt");
    await insertTenant(id, { billingExempt: false, subscriptionStatus: null });

    // Link an i-Framer account — billingExempt becomes true.
    await setIframerAccount(
      formData({ tenantId: id, accountId: "ifr-account-005" }),
    );

    // Confirm the tenant is currently admitted.
    await expect(requireActiveBillingAccess(id)).resolves.toBeUndefined();

    // An operator explicitly removes the comp via setBillingExempt.
    // setBillingExempt only touches billingExempt — it must NOT clear
    // iframerAccountId.
    await setBillingExempt(
      formData({ tenantId: id, exempt: "false" }),
    );

    const row = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, id),
      columns: { iframerAccountId: true, billingExempt: true },
    });

    // The i-Framer account ID must still be present — setBillingExempt must
    // not touch iframerAccountId.
    expect(row?.iframerAccountId).toBe("ifr-account-005");
    // billingExempt was explicitly cleared.
    expect(row?.billingExempt).toBe(false);

    // The comp is gone — billing guard must now reject (no active subscription).
    await expect(requireActiveBillingAccess(id)).rejects.toThrow(
      "Subscription required",
    );
  });

  it("setBillingExempt(true) applied after linking, then unlink — billingExempt stays true", async () => {
    const id = tenantId("exempt-survives-unlink");
    await insertTenant(id, { billingExempt: false, subscriptionStatus: null });

    // Link an i-Framer account (sets billingExempt=true via setIframerAccount).
    await setIframerAccount(
      formData({ tenantId: id, accountId: "ifr-account-006" }),
    );

    // Operator also explicitly sets billingExempt=true as an independent comp
    // (simulates a scenario where the comp predates or is separate from the
    // i-Framer link).
    await setBillingExempt(
      formData({ tenantId: id, exempt: "true" }),
    );

    // Unlink the i-Framer account — only iframerAccountId should be cleared.
    await setIframerAccount(
      formData({ tenantId: id, accountId: "" }),
    );

    const row = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, id),
      columns: { iframerAccountId: true, billingExempt: true },
    });

    // i-Framer account ID is gone.
    expect(row?.iframerAccountId).toBeNull();
    // billingExempt must remain true — it was set independently by
    // setBillingExempt and must not be cleared by the unlink.
    expect(row?.billingExempt).toBe(true);

    // Billing guard must still pass.
    await expect(requireActiveBillingAccess(id)).resolves.toBeUndefined();
  });

  it("concurrent setIframerAccount (link) and setBillingExempt(false) on the same row — i-Framer account ID is preserved", async () => {
    const id = tenantId("concurrent-clobber");
    await insertTenant(id, { billingExempt: false, subscriptionStatus: null });

    // Fire both mutations concurrently against the same tenant row.
    // setIframerAccount writes iframerAccountId + billingExempt=true.
    // setBillingExempt writes billingExempt=false.
    // The key invariant: iframerAccountId must remain set regardless of which
    // write wins, because setBillingExempt must never touch iframerAccountId.
    await Promise.all([
      setIframerAccount(formData({ tenantId: id, accountId: "ifr-account-007" })),
      setBillingExempt(formData({ tenantId: id, exempt: "false" })),
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
});
