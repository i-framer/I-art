/**
 * Billing access — requireActiveBillingAccess and hasActiveAccess.
 *
 * Covers:
 *  - hasActiveAccess: billingExempt=true always passes (any subscriptionStatus)
 *  - hasActiveAccess: active, trialing, past_due statuses pass
 *  - hasActiveAccess: canceled, unpaid, null status fail
 *  - requireActiveBillingAccess: COMPED tenant (billingExempt=true) resolves
 *  - requireActiveBillingAccess: trialing tenant resolves
 *  - requireActiveBillingAccess: unsubscribed/canceled tenant throws
 *  - requireActiveBillingAccess: missing tenant throws
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── DB mock ────────────────────────────────────────────────────────────────────
const tenantRow = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      tenantsTable: {
        findFirst: vi.fn(async () => tenantRow.current),
      },
    },
  },
  tenantsTable: { id: "tenants.id" },
  eq: vi.fn(),
}));

// ── Stripe mock (billing.ts imports getStripeClient) ──────────────────────────
vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn().mockResolvedValue({}),
}));

import { hasActiveAccess, requireActiveBillingAccess } from "@/lib/billing";

beforeEach(() => {
  vi.clearAllMocks();
  tenantRow.current = null;
});

// ── hasActiveAccess (pure function) ───────────────────────────────────────────

describe("hasActiveAccess", () => {
  it("returns true when billingExempt is true regardless of subscriptionStatus", () => {
    expect(hasActiveAccess({ billingExempt: true, subscriptionStatus: null })).toBe(true);
    expect(hasActiveAccess({ billingExempt: true, subscriptionStatus: "canceled" })).toBe(true);
    expect(hasActiveAccess({ billingExempt: true, subscriptionStatus: "unpaid" })).toBe(true);
  });

  it("returns true for active subscriptionStatus", () => {
    expect(hasActiveAccess({ billingExempt: false, subscriptionStatus: "active" })).toBe(true);
  });

  it("returns true for trialing subscriptionStatus", () => {
    expect(hasActiveAccess({ billingExempt: false, subscriptionStatus: "trialing" })).toBe(true);
  });

  it("returns true for past_due subscriptionStatus (grace period)", () => {
    expect(hasActiveAccess({ billingExempt: false, subscriptionStatus: "past_due" })).toBe(true);
  });

  it("returns false for canceled subscriptionStatus", () => {
    expect(hasActiveAccess({ billingExempt: false, subscriptionStatus: "canceled" })).toBe(false);
  });

  it("returns false for unpaid subscriptionStatus", () => {
    expect(hasActiveAccess({ billingExempt: false, subscriptionStatus: "unpaid" })).toBe(false);
  });

  it("returns false for null subscriptionStatus (never subscribed)", () => {
    expect(hasActiveAccess({ billingExempt: false, subscriptionStatus: null })).toBe(false);
  });
});

// ── requireActiveBillingAccess (DB-backed guard) ───────────────────────────────

describe("requireActiveBillingAccess", () => {
  it("resolves for a COMPED tenant (billingExempt=true, no active subscription)", async () => {
    tenantRow.current = { billingExempt: true, subscriptionStatus: null };
    await expect(requireActiveBillingAccess("tenant-comped")).resolves.toBeUndefined();
  });

  it("resolves for a COMPED tenant even with a canceled subscription", async () => {
    tenantRow.current = { billingExempt: true, subscriptionStatus: "canceled" };
    await expect(requireActiveBillingAccess("tenant-comped")).resolves.toBeUndefined();
  });

  it("resolves for a trialing tenant", async () => {
    tenantRow.current = { billingExempt: false, subscriptionStatus: "trialing" };
    await expect(requireActiveBillingAccess("tenant-trial")).resolves.toBeUndefined();
  });

  it("resolves for an active-subscription tenant", async () => {
    tenantRow.current = { billingExempt: false, subscriptionStatus: "active" };
    await expect(requireActiveBillingAccess("tenant-active")).resolves.toBeUndefined();
  });

  it("resolves for a past_due tenant (grace period)", async () => {
    tenantRow.current = { billingExempt: false, subscriptionStatus: "past_due" };
    await expect(requireActiveBillingAccess("tenant-past-due")).resolves.toBeUndefined();
  });

  it("throws 'Subscription required' for a canceled tenant", async () => {
    tenantRow.current = { billingExempt: false, subscriptionStatus: "canceled" };
    await expect(requireActiveBillingAccess("tenant-canceled")).rejects.toThrow("Subscription required");
  });

  it("throws 'Subscription required' for an unpaid tenant", async () => {
    tenantRow.current = { billingExempt: false, subscriptionStatus: "unpaid" };
    await expect(requireActiveBillingAccess("tenant-unpaid")).rejects.toThrow("Subscription required");
  });

  it("throws 'Subscription required' when tenant has never subscribed (null status)", async () => {
    tenantRow.current = { billingExempt: false, subscriptionStatus: null };
    await expect(requireActiveBillingAccess("tenant-new")).rejects.toThrow("Subscription required");
  });

  it("throws 'Subscription required' when tenant is not found in DB", async () => {
    tenantRow.current = null; // not found
    await expect(requireActiveBillingAccess("ghost-tenant")).rejects.toThrow("Subscription required");
  });
});
