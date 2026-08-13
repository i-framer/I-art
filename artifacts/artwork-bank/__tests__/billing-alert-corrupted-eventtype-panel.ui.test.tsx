// @vitest-environment happy-dom
/**
 * UI-level confirmation that a stripeAlertsTable row with a corrupted
 * (null or unrecognised) eventType and a non-null slackPostFailed:
 *
 *  1. Is NOT filtered out — it appears in the BillingAlerts panel.
 *  2. Carries the "Slack missed" badge so the operator can investigate.
 *
 * The page-level DB query filters only on `dismissedAt IS NULL`; corrupted
 * eventType values do NOT cause the row to be suppressed.  This test pins
 * that contract at the UI-rendering layer so a future change to the
 * component's filtering logic is caught immediately.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";

// ── Mock server actions imported by BillingAlerts ─────────────────────────────
vi.mock("@/app/platform/actions", () => ({
  dismissBillingAlert: vi.fn(async () => {}),
  replayFailedSlackAlerts: vi.fn(async () => ({
    replayed: 0,
    failed: 0,
    skipped: 0,
  })),
}));

import { BillingAlerts } from "@/app/platform/_components/BillingAlerts";
import type { StripeAlert } from "@workspace/db";

afterEach(() => {
  cleanup();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAlert(overrides: Partial<StripeAlert> = {}): StripeAlert {
  return {
    id: "alert-test-001",
    stripeEventId: "evt_test_001",
    eventType: "customer.subscription.updated",
    customerId: "cus_test_001",
    subscriptionId: null,
    reason: "No tenant matched",
    dismissedAt: null,
    slackPostFailed: null,
    createdAt: new Date("2025-01-01T00:00:00Z"),
    ...overrides,
  };
}

// ── null eventType ─────────────────────────────────────────────────────────────

describe("BillingAlerts panel — null eventType with slackPostFailed", () => {
  it("renders the alert row (not filtered out)", () => {
    const alert = makeAlert({
      eventType: null as unknown as string, // corruption: DB schema says notNull but data can be corrupted
      slackPostFailed: new Date(Date.now() - 60_000),
    });

    render(<BillingAlerts alerts={[alert]} />);

    // The row should be present — check for the Stripe event ID link text
    expect(screen.getByText("evt_test_001")).toBeTruthy();
  });

  it('renders the "Slack missed" badge', () => {
    const alert = makeAlert({
      eventType: null as unknown as string,
      slackPostFailed: new Date(Date.now() - 60_000),
    });

    render(<BillingAlerts alerts={[alert]} />);

    expect(screen.getByText("Slack missed")).toBeTruthy();
  });

  it('"Slack missed" badge carries the red colour classes', () => {
    const alert = makeAlert({
      eventType: null as unknown as string,
      slackPostFailed: new Date(Date.now() - 60_000),
    });

    render(<BillingAlerts alerts={[alert]} />);

    const badge = screen.getByText("Slack missed");
    expect(badge.className).toContain("bg-red-100");
    expect(badge.className).toContain("text-red-700");
  });

  it("does NOT render the Slack missed badge when slackPostFailed is null", () => {
    const alert = makeAlert({
      eventType: null as unknown as string,
      slackPostFailed: null,
    });

    render(<BillingAlerts alerts={[alert]} />);

    expect(screen.queryByText("Slack missed")).toBeNull();
  });
});

// ── Unrecognised eventType ─────────────────────────────────────────────────────

describe("BillingAlerts panel — unrecognised eventType with slackPostFailed", () => {
  it("renders the alert row (not filtered out)", () => {
    const alert = makeAlert({
      eventType: "bogus.unrecognised.event.type",
      slackPostFailed: new Date(Date.now() - 60_000),
    });

    render(<BillingAlerts alerts={[alert]} />);

    expect(screen.getByText("evt_test_001")).toBeTruthy();
  });

  it('renders the "Slack missed" badge', () => {
    const alert = makeAlert({
      eventType: "bogus.unrecognised.event.type",
      slackPostFailed: new Date(Date.now() - 60_000),
    });

    render(<BillingAlerts alerts={[alert]} />);

    expect(screen.getByText("Slack missed")).toBeTruthy();
  });

  it('"Slack missed" badge carries the red colour classes', () => {
    const alert = makeAlert({
      eventType: "bogus.unrecognised.event.type",
      slackPostFailed: new Date(Date.now() - 60_000),
    });

    render(<BillingAlerts alerts={[alert]} />);

    const badge = screen.getByText("Slack missed");
    expect(badge.className).toContain("bg-red-100");
    expect(badge.className).toContain("text-red-700");
  });

  it("renders the corrupted eventType value in the row", () => {
    const alert = makeAlert({
      eventType: "bogus.unrecognised.event.type",
      slackPostFailed: new Date(Date.now() - 60_000),
    });

    render(<BillingAlerts alerts={[alert]} />);

    expect(screen.getByText("bogus.unrecognised.event.type")).toBeTruthy();
  });
});

// ── Panel-level Slack replay button ───────────────────────────────────────────

describe("BillingAlerts panel — replay button appears for corrupted-eventType failures", () => {
  it("shows the Slack replay button when at least one corrupted row has slackPostFailed set", () => {
    const alert = makeAlert({
      eventType: null as unknown as string,
      slackPostFailed: new Date(Date.now() - 60_000),
    });

    render(<BillingAlerts alerts={[alert]} />);

    // The "Replay N Slack failure(s)" button must be present
    expect(screen.getByText(/Replay \d+ Slack failure/)).toBeTruthy();
  });

  it("does NOT show the replay button when no rows have slackPostFailed set", () => {
    const alert = makeAlert({
      eventType: null as unknown as string,
      slackPostFailed: null,
    });

    render(<BillingAlerts alerts={[alert]} />);

    expect(screen.queryByText(/Replay \d+ Slack failure/)).toBeNull();
  });
});
