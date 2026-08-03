/**
 * Confirms the subscription status badge displayed on the admin billing page
 * correctly reflects "Trialing" for a trialing tenant, and is visually
 * distinct from the "Active" badge so gallery owners know they haven't been
 * charged yet.
 *
 * Also confirms the cancel / manage flow remains accessible during a trial
 * via `hasActiveAccess` — the same gate that renders the "Manage subscription"
 * button on the billing page.
 */
import { describe, it, expect } from "vitest";
import {
  getSubscriptionBadge,
  SUBSCRIPTION_STATUS_BADGES,
  hasActiveAccess,
} from "@/lib/billing";

describe("getSubscriptionBadge – trialing", () => {
  it('returns a badge with label "Trialing" for trialing status', () => {
    const badge = getSubscriptionBadge("trialing");
    expect(badge).not.toBeNull();
    expect(badge!.label).toBe("Trialing");
  });

  it("trialing badge is visually distinct from active badge", () => {
    const trialing = getSubscriptionBadge("trialing");
    const active = getSubscriptionBadge("active");
    expect(trialing).not.toBeNull();
    expect(active).not.toBeNull();
    // Different background colour classes — gallery owner can tell they differ
    expect(trialing!.cls).not.toBe(active!.cls);
    expect(trialing!.label).not.toBe(active!.label);
  });

  it("returns null for unknown / absent status (shows 'Not subscribed')", () => {
    expect(getSubscriptionBadge(null)).toBeNull();
    expect(getSubscriptionBadge(undefined)).toBeNull();
    expect(getSubscriptionBadge("")).toBeNull();
    expect(getSubscriptionBadge("unknown_status")).toBeNull();
  });
});

describe("getSubscriptionBadge – all defined statuses", () => {
  it("every status in SUBSCRIPTION_STATUS_BADGES has a non-empty label and cls", () => {
    for (const [status, badge] of Object.entries(SUBSCRIPTION_STATUS_BADGES)) {
      expect(badge.label, `label for "${status}"`).toBeTruthy();
      expect(badge.cls, `cls for "${status}"`).toBeTruthy();
    }
  });
});

describe("billing portal / cancel flow accessible from trialing", () => {
  it("hasActiveAccess returns true for trialing so Manage subscription button renders", () => {
    expect(
      hasActiveAccess({ billingExempt: false, subscriptionStatus: "trialing" }),
    ).toBe(true);
  });

  it("hasActiveAccess still works for exempt tenant regardless of status", () => {
    expect(
      hasActiveAccess({ billingExempt: true, subscriptionStatus: "trialing" }),
    ).toBe(true);
    expect(
      hasActiveAccess({ billingExempt: true, subscriptionStatus: null }),
    ).toBe(true);
  });
});
