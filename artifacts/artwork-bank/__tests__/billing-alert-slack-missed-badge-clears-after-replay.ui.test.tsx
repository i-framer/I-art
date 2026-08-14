// @vitest-environment happy-dom
/**
 * UI-level confirmation that the "Slack missed" badge is absent from the
 * BillingAlerts component once a row's slackPostFailed field is cleared to null.
 *
 * This pins the round-trip contract:
 *   seed with slackPostFailed set  → badge renders
 *   after successful replay (slackPostFailed = null) → badge is gone
 *
 * Companion tests:
 *   billing-alert-corrupted-eventtype-panel.ui.test.tsx
 *     — UI contract for corrupted eventType rows with slackPostFailed set
 *   platform-billing-alert-slack-replay-clears-flag-integration.test.ts
 *     — real-DB confirmation that replayFailedSlackAlerts clears the field
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
    id: "alert-replay-001",
    stripeEventId: "evt_replay_001",
    eventType: "customer.subscription.updated",
    customerId: "cus_replay_001",
    subscriptionId: null,
    reason: "No tenant matched",
    dismissedAt: null,
    slackPostFailed: null,
    createdAt: new Date("2025-06-01T00:00:00Z"),
    ...overrides,
  };
}

// ── Badge appearance ──────────────────────────────────────────────────────────

describe('BillingAlerts — "Slack missed" badge appears when slackPostFailed is set', () => {
  it("renders the alert row when slackPostFailed is non-null", () => {
    const alert = makeAlert({
      slackPostFailed: new Date(Date.now() - 60_000),
    });

    render(<BillingAlerts alerts={[alert]} />);

    expect(screen.getByText("evt_replay_001")).toBeTruthy();
  });

  it('renders the "Slack missed" badge when slackPostFailed is non-null', () => {
    const alert = makeAlert({
      slackPostFailed: new Date(Date.now() - 60_000),
    });

    render(<BillingAlerts alerts={[alert]} />);

    expect(screen.getByText("Slack missed")).toBeTruthy();
  });

  it('"Slack missed" badge carries the red colour classes', () => {
    const alert = makeAlert({
      slackPostFailed: new Date(Date.now() - 60_000),
    });

    render(<BillingAlerts alerts={[alert]} />);

    const badge = screen.getByText("Slack missed");
    expect(badge.className).toContain("bg-red-100");
    expect(badge.className).toContain("text-red-700");
  });
});

// ── Badge disappears after replay (slackPostFailed cleared to null) ───────────

describe('BillingAlerts — "Slack missed" badge disappears when slackPostFailed is null', () => {
  it('does NOT render the "Slack missed" badge when slackPostFailed is null', () => {
    const alert = makeAlert({
      slackPostFailed: null,
    });

    render(<BillingAlerts alerts={[alert]} />);

    expect(screen.queryByText("Slack missed")).toBeNull();
  });

  it("still renders the alert row when slackPostFailed is null (row not dismissed)", () => {
    const alert = makeAlert({
      slackPostFailed: null,
      dismissedAt: null,
    });

    render(<BillingAlerts alerts={[alert]} />);

    // The row is still visible — replay does not dismiss the alert.
    expect(screen.getByText("evt_replay_001")).toBeTruthy();
  });

  it("does NOT render the replay button when no rows have slackPostFailed set", () => {
    const alert = makeAlert({
      slackPostFailed: null,
    });

    render(<BillingAlerts alerts={[alert]} />);

    expect(screen.queryByText(/Replay \d+ Slack failure/)).toBeNull();
  });
});

// ── Round-trip: seed with badge → cleared → no badge ─────────────────────────

describe("BillingAlerts — round-trip: badge appears then disappears after replay clears slackPostFailed", () => {
  it("badge is present before replay (slackPostFailed non-null)", () => {
    const alertBeforeReplay = makeAlert({
      slackPostFailed: new Date(Date.now() - 120_000),
    });

    render(<BillingAlerts alerts={[alertBeforeReplay]} />);

    expect(screen.getByText("Slack missed")).toBeTruthy();
    expect(screen.getByText(/Replay \d+ Slack failure/)).toBeTruthy();

    cleanup();
  });

  it("badge is absent after replay (slackPostFailed cleared to null) — same row, same alert", () => {
    // Same alert, same ID — but slackPostFailed has been cleared to null after
    // a successful replayFailedSlackAlerts run.
    const alertAfterReplay = makeAlert({
      slackPostFailed: null,
      dismissedAt: null, // replay never dismisses
    });

    render(<BillingAlerts alerts={[alertAfterReplay]} />);

    // Badge must be gone.
    expect(screen.queryByText("Slack missed")).toBeNull();
    // Replay button must be gone too (no pending failures).
    expect(screen.queryByText(/Replay \d+ Slack failure/)).toBeNull();
    // But the row itself is still visible (not dismissed).
    expect(screen.getByText("evt_replay_001")).toBeTruthy();
  });

  it("mixed list: badge shown only for the row that still has slackPostFailed set", () => {
    const alertWithFlag = makeAlert({
      id: "alert-with-flag",
      stripeEventId: "evt_with_flag",
      slackPostFailed: new Date(Date.now() - 60_000),
    });
    const alertCleared = makeAlert({
      id: "alert-cleared",
      stripeEventId: "evt_cleared",
      slackPostFailed: null,
    });

    render(<BillingAlerts alerts={[alertWithFlag, alertCleared]} />);

    // Only one "Slack missed" badge — for the row that still has the flag.
    const badges = screen.getAllByText("Slack missed");
    expect(badges).toHaveLength(1);

    // Both rows are visible.
    expect(screen.getByText("evt_with_flag")).toBeTruthy();
    expect(screen.getByText("evt_cleared")).toBeTruthy();

    // Replay button count reflects only the pending failure.
    expect(screen.getByText(/Replay 1 Slack failure/)).toBeTruthy();
  });
});
