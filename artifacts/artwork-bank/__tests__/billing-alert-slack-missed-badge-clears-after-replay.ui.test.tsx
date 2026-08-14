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
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
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
import { replayFailedSlackAlerts } from "@/app/platform/actions";
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

// ── Partial-replay count accuracy ─────────────────────────────────────────────

describe("BillingAlerts — replay button count accuracy with partial pending rows", () => {
  it("shows 'Replay 2 Slack failures' (plural) when 2 of 3 rows are still pending", () => {
    const pending1 = makeAlert({
      id: "p1",
      stripeEventId: "evt_p1",
      slackPostFailed: new Date(Date.now() - 60_000),
    });
    const pending2 = makeAlert({
      id: "p2",
      stripeEventId: "evt_p2",
      slackPostFailed: new Date(Date.now() - 120_000),
    });
    const cleared = makeAlert({
      id: "c1",
      stripeEventId: "evt_c1",
      slackPostFailed: null,
    });

    render(<BillingAlerts alerts={[pending1, pending2, cleared]} />);

    // Button must show the exact count of still-pending rows.
    expect(screen.getByText("Replay 2 Slack failures")).toBeTruthy();

    // Two badges, one per pending row.
    const badges = screen.getAllByText("Slack missed");
    expect(badges).toHaveLength(2);

    // Cleared row must NOT have a badge.
    expect(screen.getByText("evt_c1")).toBeTruthy();
  });

  it("shows 'Replay 1 Slack failure' (singular) when exactly 1 of 3 rows is still pending", () => {
    const pending = makeAlert({
      id: "p1",
      stripeEventId: "evt_single_pending",
      slackPostFailed: new Date(Date.now() - 60_000),
    });
    const cleared1 = makeAlert({
      id: "c1",
      stripeEventId: "evt_cleared_a",
      slackPostFailed: null,
    });
    const cleared2 = makeAlert({
      id: "c2",
      stripeEventId: "evt_cleared_b",
      slackPostFailed: null,
    });

    render(<BillingAlerts alerts={[cleared1, pending, cleared2]} />);

    // Singular label when count is 1.
    expect(screen.getByText("Replay 1 Slack failure")).toBeTruthy();

    // Only one badge.
    const badges = screen.getAllByText("Slack missed");
    expect(badges).toHaveLength(1);

    // Cleared rows have no badge.
    expect(screen.queryAllByText("Slack missed")).toHaveLength(1);
  });

  it("shows 'Replay 3 Slack failures' when all rows are pending", () => {
    const alerts = [
      makeAlert({ id: "a1", stripeEventId: "evt_a1", slackPostFailed: new Date(Date.now() - 60_000) }),
      makeAlert({ id: "a2", stripeEventId: "evt_a2", slackPostFailed: new Date(Date.now() - 90_000) }),
      makeAlert({ id: "a3", stripeEventId: "evt_a3", slackPostFailed: new Date(Date.now() - 120_000) }),
    ];

    render(<BillingAlerts alerts={alerts} />);

    expect(screen.getByText("Replay 3 Slack failures")).toBeTruthy();
    expect(screen.getAllByText("Slack missed")).toHaveLength(3);
  });

  it("hides the replay button entirely when all rows are cleared", () => {
    const alerts = [
      makeAlert({ id: "c1", stripeEventId: "evt_c1", slackPostFailed: null }),
      makeAlert({ id: "c2", stripeEventId: "evt_c2", slackPostFailed: null }),
      makeAlert({ id: "c3", stripeEventId: "evt_c3", slackPostFailed: null }),
    ];

    render(<BillingAlerts alerts={alerts} />);

    // No replay button.
    expect(screen.queryByText(/Replay \d+ Slack failure/)).toBeNull();

    // No badges.
    expect(screen.queryByText("Slack missed")).toBeNull();

    // All rows still visible (not dismissed).
    expect(screen.getByText("evt_c1")).toBeTruthy();
    expect(screen.getByText("evt_c2")).toBeTruthy();
    expect(screen.getByText("evt_c3")).toBeTruthy();
  });

  it("badge is on the correct specific row, not on the cleared neighbour", () => {
    const pending = makeAlert({
      id: "specific-pending",
      stripeEventId: "evt_specific_pending",
      slackPostFailed: new Date(Date.now() - 60_000),
    });
    const cleared = makeAlert({
      id: "specific-cleared",
      stripeEventId: "evt_specific_cleared",
      slackPostFailed: null,
    });

    render(<BillingAlerts alerts={[pending, cleared]} />);

    // Find the badge and verify it's co-located with the pending event ID.
    const badge = screen.getByText("Slack missed");
    // The badge's closest list-item ancestor must contain the pending event ID text.
    const li = badge.closest("li");
    expect(li).not.toBeNull();
    expect(li!.textContent).toContain("evt_specific_pending");
    expect(li!.textContent).not.toContain("evt_specific_cleared");
  });
});

// ── Interactive replay: click → server action resolves → re-render with new props ─

describe("BillingAlerts — replay button count updates after click and re-render with updated props", () => {
  it("transitions from 'Replay 2 Slack failures' to 'Replay 1 Slack failure' after one row is cleared", async () => {
    const pending1 = makeAlert({
      id: "p1",
      stripeEventId: "evt_p1",
      slackPostFailed: new Date(Date.now() - 60_000),
    });
    const pending2 = makeAlert({
      id: "p2",
      stripeEventId: "evt_p2",
      slackPostFailed: new Date(Date.now() - 90_000),
    });

    const { rerender } = render(<BillingAlerts alerts={[pending1, pending2]} />);

    // Initially the button shows the full count.
    expect(screen.getByText("Replay 2 Slack failures")).toBeTruthy();

    // Simulate the user clicking the replay button.
    const replayBtn = screen.getByRole("button", { name: /Replay/i });
    await act(async () => {
      fireEvent.click(replayBtn);
    });

    // Simulate the parent page re-fetching and passing updated props where
    // only one row still has slackPostFailed set.
    const cleared1 = makeAlert({
      id: "p1",
      stripeEventId: "evt_p1",
      slackPostFailed: null,
    });
    rerender(<BillingAlerts alerts={[cleared1, pending2]} />);

    // Label must switch to singular form reflecting the reduced count.
    expect(screen.getByText("Replay 1 Slack failure")).toBeTruthy();

    // The "Slack missed" badge must be gone from the cleared row.
    const badges = screen.getAllByText("Slack missed");
    expect(badges).toHaveLength(1);
  });

  it("hides the replay button entirely once all rows are cleared after re-render", async () => {
    const pending1 = makeAlert({
      id: "p1",
      stripeEventId: "evt_p1",
      slackPostFailed: new Date(Date.now() - 60_000),
    });
    const pending2 = makeAlert({
      id: "p2",
      stripeEventId: "evt_p2",
      slackPostFailed: new Date(Date.now() - 90_000),
    });

    const { rerender } = render(<BillingAlerts alerts={[pending1, pending2]} />);

    expect(screen.getByText("Replay 2 Slack failures")).toBeTruthy();

    const replayBtn = screen.getByRole("button", { name: /Replay/i });
    await act(async () => {
      fireEvent.click(replayBtn);
    });

    // Re-render with all rows cleared — the server action successfully replayed both.
    const cleared1 = makeAlert({
      id: "p1",
      stripeEventId: "evt_p1",
      slackPostFailed: null,
    });
    const cleared2 = makeAlert({
      id: "p2",
      stripeEventId: "evt_p2",
      slackPostFailed: null,
    });
    rerender(<BillingAlerts alerts={[cleared1, cleared2]} />);

    // Replay button must have disappeared entirely.
    expect(screen.queryByText(/Replay \d+ Slack failure/)).toBeNull();

    // No "Slack missed" badges remain.
    expect(screen.queryByText("Slack missed")).toBeNull();

    // Both alert rows are still visible (replay does not dismiss rows).
    expect(screen.getByText("evt_p1")).toBeTruthy();
    expect(screen.getByText("evt_p2")).toBeTruthy();
  });

  it("steps through 3 → 2 → 1 → hidden as rows are progressively cleared via re-renders", async () => {
    const p1 = makeAlert({ id: "p1", stripeEventId: "evt_p1", slackPostFailed: new Date(Date.now() - 30_000) });
    const p2 = makeAlert({ id: "p2", stripeEventId: "evt_p2", slackPostFailed: new Date(Date.now() - 60_000) });
    const p3 = makeAlert({ id: "p3", stripeEventId: "evt_p3", slackPostFailed: new Date(Date.now() - 90_000) });

    const { rerender } = render(<BillingAlerts alerts={[p1, p2, p3]} />);
    expect(screen.getByText("Replay 3 Slack failures")).toBeTruthy();

    // First replay click.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Replay/i }));
    });

    // Parent re-fetches: one row cleared.
    const c1 = makeAlert({ id: "p1", stripeEventId: "evt_p1", slackPostFailed: null });
    rerender(<BillingAlerts alerts={[c1, p2, p3]} />);
    expect(screen.getByText("Replay 2 Slack failures")).toBeTruthy();

    // Second replay click.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Replay/i }));
    });

    // Parent re-fetches: two rows cleared.
    const c2 = makeAlert({ id: "p2", stripeEventId: "evt_p2", slackPostFailed: null });
    rerender(<BillingAlerts alerts={[c1, c2, p3]} />);
    expect(screen.getByText("Replay 1 Slack failure")).toBeTruthy();

    // Third replay click.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Replay/i }));
    });

    // Parent re-fetches: all rows cleared.
    const c3 = makeAlert({ id: "p3", stripeEventId: "evt_p3", slackPostFailed: null });
    rerender(<BillingAlerts alerts={[c1, c2, c3]} />);
    expect(screen.queryByText(/Replay \d+ Slack failure/)).toBeNull();
  });
});

// ── In-flight guard: button disabled and second click ignored ─────────────────

describe("BillingAlerts — replay button disabled while a replay is in flight", () => {
  it("button carries the disabled attribute while the action is pending and a second click is ignored", async () => {
    const mockReplay = vi.mocked(replayFailedSlackAlerts);

    // Reset call history from earlier tests in this file.
    mockReplay.mockClear();

    // Replace the default instant-resolve mock with a never-settling promise so
    // we can inspect the button state while the action is still in flight.
    let resolveReplay!: (value: { replayed: number; failed: number; skipped: number }) => void;
    mockReplay.mockImplementationOnce(
      () =>
        new Promise<{ replayed: number; failed: number; skipped: number }>(
          (resolve) => {
            resolveReplay = resolve;
          },
        ),
    );

    const alert = makeAlert({ slackPostFailed: new Date(Date.now() - 60_000) });
    render(<BillingAlerts alerts={[alert]} />);

    const replayBtn = screen.getByRole("button", { name: /Replay/i });

    // First click — starts the in-flight transition.
    fireEvent.click(replayBtn);

    // The useTransition hook sets replayPending=true synchronously from React's
    // perspective once the transition starts, so the disabled attribute should
    // appear before the promise resolves.
    await vi.waitFor(() => {
      expect(replayBtn.hasAttribute("disabled")).toBe(true);
    });

    // Second click while the action is still in flight — the button is disabled
    // so the onClick handler must not fire a second time.
    fireEvent.click(replayBtn);

    // Only one server-action call should have been made despite two clicks.
    expect(mockReplay).toHaveBeenCalledTimes(1);

    // Settle the pending promise so React can finish the transition cleanly
    // before the test teardown runs.
    await act(async () => {
      resolveReplay({ replayed: 1, failed: 0, skipped: 0 });
    });
  });
});

// ── Replay result banner: partial-replay counts ───────────────────────────────

describe("BillingAlerts — replay result banner shows correct counts after a partial replay", () => {
  it("shows '✓ 2 alerts replayed to Slack' and '✗ 1 still failing' when result is { replayed: 2, failed: 1, skipped: 0 }", async () => {
    vi.mocked(replayFailedSlackAlerts).mockResolvedValueOnce({
      replayed: 2,
      failed: 1,
      skipped: 0,
    });

    const pending1 = makeAlert({
      id: "b1",
      stripeEventId: "evt_b1",
      slackPostFailed: new Date(Date.now() - 60_000),
    });
    const pending2 = makeAlert({
      id: "b2",
      stripeEventId: "evt_b2",
      slackPostFailed: new Date(Date.now() - 90_000),
    });
    const pending3 = makeAlert({
      id: "b3",
      stripeEventId: "evt_b3",
      slackPostFailed: new Date(Date.now() - 120_000),
    });

    render(<BillingAlerts alerts={[pending1, pending2, pending3]} />);

    // Click the replay button so the server action runs and the banner appears.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Replay/i }));
    });

    // The "replayed" part of the banner must show the exact count.
    expect(screen.getByText(/✓ 2 alerts replayed to Slack/)).toBeTruthy();

    // The "failed" part of the banner must show the exact count.
    expect(screen.getByText(/✗ 1 still failing/)).toBeTruthy();

    // No skipped text should appear (skipped === 0).
    expect(screen.queryByText(/skipped/i)).toBeNull();
  });

  it("shows singular '✓ 1 alert replayed to Slack' when replayed is 1", async () => {
    vi.mocked(replayFailedSlackAlerts).mockResolvedValueOnce({
      replayed: 1,
      failed: 0,
      skipped: 0,
    });

    const pending = makeAlert({
      id: "s1",
      stripeEventId: "evt_s1",
      slackPostFailed: new Date(Date.now() - 60_000),
    });

    render(<BillingAlerts alerts={[pending]} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Replay/i }));
    });

    // Singular form: "alert" not "alerts".
    expect(screen.getByText(/✓ 1 alert replayed to Slack/)).toBeTruthy();

    // No failed or skipped lines.
    expect(screen.queryByText(/still failing/i)).toBeNull();
    expect(screen.queryByText(/skipped/i)).toBeNull();
  });

  it("shows skipped count when skipped > 0", async () => {
    vi.mocked(replayFailedSlackAlerts).mockResolvedValueOnce({
      replayed: 1,
      failed: 0,
      skipped: 2,
    });

    const pending1 = makeAlert({
      id: "sk1",
      stripeEventId: "evt_sk1",
      slackPostFailed: new Date(Date.now() - 60_000),
    });
    const pending2 = makeAlert({
      id: "sk2",
      stripeEventId: "evt_sk2",
      slackPostFailed: new Date(Date.now() - 90_000),
    });
    const pending3 = makeAlert({
      id: "sk3",
      stripeEventId: "evt_sk3",
      slackPostFailed: new Date(Date.now() - 120_000),
    });

    render(<BillingAlerts alerts={[pending1, pending2, pending3]} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Replay/i }));
    });

    // The replayed count must be present.
    expect(screen.getByText(/✓ 1 alert replayed to Slack/)).toBeTruthy();

    // The skipped count must appear in the banner.
    expect(screen.getByText(/2 skipped/)).toBeTruthy();

    // No failed line.
    expect(screen.queryByText(/still failing/i)).toBeNull();
  });

  it("shows all three lines when replayed, failed, and skipped are all > 0", async () => {
    vi.mocked(replayFailedSlackAlerts).mockResolvedValueOnce({
      replayed: 3,
      failed: 2,
      skipped: 1,
    });

    const alerts = [
      makeAlert({ id: "m1", stripeEventId: "evt_m1", slackPostFailed: new Date(Date.now() - 30_000) }),
      makeAlert({ id: "m2", stripeEventId: "evt_m2", slackPostFailed: new Date(Date.now() - 60_000) }),
      makeAlert({ id: "m3", stripeEventId: "evt_m3", slackPostFailed: new Date(Date.now() - 90_000) }),
      makeAlert({ id: "m4", stripeEventId: "evt_m4", slackPostFailed: new Date(Date.now() - 120_000) }),
      makeAlert({ id: "m5", stripeEventId: "evt_m5", slackPostFailed: new Date(Date.now() - 150_000) }),
      makeAlert({ id: "m6", stripeEventId: "evt_m6", slackPostFailed: new Date(Date.now() - 180_000) }),
    ];

    render(<BillingAlerts alerts={alerts} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Replay/i }));
    });

    expect(screen.getByText(/✓ 3 alerts replayed to Slack/)).toBeTruthy();
    expect(screen.getByText(/✗ 2 still failing/)).toBeTruthy();
    expect(screen.getByText(/1 skipped/)).toBeTruthy();
  });

  it("shows 'No pending Slack failures found.' when all counts are zero", async () => {
    vi.mocked(replayFailedSlackAlerts).mockResolvedValueOnce({
      replayed: 0,
      failed: 0,
      skipped: 0,
    });

    const pending = makeAlert({
      id: "z1",
      stripeEventId: "evt_z1",
      slackPostFailed: new Date(Date.now() - 60_000),
    });

    render(<BillingAlerts alerts={[pending]} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Replay/i }));
    });

    expect(screen.getByText("No pending Slack failures found.")).toBeTruthy();
  });
});
