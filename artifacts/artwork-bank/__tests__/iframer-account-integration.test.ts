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
}));

// ── next/cache: no-op — we are not testing Next.js cache invalidation ─────────
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// Import actions AFTER mocks are registered so vi.mock() is hoisted correctly.
import { setIframerAccount } from "@/app/platform/actions";
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
});
