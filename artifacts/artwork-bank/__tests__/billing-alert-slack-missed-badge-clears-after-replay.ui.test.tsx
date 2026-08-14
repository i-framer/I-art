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
    const alert = makeAlert({ slackPostFailed: new Date(Date.now() - 60_000) });

    render(<BillingAlerts alerts={[alert]} />);

    // The row is still visible — replay does not dismiss the alert.
    expect(screen.getByText("evt_replay_001")).toBeTruthy();
  });

  it("does NOT render the replay button when no rows have slackPostFailed set", () => {
    const alert = makeAlert({ slackPostFailed: new Date(Date.now() - 60_000) });

    render(<BillingAlerts alerts={[alert]} />);

    // The row is still visible — replay does not dismiss the alert.
    expect(screen.getByText("evt_replay_001")).toBeTruthy();
  });

  it("does NOT render the replay button when no rows have slackPostFailed set", () => {
    const alert = makeAlert({ slackPostFailed: new Date(Date.now() - 60_000) });

    render(<BillingAlerts alerts={[alert]} />);

    const badge = screen.getByText("Slack missed");
    expect(badge.className).toContain("bg-red-100");
    expect(badge.className).toContain("text-red-700");
  });
});

// ── Badge disappears after replay (slackPostFailed cleared to null) ───────────

describe('BillingAlerts — "Slack missed" badge disappears when slackPostFailed is null', () => {
  it('does NOT render the "Slack missed" badge when slackPostFailed is null', () => {
    const alert = makeAlert({ slackPostFailed: new Date(Date.now() - 60_000) });

    render(<BillingAlerts alerts={[alert]} />);

    // The row is still visible — replay does not dismiss the alert.
    expect(screen.getByText("evt_replay_001")).toBeTruthy();
  });

  it("does NOT render the replay button when no rows have slackPostFailed set", () => {
    const alert = makeAlert({ slackPostFailed: new Date(Date.now() - 60_000) });

    render(<BillingAlerts alerts={[alert]} />);

    // The row is still visible — replay does not dismiss the alert.
    expect(screen.getByText("evt_replay_001")).toBeTruthy();
  });

  it("does NOT render the replay button when no rows have slackPostFailed set", () => {
    const alert = makeAlert({ slackPostFailed: new Date(Date.now() - 60_000) });

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
  });

  it("hides the replay button entirely once all rows are cleared after re-render", async () => {
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
    const cleared = makeAlert({
      id: "rm1",
      stripeEventId: "evt_rm1",
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
      id: "rm1",
      stripeEventId: "evt_rm1",
      slackPostFailed: new Date(Date.now() - 60_000),
    });
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
      makeAlert({ id: "c1", stripeEventId: "evt_c1", slackPostFailed: null }),
      makeAlert({ id: "c2", stripeEventId: "evt_c2", slackPostFailed: null }),
    ];

    render(<BillingAlerts alerts={alerts} />);

    expect(screen.getByText("Replay 3 Slack failures")).toBeTruthy();
    expect(screen.getAllByText("Slack missed")).toHaveLength(3);
  });

  it("hides the replay button entirely when all rows are cleared", async () => {
    const alerts = [
      makeAlert({ id: "c1", stripeEventId: "evt_c1", slackPostFailed: null }),
      makeAlert({ id: "c2", stripeEventId: "evt_c2", slackPostFailed: null }),
    ];

    render(<BillingAlerts alerts={alerts} />);

    // No replay was triggered — the result banner must be absent.
    expect(screen.queryByText(/replayed to Slack/i)).toBeNull();
    expect(screen.queryByText(/still failing/i)).toBeNull();
    expect(screen.queryByText(/skipped/i)).toBeNull();
    expect(screen.queryByText(/No pending Slack failures found/i)).toBeNull();
  });

  it("replay result banner does not persist across remounts (simulates navigation away and back)", async () => {
    vi.mocked(replayFailedSlackAlerts).mockResolvedValueOnce({
      replayed: 1,
      failed: 0,
      skipped: 0,
    });

    const pending = makeAlert({
      id: "rm1",
      stripeEventId: "evt_rm1",
      slackPostFailed: new Date(Date.now() - 60_000),
    });
    const cleared = makeAlert({
      id: "rm1",
      stripeEventId: "evt_rm1",
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
      id: "sk1",
      stripeEventId: "evt_sk1",
      slackPostFailed: new Date(Date.now() - 60_000),
    });
    const pending2 = makeAlert({
      id: "sk2",
      stripeEventId: "evt_sk2",
      slackPostFailed: new Date(Date.now() - 90_000),
    });

    const { rerender } = render(<BillingAlerts alerts={[p1, p2, p3]} />);

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
    rerender(<BillingAlerts alerts={[cleared1, pending2]} />);

    // Label must switch to singular form reflecting the reduced count.
    expect(screen.getByText("Replay 1 Slack failure")).toBeTruthy();

    // The "Slack missed" badge must be gone from the cleared row.
    const badges = screen.getAllByText("Slack missed");
    expect(badges).toHaveLength(1);
  });

  it("hides the replay button entirely once all rows are cleared after re-render", async () => {
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

    const { rerender } = render(<BillingAlerts alerts={[p1, p2, p3]} />);

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

// ── Post-settle: button re-enables and accepts a second click ─────────────────

describe("BillingAlerts — replay button re-enables after the action settles", () => {
  it("button loses the disabled attribute once the action resolves", async () => {
    const mockReplay = vi.mocked(replayFailedSlackAlerts);

    let rejectFirst!: (reason: Error) => void;

    let resolveFirst!: (value: { replayed: number; failed: number; skipped: number }) => void;

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

    // Button must be disabled while the transition is pending.
    await vi.waitFor(() => {
      expect(replayBtn.hasAttribute("disabled")).toBe(true);
    });

    // Reject the first promise so React can finish the transition.
    await act(async () => {
      rejectFirst(new Error("Network error"));
    });

    // After the rejection settles, useTransition must clear replayPending,
    // so the button must no longer be disabled.
    await vi.waitFor(() => {
      expect(replayBtn.hasAttribute("disabled")).toBe(false);
    });

    // Only one call so far.
    expect(mockReplay).toHaveBeenCalledTimes(1);

    // Second click after the rejection — the button is enabled again, so the
    // server action must fire a second time.
    await act(async () => {
      fireEvent.click(replayBtn);
    });

    expect(mockReplay).toHaveBeenCalledTimes(2);
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
      id: "rm1",
      stripeEventId: "evt_rm1",
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
      makeAlert({ id: "c1", stripeEventId: "evt_c1", slackPostFailed: null }),
      makeAlert({ id: "c2", stripeEventId: "evt_c2", slackPostFailed: null }),
    ];

    render(<BillingAlerts alerts={alerts} />);

    // No replay was triggered — the result banner must be absent.
    expect(screen.queryByText(/replayed to Slack/i)).toBeNull();
    expect(screen.queryByText(/still failing/i)).toBeNull();
    expect(screen.queryByText(/skipped/i)).toBeNull();
    expect(screen.queryByText(/No pending Slack failures found/i)).toBeNull();
  });

  it("replay result banner does not persist across remounts (simulates navigation away and back)", async () => {
    vi.mocked(replayFailedSlackAlerts).mockResolvedValueOnce({
      replayed: 1,
      failed: 0,
      skipped: 0,
    });

    const pending = makeAlert({
      id: "rm1",
      stripeEventId: "evt_rm1",
      slackPostFailed: new Date(Date.now() - 60_000),
    });

    render(<BillingAlerts alerts={[cleared]} />);

    // The banner must NOT reappear on the fresh mount — replayResult is
    // local useState and resets to null on every new component instance.
    expect(screen.queryByText(/replayed to Slack/i)).toBeNull();
    expect(screen.queryByText(/still failing/i)).toBeNull();
    expect(screen.queryByText(/No pending Slack failures found/i)).toBeNull();

    // The alert row is still visible (not dismissed).
    expect(screen.getByText("evt_rm1")).toBeTruthy();

    // No replay button either — no pending failures.
    expect(screen.queryByText(/Replay \d+ Slack failure/)).toBeNull();
  });
});
