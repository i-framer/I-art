// @vitest-environment happy-dom
/**
 * Confirms the subscription status badge on the admin billing page renders
 * the correct label and Tailwind colour classes for "trialing" and "active".
 *
 * Renders the real SubscriptionStatusBadge component extracted from
 * app/(admin)/settings/billing/page.tsx so that any future change to that
 * component's JSX — swapping badge.cls, removing the span, renaming labels —
 * is caught immediately rather than passing silently.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";
import { SubscriptionStatusBadge } from "@/app/(admin)/settings/billing/_components/subscription-status-badge";

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// trialing
// ---------------------------------------------------------------------------

describe("billing page badge – trialing", () => {
  it('renders "Trialing" label when subscriptionStatus is "trialing"', () => {
    render(
      <SubscriptionStatusBadge
        subscriptionStatus="trialing"
        billingExempt={false}
      />,
    );
    expect(screen.getByText("Trialing")).toBeTruthy();
  });

  it("trialing badge carries the blue colour classes (bg-blue-100 text-blue-700)", () => {
    render(
      <SubscriptionStatusBadge
        subscriptionStatus="trialing"
        billingExempt={false}
      />,
    );
    const badge = screen.getByText("Trialing");
    expect(badge.className).toContain("bg-blue-100");
    expect(badge.className).toContain("text-blue-700");
  });

  it("does NOT apply green active classes to the trialing badge", () => {
    render(
      <SubscriptionStatusBadge
        subscriptionStatus="trialing"
        billingExempt={false}
      />,
    );
    const badge = screen.getByText("Trialing");
    expect(badge.className).not.toContain("bg-emerald-100");
    expect(badge.className).not.toContain("text-emerald-700");
  });
});

// ---------------------------------------------------------------------------
// active
// ---------------------------------------------------------------------------

describe("billing page badge – active", () => {
  it('renders "Active" label when subscriptionStatus is "active"', () => {
    render(
      <SubscriptionStatusBadge
        subscriptionStatus="active"
        billingExempt={false}
      />,
    );
    expect(screen.getByText("Active")).toBeTruthy();
  });

  it("active badge carries the green colour classes (bg-emerald-100 text-emerald-700)", () => {
    render(
      <SubscriptionStatusBadge
        subscriptionStatus="active"
        billingExempt={false}
      />,
    );
    const badge = screen.getByText("Active");
    expect(badge.className).toContain("bg-emerald-100");
    expect(badge.className).toContain("text-emerald-700");
  });

  it("does NOT apply blue trialing classes to the active badge", () => {
    render(
      <SubscriptionStatusBadge
        subscriptionStatus="active"
        billingExempt={false}
      />,
    );
    const badge = screen.getByText("Active");
    expect(badge.className).not.toContain("bg-blue-100");
    expect(badge.className).not.toContain("text-blue-700");
  });
});

// ---------------------------------------------------------------------------
// label distinctness
// ---------------------------------------------------------------------------

describe("billing page badge – trialing and active are visually different", () => {
  it("trialing and active labels are different strings", () => {
    const { rerender } = render(
      <SubscriptionStatusBadge
        subscriptionStatus="trialing"
        billingExempt={false}
      />,
    );
    const trialingText = screen.getByText("Trialing").textContent;

    rerender(
      <SubscriptionStatusBadge
        subscriptionStatus="active"
        billingExempt={false}
      />,
    );
    const activeText = screen.getByText("Active").textContent;

    expect(trialingText).not.toBe(activeText);
  });
});

// ---------------------------------------------------------------------------
// no status
// ---------------------------------------------------------------------------

describe("billing page badge – no status", () => {
  it('renders "Not subscribed" when subscriptionStatus is null', () => {
    render(
      <SubscriptionStatusBadge
        subscriptionStatus={null}
        billingExempt={false}
      />,
    );
    expect(screen.getByText("Not subscribed")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// trial countdown
// ---------------------------------------------------------------------------

describe("billing page badge – trial countdown", () => {
  it("renders trial countdown text when status is trialing and trialEnd is set", () => {
    const trialEnd = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000); // 5 days
    render(
      <SubscriptionStatusBadge
        subscriptionStatus="trialing"
        billingExempt={false}
        trialEnd={trialEnd}
      />,
    );
    expect(
      screen.getByText(/days? remaining in your trial/),
    ).toBeTruthy();
  });

  it("does NOT render a countdown for an active subscription", () => {
    render(
      <SubscriptionStatusBadge
        subscriptionStatus="active"
        billingExempt={false}
      />,
    );
    expect(
      screen.queryByText(/days? remaining|ends today/),
    ).toBeNull();
  });
});
