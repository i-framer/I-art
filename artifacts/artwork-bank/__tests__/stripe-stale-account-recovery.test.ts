/**
 * Regression tests: Stripe actions must never crash the page with an
 * unhandled server exception.
 *
 * - startStripeOnboarding: a stale saved stripeAccountId ("No such account",
 *   e.g. after a live/test mode switch) is transparently cleared, a fresh
 *   account is created, and onboarding continues. Other Stripe errors land
 *   the user back on Settings with a descriptive banner state.
 * - startSubscriptionCheckout: same stale-ID recovery for stripeCustomerId.
 * - openBillingPortal: a stale customer ID is cleared and the user is sent
 *   back to the billing page with a friendly state.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Hoisted state ────────────────────────────────────────────────────────────
const state = vi.hoisted(() => ({
  updates: [] as { table: any; vals: any; where: any }[],
  stripeAccountsCreate: vi.fn(),
  stripeAccountLinksCreate: vi.fn(),
  stripeCustomersCreate: vi.fn(),
  stripeCheckoutCreate: vi.fn(),
  stripePortalCreate: vi.fn(),
}));

const tenantFindFirst = vi.hoisted(() => vi.fn());

// ── Mocks ────────────────────────────────────────────────────────────────────
vi.mock("@workspace/db", () => ({
  db: {
    query: {
      tenantsTable: { findFirst: (opts: any) => tenantFindFirst(opts) },
    },
    insert: vi.fn(() => ({ values: () => Promise.resolve() })),
    update: vi.fn((table: any) => ({
      set: (vals: any) => ({
        where: (where: any) => {
          state.updates.push({ table, vals, where });
          return Promise.resolve();
        },
      }),
    })),
  },
  tenantsTable: { id: "tenants.id" },
  staffInvitesTable: {},
  tenantUsersTable: {},
}));

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({
    userId: "user-1",
    tenantId: "tenant-A",
    role: "owner",
  })),
  generateToken: () => "tok-123",
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(async () => ({
    accounts: { create: state.stripeAccountsCreate },
    accountLinks: { create: state.stripeAccountLinksCreate },
    customers: { create: state.stripeCustomersCreate },
    checkout: { sessions: { create: state.stripeCheckoutCreate } },
    billingPortal: { sessions: { create: state.stripePortalCreate } },
  })),
}));

vi.mock("@/lib/billing", () => ({
  getSubscriptionPriceId: vi.fn(async () => "price_123"),
}));

/** Mimics Stripe's "resource missing" invalid-request error. */
function noSuchError(message: string) {
  const err = new Error(message) as Error & { code: string };
  err.code = "resource_missing";
  return err;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.updates.length = 0;

  state.stripeAccountsCreate.mockResolvedValue({ id: "acct_fresh" });
  state.stripeAccountLinksCreate.mockResolvedValue({
    url: "https://connect.stripe.com/setup/e/xyz",
  });
  state.stripeCustomersCreate.mockResolvedValue({ id: "cus_fresh" });
  state.stripeCheckoutCreate.mockResolvedValue({
    url: "https://checkout.stripe.com/c/pay/cs_123",
  });
  state.stripePortalCreate.mockResolvedValue({
    url: "https://billing.stripe.com/p/session/xyz",
  });
});

import {
  startStripeOnboarding,
  startSubscriptionCheckout,
  openBillingPortal,
} from "@/app/(admin)/settings/actions";

// ── Onboarding: stale account recovery ──────────────────────────────────────

describe("startStripeOnboarding — stale account recovery", () => {
  it("clears a stale account ID, creates a fresh account, and continues onboarding", async () => {
    tenantFindFirst.mockResolvedValue({
      id: "tenant-A",
      stripeAccountId: "acct_stale",
    });
    state.stripeAccountLinksCreate
      .mockRejectedValueOnce(noSuchError("No such account: 'acct_stale'"))
      .mockResolvedValueOnce({ url: "https://connect.stripe.com/setup/e/new" });

    const err = await startStripeOnboarding().catch((e: Error) => e);
    expect((err as Error).message).toBe(
      "REDIRECT:https://connect.stripe.com/setup/e/new",
    );

    // Stale ID cleared, then fresh ID saved
    expect(state.updates.map((u) => u.vals)).toEqual([
      { stripeAccountId: null },
      { stripeAccountId: "acct_fresh" },
    ]);
    // Second link attempt used the fresh account
    expect(state.stripeAccountLinksCreate.mock.calls[1][0].account).toBe(
      "acct_fresh",
    );
  });

  it("redirects to settings with connect_not_enabled when Connect is not enabled", async () => {
    tenantFindFirst.mockResolvedValue({ id: "tenant-A", stripeAccountId: null });
    state.stripeAccountsCreate.mockRejectedValue(
      new Error(
        "You can only create new accounts if you've signed up for Connect.",
      ),
    );

    const err = await startStripeOnboarding().catch((e: Error) => e);
    expect((err as Error).message).toBe(
      "REDIRECT:/settings?stripe=connect_not_enabled",
    );
  });

  it("redirects to settings with a generic rejected state on other Stripe errors", async () => {
    tenantFindFirst.mockResolvedValue({
      id: "tenant-A",
      stripeAccountId: "acct_ok",
    });
    state.stripeAccountLinksCreate.mockRejectedValue(
      new Error("Rate limit exceeded"),
    );

    const err = await startStripeOnboarding().catch((e: Error) => e);
    expect((err as Error).message).toBe("REDIRECT:/settings?stripe=rejected");
    // The saved ID was NOT cleared for a non-stale error
    expect(state.updates).toHaveLength(0);
  });

  it("does not retry endlessly if the fresh account's link also fails", async () => {
    tenantFindFirst.mockResolvedValue({
      id: "tenant-A",
      stripeAccountId: "acct_stale",
    });
    state.stripeAccountLinksCreate.mockRejectedValue(
      noSuchError("No such account: 'acct_stale'"),
    );

    const err = await startStripeOnboarding().catch((e: Error) => e);
    expect((err as Error).message).toBe("REDIRECT:/settings?stripe=rejected");
    expect(state.stripeAccountLinksCreate).toHaveBeenCalledTimes(2);
  });
});

// ── Subscription checkout: stale customer recovery ──────────────────────────

describe("startSubscriptionCheckout — stale customer recovery", () => {
  it("clears a stale customer ID, creates a fresh customer, and continues checkout", async () => {
    tenantFindFirst.mockResolvedValue({
      id: "tenant-A",
      businessName: "Gallery A",
      contactEmail: "a@example.com",
      stripeCustomerId: "cus_stale",
    });
    state.stripeCheckoutCreate
      .mockRejectedValueOnce(noSuchError("No such customer: 'cus_stale'"))
      .mockResolvedValueOnce({ url: "https://checkout.stripe.com/c/pay/cs_new" });

    const err = await startSubscriptionCheckout().catch((e: Error) => e);
    expect((err as Error).message).toBe(
      "REDIRECT:https://checkout.stripe.com/c/pay/cs_new",
    );

    expect(state.updates.map((u) => u.vals)).toEqual([
      { stripeCustomerId: null },
      { stripeCustomerId: "cus_fresh" },
    ]);
    expect(state.stripeCheckoutCreate.mock.calls[1][0].customer).toBe(
      "cus_fresh",
    );
  });

  it("redirects to billing with stripe_error on other Stripe failures", async () => {
    tenantFindFirst.mockResolvedValue({
      id: "tenant-A",
      businessName: "Gallery A",
      contactEmail: null,
      stripeCustomerId: "cus_ok",
    });
    state.stripeCheckoutCreate.mockRejectedValue(new Error("API error"));

    const err = await startSubscriptionCheckout().catch((e: Error) => e);
    expect((err as Error).message).toBe(
      "REDIRECT:/settings/billing?billing=stripe_error",
    );
    expect(state.updates).toHaveLength(0);
  });
});

// ── Billing portal: stale customer handling ─────────────────────────────────

describe("openBillingPortal — stale customer handling", () => {
  it("clears a stale customer ID and redirects with customer_reset", async () => {
    tenantFindFirst.mockResolvedValue({
      id: "tenant-A",
      stripeCustomerId: "cus_stale",
    });
    state.stripePortalCreate.mockRejectedValue(
      noSuchError("No such customer: 'cus_stale'"),
    );

    const err = await openBillingPortal().catch((e: Error) => e);
    expect((err as Error).message).toBe(
      "REDIRECT:/settings/billing?billing=customer_reset",
    );
    expect(state.updates.map((u) => u.vals)).toEqual([
      { stripeCustomerId: null },
    ]);
  });

  it("redirects with stripe_error on other Stripe failures without clearing the ID", async () => {
    tenantFindFirst.mockResolvedValue({
      id: "tenant-A",
      stripeCustomerId: "cus_ok",
    });
    state.stripePortalCreate.mockRejectedValue(new Error("API down"));

    const err = await openBillingPortal().catch((e: Error) => e);
    expect((err as Error).message).toBe(
      "REDIRECT:/settings/billing?billing=stripe_error",
    );
    expect(state.updates).toHaveLength(0);
  });

  it("still opens the portal normally when the customer is valid", async () => {
    tenantFindFirst.mockResolvedValue({
      id: "tenant-A",
      stripeCustomerId: "cus_ok",
    });

    const err = await openBillingPortal().catch((e: Error) => e);
    expect((err as Error).message).toBe(
      "REDIRECT:https://billing.stripe.com/p/session/xyz",
    );
  });
});
