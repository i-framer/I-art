// @vitest-environment happy-dom
/**
 * Confirms the "Checkout status (cached)" panel on the settings page renders
 * the correct label for each combination of stripeChargesEnabled /
 * stripePayoutsEnabled values received from the database after an
 * account.updated webhook updates the tenant row.
 *
 * Renders the real StripeReadinessPanel component so any JSX change that
 * accidentally alters the "Yes" / "No" / "Not yet received" strings is caught
 * immediately rather than passing silently.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";
import { StripeReadinessPanel } from "@/app/(admin)/settings/_components/stripe-readiness-panel";

afterEach(() => {
  cleanup();
});

// ── both enabled (true / true) ────────────────────────────────────────────────

describe("StripeReadinessPanel — both enabled", () => {
  it('renders "Yes" for charges when stripeChargesEnabled is true', () => {
    render(
      <StripeReadinessPanel
        stripeChargesEnabled={true}
        stripePayoutsEnabled={true}
      />,
    );
    // There should be at least one "Yes" in the document.
    const yesNodes = screen.getAllByText("Yes");
    expect(yesNodes.length).toBeGreaterThanOrEqual(1);
  });

  it('renders "Yes" for payouts when stripePayoutsEnabled is true', () => {
    render(
      <StripeReadinessPanel
        stripeChargesEnabled={true}
        stripePayoutsEnabled={true}
      />,
    );
    const yesNodes = screen.getAllByText("Yes");
    // Both charges and payouts are "Yes", so we expect exactly two.
    expect(yesNodes.length).toBe(2);
  });

  it('does NOT render "No" when both are true', () => {
    render(
      <StripeReadinessPanel
        stripeChargesEnabled={true}
        stripePayoutsEnabled={true}
      />,
    );
    expect(screen.queryByText("No")).toBeNull();
  });

  it('does NOT render "Not yet received" when both are true', () => {
    render(
      <StripeReadinessPanel
        stripeChargesEnabled={true}
        stripePayoutsEnabled={true}
      />,
    );
    expect(screen.queryByText("Not yet received")).toBeNull();
  });
});

// ── both disabled (false / false) ─────────────────────────────────────────────

describe("StripeReadinessPanel — both disabled", () => {
  it('renders "No" for charges when stripeChargesEnabled is false', () => {
    render(
      <StripeReadinessPanel
        stripeChargesEnabled={false}
        stripePayoutsEnabled={false}
      />,
    );
    const noNodes = screen.getAllByText("No");
    expect(noNodes.length).toBeGreaterThanOrEqual(1);
  });

  it('renders "No" for payouts when stripePayoutsEnabled is false', () => {
    render(
      <StripeReadinessPanel
        stripeChargesEnabled={false}
        stripePayoutsEnabled={false}
      />,
    );
    const noNodes = screen.getAllByText("No");
    // Both charges and payouts are "No", so we expect exactly two.
    expect(noNodes.length).toBe(2);
  });

  it('does NOT render "Yes" when both are false', () => {
    render(
      <StripeReadinessPanel
        stripeChargesEnabled={false}
        stripePayoutsEnabled={false}
      />,
    );
    expect(screen.queryByText("Yes")).toBeNull();
  });

  it('does NOT render "Not yet received" when both are false', () => {
    render(
      <StripeReadinessPanel
        stripeChargesEnabled={false}
        stripePayoutsEnabled={false}
      />,
    );
    expect(screen.queryByText("Not yet received")).toBeNull();
  });
});

// ── both null (no webhook received yet) ───────────────────────────────────────

describe("StripeReadinessPanel — both null (no webhook yet)", () => {
  it('renders "Not yet received" for charges when stripeChargesEnabled is null', () => {
    render(
      <StripeReadinessPanel
        stripeChargesEnabled={null}
        stripePayoutsEnabled={null}
      />,
    );
    const notYet = screen.getAllByText("Not yet received");
    expect(notYet.length).toBeGreaterThanOrEqual(1);
  });

  it('renders "Not yet received" for payouts when stripePayoutsEnabled is null', () => {
    render(
      <StripeReadinessPanel
        stripeChargesEnabled={null}
        stripePayoutsEnabled={null}
      />,
    );
    const notYet = screen.getAllByText("Not yet received");
    // Both charges and payouts are null, so we expect exactly two.
    expect(notYet.length).toBe(2);
  });

  it('does NOT render "Yes" when both are null', () => {
    render(
      <StripeReadinessPanel
        stripeChargesEnabled={null}
        stripePayoutsEnabled={null}
      />,
    );
    expect(screen.queryByText("Yes")).toBeNull();
  });

  it('does NOT render "No" when both are null', () => {
    render(
      <StripeReadinessPanel
        stripeChargesEnabled={null}
        stripePayoutsEnabled={null}
      />,
    );
    expect(screen.queryByText("No")).toBeNull();
  });
});

// ── mixed: charges true, payouts false ────────────────────────────────────────

describe("StripeReadinessPanel — mixed values", () => {
  it('renders "Yes" for charges and "No" for payouts when values differ', () => {
    render(
      <StripeReadinessPanel
        stripeChargesEnabled={true}
        stripePayoutsEnabled={false}
      />,
    );
    expect(screen.getByText("Yes")).toBeTruthy();
    expect(screen.getByText("No")).toBeTruthy();
  });

  it('renders "Yes" for charges and "Not yet received" for payouts when payouts is null', () => {
    render(
      <StripeReadinessPanel
        stripeChargesEnabled={true}
        stripePayoutsEnabled={null}
      />,
    );
    expect(screen.getByText("Yes")).toBeTruthy();
    expect(screen.getByText("Not yet received")).toBeTruthy();
  });
});
