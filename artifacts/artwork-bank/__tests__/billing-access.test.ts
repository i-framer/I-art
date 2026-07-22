/**
 * Subscription access rules: which tenants can use the admin app.
 * `past_due` keeps access (grace period while Stripe retries the card);
 * `billingExempt` bypasses billing entirely (comped accounts / future
 * i-Framer premium bundle).
 */
import { describe, it, expect } from "vitest";
import { hasActiveAccess, SUBSCRIPTION_PRICE_CENTS } from "@/lib/billing";

describe("hasActiveAccess", () => {
  it("grants access for active and trialing subscriptions", () => {
    expect(hasActiveAccess({ billingExempt: false, subscriptionStatus: "active" })).toBe(true);
    expect(hasActiveAccess({ billingExempt: false, subscriptionStatus: "trialing" })).toBe(true);
  });

  it("keeps access during past_due (grace period)", () => {
    expect(hasActiveAccess({ billingExempt: false, subscriptionStatus: "past_due" })).toBe(true);
  });

  it("denies access when unsubscribed, canceled, or unpaid", () => {
    expect(hasActiveAccess({ billingExempt: false, subscriptionStatus: null })).toBe(false);
    expect(hasActiveAccess({ billingExempt: false, subscriptionStatus: "canceled" })).toBe(false);
    expect(hasActiveAccess({ billingExempt: false, subscriptionStatus: "unpaid" })).toBe(false);
    expect(hasActiveAccess({ billingExempt: false, subscriptionStatus: "incomplete" })).toBe(false);
  });

  it("billingExempt bypasses the paywall regardless of status", () => {
    expect(hasActiveAccess({ billingExempt: true, subscriptionStatus: null })).toBe(true);
    expect(hasActiveAccess({ billingExempt: true, subscriptionStatus: "canceled" })).toBe(true);
  });
});

describe("subscription price", () => {
  it("is $10/month in cents", () => {
    expect(SUBSCRIPTION_PRICE_CENTS).toBe(1000);
  });
});
