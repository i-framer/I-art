// @vitest-environment happy-dom
/**
 * Task #217 — i-Framer premium customer billing option.
 *
 * Context
 * ───────
 * When a gallery owner's i-Framer account is linked by a platform admin
 * (`setIframerAccount`), the tenant record gets `billingExempt=true` and
 * `iframerAccountId` set.  On their billing settings page they should see an
 * "i-Framer Premium" badge instead of the usual Stripe subscription status —
 * indicating their Artwork Bank access is included with their i-Framer
 * Premium plan at no extra cost.
 *
 * The `SubscriptionStatusBadge` component renders the badge based on both
 * props:
 *
 *   billingExempt=true  &&  iframerAccountId  →  "i-Framer Premium"
 *   billingExempt=true  &&  no iframerAccountId  →  "Complimentary"
 *   billingExempt=false  (any iframerAccountId)  →  normal Stripe badge
 *
 * The existing `billing-page-badge.ui.test.tsx` only passes `billingExempt={false}`
 * in every test case — the i-Framer Premium branch has no coverage.  This file
 * closes that gap.
 *
 * What this test verifies
 * ───────────────────────
 *  1. billingExempt=true + iframerAccountId → "i-Framer Premium" label.
 *  2. i-Framer Premium badge carries indigo colour classes.
 *  3. i-Framer Premium takes precedence over an active subscriptionStatus.
 *  4. i-Framer Premium takes precedence over a trialing subscriptionStatus.
 *  5. i-Framer Premium takes precedence over a past_due subscriptionStatus.
 *  6. i-Framer Premium takes precedence over null subscriptionStatus.
 *  7. billingExempt=true + null iframerAccountId → "Complimentary" (not Premium).
 *  8. billingExempt=true + undefined iframerAccountId → "Complimentary" (not Premium).
 *  9. billingExempt=false + iframerAccountId → NOT i-Framer Premium (both required).
 * 10. Complimentary badge carries violet colour classes (distinct from indigo).
 * 11. i-Framer Premium badge does NOT carry the blue trialing colour classes.
 * 12. i-Framer Premium badge does NOT carry the green active colour classes.
 * 13. i-Framer Premium and Complimentary labels are distinct strings.
 * 14. "Not subscribed" label is absent when billingExempt=true + iframerAccountId.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";
import { SubscriptionStatusBadge } from "@/app/(admin)/settings/billing/_components/subscription-status-badge";

afterEach(() => {
  cleanup();
});

// ── i-Framer Premium label ────────────────────────────────────────────────────

describe("billing badge — i-Framer Premium (Task #217)", () => {
  it('billingExempt=true + iframerAccountId → "i-Framer Premium" label', () => {
    render(
      <SubscriptionStatusBadge
        subscriptionStatus={null}
        billingExempt={true}
        iframerAccountId="ACC-123"
      />,
    );
    expect(screen.getByText("i-Framer Premium")).toBeTruthy();
  });

  it("i-Framer Premium badge carries bg-indigo-100 colour class", () => {
    render(
      <SubscriptionStatusBadge
        subscriptionStatus={null}
        billingExempt={true}
        iframerAccountId="ACC-123"
      />,
    );
    const badge = screen.getByText("i-Framer Premium");
    expect(badge.className).toContain("bg-indigo-100");
  });

  it("i-Framer Premium badge carries text-indigo-700 colour class", () => {
    render(
      <SubscriptionStatusBadge
        subscriptionStatus={null}
        billingExempt={true}
        iframerAccountId="ACC-123"
      />,
    );
    const badge = screen.getByText("i-Framer Premium");
    expect(badge.className).toContain("text-indigo-700");
  });

  it('i-Framer Premium takes precedence over subscriptionStatus="active"', () => {
    render(
      <SubscriptionStatusBadge
        subscriptionStatus="active"
        billingExempt={true}
        iframerAccountId="ACC-456"
      />,
    );
    expect(screen.getByText("i-Framer Premium")).toBeTruthy();
    expect(screen.queryByText("Active")).toBeNull();
  });

  it('i-Framer Premium takes precedence over subscriptionStatus="trialing"', () => {
    render(
      <SubscriptionStatusBadge
        subscriptionStatus="trialing"
        billingExempt={true}
        iframerAccountId="ACC-456"
        trialEnd={new Date(Date.now() + 5 * 24 * 60 * 60 * 1000)}
      />,
    );
    expect(screen.getByText("i-Framer Premium")).toBeTruthy();
    expect(screen.queryByText("Trialing")).toBeNull();
    // No trial countdown when i-Framer Premium is shown.
    expect(screen.queryByText(/days? remaining/)).toBeNull();
  });

  it('i-Framer Premium takes precedence over subscriptionStatus="past_due"', () => {
    render(
      <SubscriptionStatusBadge
        subscriptionStatus="past_due"
        billingExempt={true}
        iframerAccountId="ACC-789"
      />,
    );
    expect(screen.getByText("i-Framer Premium")).toBeTruthy();
  });

  it("i-Framer Premium takes precedence over null subscriptionStatus", () => {
    render(
      <SubscriptionStatusBadge
        subscriptionStatus={null}
        billingExempt={true}
        iframerAccountId="ACC-000"
      />,
    );
    expect(screen.getByText("i-Framer Premium")).toBeTruthy();
    expect(screen.queryByText("Not subscribed")).toBeNull();
  });

  it('billingExempt=true + null iframerAccountId → "Complimentary" (not Premium)', () => {
    render(
      <SubscriptionStatusBadge
        subscriptionStatus={null}
        billingExempt={true}
        iframerAccountId={null}
      />,
    );
    expect(screen.getByText("Complimentary")).toBeTruthy();
    expect(screen.queryByText("i-Framer Premium")).toBeNull();
  });

  it('billingExempt=true + undefined iframerAccountId → "Complimentary" (not Premium)', () => {
    render(
      <SubscriptionStatusBadge
        subscriptionStatus={null}
        billingExempt={true}
        // iframerAccountId omitted — undefined
      />,
    );
    expect(screen.getByText("Complimentary")).toBeTruthy();
    expect(screen.queryByText("i-Framer Premium")).toBeNull();
  });

  it("billingExempt=false + iframerAccountId → NOT i-Framer Premium (both required)", () => {
    render(
      <SubscriptionStatusBadge
        subscriptionStatus="active"
        billingExempt={false}
        iframerAccountId="ACC-999"
      />,
    );
    expect(screen.queryByText("i-Framer Premium")).toBeNull();
    // Should show the normal active badge instead.
    expect(screen.getByText("Active")).toBeTruthy();
  });

  // ── Complimentary badge ─────────────────────────────────────────────────────

  it("Complimentary badge carries bg-violet-100 (distinct from indigo i-Framer Premium)", () => {
    render(
      <SubscriptionStatusBadge
        subscriptionStatus={null}
        billingExempt={true}
        iframerAccountId={null}
      />,
    );
    const badge = screen.getByText("Complimentary");
    expect(badge.className).toContain("bg-violet-100");
    expect(badge.className).not.toContain("bg-indigo-100");
  });

  it("Complimentary badge carries text-violet-700", () => {
    render(
      <SubscriptionStatusBadge
        subscriptionStatus={null}
        billingExempt={true}
        iframerAccountId={null}
      />,
    );
    const badge = screen.getByText("Complimentary");
    expect(badge.className).toContain("text-violet-700");
    expect(badge.className).not.toContain("text-indigo-700");
  });

  // ── Negative colour assertions for i-Framer Premium ──────────────────────────

  it("i-Framer Premium badge does NOT carry blue trialing colour classes", () => {
    render(
      <SubscriptionStatusBadge
        subscriptionStatus="trialing"
        billingExempt={true}
        iframerAccountId="ACC-123"
      />,
    );
    const badge = screen.getByText("i-Framer Premium");
    expect(badge.className).not.toContain("bg-blue-100");
    expect(badge.className).not.toContain("text-blue-700");
  });

  it("i-Framer Premium badge does NOT carry green active colour classes", () => {
    render(
      <SubscriptionStatusBadge
        subscriptionStatus="active"
        billingExempt={true}
        iframerAccountId="ACC-123"
      />,
    );
    const badge = screen.getByText("i-Framer Premium");
    expect(badge.className).not.toContain("bg-emerald-100");
    expect(badge.className).not.toContain("text-emerald-700");
  });

  it("'i-Framer Premium' and 'Complimentary' are distinct label strings", () => {
    const { rerender } = render(
      <SubscriptionStatusBadge
        subscriptionStatus={null}
        billingExempt={true}
        iframerAccountId="ACC-123"
      />,
    );
    const premiumText = screen.getByText("i-Framer Premium").textContent;

    rerender(
      <SubscriptionStatusBadge
        subscriptionStatus={null}
        billingExempt={true}
        iframerAccountId={null}
      />,
    );
    const compText = screen.getByText("Complimentary").textContent;

    expect(premiumText).not.toBe(compText);
  });

  it('"Not subscribed" is absent when billingExempt=true + iframerAccountId', () => {
    render(
      <SubscriptionStatusBadge
        subscriptionStatus={null}
        billingExempt={true}
        iframerAccountId="ACC-123"
      />,
    );
    expect(screen.queryByText("Not subscribed")).toBeNull();
  });
});
