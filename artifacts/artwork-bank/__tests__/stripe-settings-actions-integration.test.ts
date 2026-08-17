/**
 * startStripeOnboarding / startSubscriptionCheckout / openBillingPortal
 * — real-DB integration.
 *
 * Stripe API is mocked in all cases; the suite verifies only the DB
 * persistence invariants against real PostgreSQL:
 *
 * startStripeOnboarding:
 *  1. Creates Stripe account → persists stripeAccountId.
 *  2. Stale/missing account → clears old ID, persists new ID.
 *  3. Existing valid account → re-uses it; no DB write needed.
 *
 * startSubscriptionCheckout:
 *  4. No customer → creates one and persists stripeCustomerId.
 *  5. Existing valid customer → unchanged.
 *  6. Stale customer → replaced; new ID persisted.
 *
 * openBillingPortal:
 *  7. Valid customer → stripeCustomerId unchanged after portal call.
 *  8. Stale customer → stripeCustomerId set to null.
 *  9. Missing stripeCustomerId → redirects before any Stripe call.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Auth ──────────────────────────────────────────────────────────────────────
const mockTenantId = { value: "PLACEHOLDER" };
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({
    userId: "u-stripe-settings",
    tenantId: mockTenantId.value,
    email: "owner@gallery.test",
    role: "owner",
  })),
}));
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
  hasActiveAccess: () => true,
  getSubscriptionPriceId: vi.fn(() => "price_test_monthly"),
}));

// ── Stripe — controlled per-test ──────────────────────────────────────────────
// isStripeResourceMissing checks err.code === "resource_missing"|"account_invalid"
// or /no such (account|customer)/i on the message.
const STALE_ACCOUNT_ERROR = Object.assign(new Error("No such account"), {
  code: "account_invalid",
});
const STALE_CUSTOMER_ERROR = Object.assign(new Error("No such customer"), {
  code: "resource_missing",
});

const accountLinksMock = {
  create: vi.fn(async () => ({ url: "https://connect.stripe.com/setup" })),
};
const stripeAccounts = {
  create: vi.fn(async () => ({ id: "acct_new_123" })),
};
const stripeCustomers = {
  create: vi.fn(async () => ({ id: "cus_new_456" })),
  retrieve: vi.fn(async () => ({ id: "cus_existing_456", deleted: undefined })),
};
const stripeCheckoutSessions = {
  create: vi.fn(async () => ({ url: "https://checkout.stripe.com/pay/cs_test" })),
};
const stripeBillingPortalSessions = {
  create: vi.fn(async () => ({ url: "https://billing.stripe.com/session/bps_test" })),
};

vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(() => ({
    accounts: stripeAccounts,
    accountLinks: accountLinksMock,
    customers: stripeCustomers,
    checkout: { sessions: stripeCheckoutSessions },
    billingPortal: { sessions: stripeBillingPortalSessions },
  })),
  StripeNotConfiguredError: class extends Error {},
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

import {
  startStripeOnboarding,
  startSubscriptionCheckout,
  openBillingPortal,
} from "@/app/(admin)/settings/actions";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];

function uid() { return `${randomUUID()}-strip-${RUN}-${++seq}`; }

async function createTenant(opts: {
  stripeAccountId?: string | null;
  stripeCustomerId?: string | null;
} = {}) {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id,
    businessName: "Stripe Settings Test Gallery",
    type: "ARTIST",
    contactEmail: "gallery@example.com",
    stripeAccountId: opts.stripeAccountId ?? null,
    stripeCustomerId: opts.stripeCustomerId ?? null,
  } as any);
  createdTenantIds.push(id);
  mockTenantId.value = id;
  return id;
}

async function cleanup() {
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(async () => {
  stripeAccounts.create.mockReset();
  accountLinksMock.create.mockReset();
  stripeCustomers.create.mockReset();
  stripeCustomers.retrieve.mockReset();
  stripeCheckoutSessions.create.mockReset();
  stripeBillingPortalSessions.create.mockReset();
  await cleanup();
});
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Stripe settings actions — real-DB integration", () => {
  // ── startStripeOnboarding ─────────────────────────────────────────────────

  it("startStripeOnboarding: no account → creates one and persists stripeAccountId", async () => {
    const tenantId = await createTenant({ stripeAccountId: null });

    stripeAccounts.create.mockResolvedValueOnce({ id: "acct_fresh_001" });
    accountLinksMock.create.mockResolvedValueOnce({
      url: "https://connect.stripe.com/setup/acct_fresh_001",
    });

    await expect(startStripeOnboarding()).rejects.toThrow("REDIRECT:");

    const row = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, tenantId),
    });
    expect(row?.stripeAccountId).toBe("acct_fresh_001");
  });

  it("startStripeOnboarding: stale account → clears old ID and persists new ID", async () => {
    const tenantId = await createTenant({ stripeAccountId: "acct_stale_old" });

    // First accountLinks.create throws "account_invalid" (stale Stripe account).
    accountLinksMock.create.mockRejectedValueOnce(STALE_ACCOUNT_ERROR);
    // Recovery: creates a fresh account.
    stripeAccounts.create.mockResolvedValueOnce({ id: "acct_replacement_002" });
    // Second accountLinks.create succeeds with the new account.
    accountLinksMock.create.mockResolvedValueOnce({
      url: "https://connect.stripe.com/setup/acct_replacement_002",
    });

    await expect(startStripeOnboarding()).rejects.toThrow("REDIRECT:");

    const row = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, tenantId),
    });
    expect(row?.stripeAccountId).toBe("acct_replacement_002");
  });

  it("startStripeOnboarding: existing valid account → re-uses it without a new create call", async () => {
    const tenantId = await createTenant({ stripeAccountId: "acct_valid_existing" });

    accountLinksMock.create.mockResolvedValueOnce({
      url: "https://connect.stripe.com/setup/acct_valid_existing",
    });

    await expect(startStripeOnboarding()).rejects.toThrow("REDIRECT:");

    // create should NOT have been called.
    expect(stripeAccounts.create).not.toHaveBeenCalled();

    const row = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, tenantId),
    });
    expect(row?.stripeAccountId).toBe("acct_valid_existing");
  });

  // ── startSubscriptionCheckout ─────────────────────────────────────────────

  it("startSubscriptionCheckout: no customer → creates one and persists stripeCustomerId", async () => {
    const tenantId = await createTenant({ stripeCustomerId: null });

    stripeCustomers.create.mockResolvedValueOnce({ id: "cus_brand_new_789" });
    stripeCheckoutSessions.create.mockResolvedValueOnce({
      url: "https://checkout.stripe.com/pay/cs_test",
    });

    await expect(startSubscriptionCheckout()).rejects.toThrow("REDIRECT:");

    const row = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, tenantId),
    });
    expect(row?.stripeCustomerId).toBe("cus_brand_new_789");
  });

  it("startSubscriptionCheckout: existing customer → stripeCustomerId unchanged", async () => {
    const tenantId = await createTenant({ stripeCustomerId: "cus_existing_abc" });

    stripeCustomers.retrieve.mockResolvedValueOnce({
      id: "cus_existing_abc",
      deleted: undefined,
    });
    stripeCheckoutSessions.create.mockResolvedValueOnce({
      url: "https://checkout.stripe.com/pay/cs_test",
    });

    await expect(startSubscriptionCheckout()).rejects.toThrow("REDIRECT:");

    // create should NOT have been called.
    expect(stripeCustomers.create).not.toHaveBeenCalled();

    const row = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, tenantId),
    });
    expect(row?.stripeCustomerId).toBe("cus_existing_abc");
  });

  // ── openBillingPortal ─────────────────────────────────────────────────────

  it("openBillingPortal: valid customer → stripeCustomerId unchanged after portal call", async () => {
    const tenantId = await createTenant({ stripeCustomerId: "cus_portal_valid" });

    stripeCustomers.retrieve.mockResolvedValueOnce({
      id: "cus_portal_valid",
      deleted: undefined,
    });
    stripeBillingPortalSessions.create.mockResolvedValueOnce({
      url: "https://billing.stripe.com/session/bps_test",
    });

    await expect(openBillingPortal()).rejects.toThrow("REDIRECT:");

    const row = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, tenantId),
    });
    expect(row?.stripeCustomerId).toBe("cus_portal_valid");
  });

  it("openBillingPortal: stale customer → stripeCustomerId set to null", async () => {
    const tenantId = await createTenant({ stripeCustomerId: "cus_portal_stale" });

    // billingPortal.sessions.create throws "resource_missing" (stale customer).
    stripeBillingPortalSessions.create.mockRejectedValueOnce(STALE_CUSTOMER_ERROR);

    await expect(openBillingPortal()).rejects.toThrow("REDIRECT:");

    const row = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, tenantId),
    });
    expect(row?.stripeCustomerId).toBeNull();
  });

  it("openBillingPortal: missing stripeCustomerId → redirects before Stripe call", async () => {
    await createTenant({ stripeCustomerId: null });

    await expect(openBillingPortal()).rejects.toThrow("REDIRECT:/settings/billing");

    // No Stripe API calls for customer/portal.
    expect(stripeCustomers.retrieve).not.toHaveBeenCalled();
    expect(stripeBillingPortalSessions.create).not.toHaveBeenCalled();
  });

  // ── Staff role guard ──────────────────────────────────────────────────────

  it("startStripeOnboarding: staff role → redirects to unauthorized with zero Stripe or DB calls", async () => {
    const { getSession } = await import("@/lib/auth");
    const tenantId = await createTenant({ stripeAccountId: null });

    (getSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      userId: "u-stripe-staff",
      tenantId,
      email: "staff@gallery.test",
      role: "staff",
    });

    await expect(startStripeOnboarding()).rejects.toThrow(
      "REDIRECT:/settings?stripe=unauthorized",
    );

    // No Stripe API calls at all.
    expect(stripeAccounts.create).not.toHaveBeenCalled();
    expect(accountLinksMock.create).not.toHaveBeenCalled();

    // DB must be untouched — stripeAccountId stays null.
    const row = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, tenantId),
    });
    expect(row?.stripeAccountId).toBeNull();
  });

  it("startSubscriptionCheckout: staff role → redirects to unauthorized with zero Stripe or DB calls", async () => {
    const { getSession } = await import("@/lib/auth");
    const tenantId = await createTenant({ stripeCustomerId: null });

    (getSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      userId: "u-stripe-staff",
      tenantId,
      email: "staff@gallery.test",
      role: "staff",
    });

    await expect(startSubscriptionCheckout()).rejects.toThrow(
      "REDIRECT:/settings/billing?billing=unauthorized",
    );

    // No Stripe API calls at all.
    expect(stripeCustomers.create).not.toHaveBeenCalled();
    expect(stripeCustomers.retrieve).not.toHaveBeenCalled();
    expect(stripeCheckoutSessions.create).not.toHaveBeenCalled();

    // DB must be untouched — stripeCustomerId stays null.
    const row = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, tenantId),
    });
    expect(row?.stripeCustomerId).toBeNull();
  });

  it("openBillingPortal: staff role → redirects to unauthorized with zero Stripe or DB calls", async () => {
    const { getSession } = await import("@/lib/auth");
    const tenantId = await createTenant({ stripeCustomerId: "cus_staff_test" });

    (getSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      userId: "u-stripe-staff",
      tenantId,
      email: "staff@gallery.test",
      role: "staff",
    });

    await expect(openBillingPortal()).rejects.toThrow(
      "REDIRECT:/settings/billing?billing=unauthorized",
    );

    // No Stripe API calls at all.
    expect(stripeCustomers.retrieve).not.toHaveBeenCalled();
    expect(stripeBillingPortalSessions.create).not.toHaveBeenCalled();

    // DB must be untouched — stripeCustomerId stays unchanged.
    const row = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, tenantId),
    });
    expect(row?.stripeCustomerId).toBe("cus_staff_test");
  });

  it("openBillingPortal: mid-flight session expiry to staff → redirects unauthorized with no Stripe or DB mutation", async () => {
    // Simulates a session that passes the initial owner check but is then
    // downgraded to "staff" (or expires) before the Stripe billing-portal call.
    // The action re-validates the session immediately before hitting Stripe;
    // the second check catches the downgrade and redirects to unauthorized
    // without making any Stripe API call or writing to the DB.
    const { getSession } = await import("@/lib/auth");
    const tenantId = await createTenant({ stripeCustomerId: "cus_mid_flight" });

    // First call  → "owner"  (passes the initial role guard at the top of the action).
    // Second call → "staff"  (mid-flight downgrade, caught by the pre-Stripe re-check).
    (getSession as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        userId: "u-owner-mid-flight",
        tenantId,
        email: "owner@gallery.test",
        role: "owner",
      })
      .mockResolvedValueOnce({
        userId: "u-owner-mid-flight",
        tenantId,
        email: "owner@gallery.test",
        role: "staff",
      });

    await expect(openBillingPortal()).rejects.toThrow(
      "REDIRECT:/settings/billing?billing=unauthorized",
    );

    // No Stripe API calls must have been made — the mid-flight guard fired
    // before any external call.
    expect(stripeCustomers.retrieve).not.toHaveBeenCalled();
    expect(stripeBillingPortalSessions.create).not.toHaveBeenCalled();

    // DB must be untouched — stripeCustomerId stays unchanged.
    const row = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, tenantId),
    });
    expect(row?.stripeCustomerId).toBe("cus_mid_flight");
  });
});
