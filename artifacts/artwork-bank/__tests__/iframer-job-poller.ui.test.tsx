// @vitest-environment happy-dom
/**
 * Tests for the IFramerJobPoller component.
 *
 * Covers:
 * - Renders nothing (side-effect only component).
 * - Does NOT start polling when isPending=false.
 * - Calls router.refresh() on each interval tick when isPending=true.
 * - Stops automatically after MAX_POLLS (24) ticks.
 * - Clears the interval on component unmount.
 * - Re-arms the poll loop when isPending transitions true → false → true
 *   (prop change causes effect re-run).
 * - Integration: parent re-renders with isPending=false once job ID arrives,
 *   and no further ticks fire after that update.
 */

import React, { useState, useTransition } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { IFramerJobPoller } from "../app/(admin)/(gated)/orders/[id]/_components/iframer-job-poller";

// ---------------------------------------------------------------------------
// Mock next/navigation so we control router.refresh() calls
// ---------------------------------------------------------------------------

const mockRefresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

// ---------------------------------------------------------------------------
// Constants mirrored from the component (we test the public contract, not the
// literals, but we need them to drive fake timers precisely).
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 5_000;
const MAX_POLLS = 24;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("IFramerJobPoller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockRefresh.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Rendering ─────────────────────────────────────────────────────────────

  it("renders nothing into the DOM", () => {
    const { container } = render(<IFramerJobPoller isPending={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("also renders nothing when isPending=true (side-effect only)", () => {
    const { container } = render(<IFramerJobPoller isPending={true} />);
    expect(container.firstChild).toBeNull();
  });

  // ── No-op when not pending ────────────────────────────────────────────────

  it("does not call router.refresh() when isPending=false", () => {
    render(<IFramerJobPoller isPending={false} />);

    act(() => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * 3);
    });

    expect(mockRefresh).not.toHaveBeenCalled();
  });

  // ── Poll loop fires at the correct interval ───────────────────────────────

  it("calls router.refresh() once after one interval", () => {
    render(<IFramerJobPoller isPending={true} />);

    act(() => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS);
    });

    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("calls router.refresh() N times after N intervals", () => {
    render(<IFramerJobPoller isPending={true} />);

    const ticks = 5;
    act(() => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * ticks);
    });

    expect(mockRefresh).toHaveBeenCalledTimes(ticks);
  });

  // ── Auto-stop after MAX_POLLS ─────────────────────────────────────────────

  it("stops polling after MAX_POLLS ticks and does not poll further", () => {
    render(<IFramerJobPoller isPending={true} />);

    // Advance exactly MAX_POLLS ticks — all should fire.
    act(() => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * MAX_POLLS);
    });

    expect(mockRefresh).toHaveBeenCalledTimes(MAX_POLLS);

    // Advance several more ticks — no additional calls expected.
    act(() => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * 5);
    });

    expect(mockRefresh).toHaveBeenCalledTimes(MAX_POLLS);
  });

  it("fires exactly MAX_POLLS times and no more (boundary check)", () => {
    render(<IFramerJobPoller isPending={true} />);

    // Advance just past MAX_POLLS+1 intervals to be sure.
    act(() => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * (MAX_POLLS + 1));
    });

    expect(mockRefresh).toHaveBeenCalledTimes(MAX_POLLS);
  });

  // ── Cleanup on unmount ────────────────────────────────────────────────────

  it("stops polling when the component is unmounted", () => {
    const { unmount } = render(<IFramerJobPoller isPending={true} />);

    // Let 3 ticks fire.
    act(() => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * 3);
    });

    expect(mockRefresh).toHaveBeenCalledTimes(3);

    // Unmount mid-run.
    unmount();

    // Advance further — no more calls expected.
    act(() => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * 10);
    });

    expect(mockRefresh).toHaveBeenCalledTimes(3);
  });

  // ── isPending=false stops immediately ─────────────────────────────────────

  it("clears the timer when isPending transitions from true to false", () => {
    const { rerender } = render(<IFramerJobPoller isPending={true} />);

    act(() => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * 2);
    });

    expect(mockRefresh).toHaveBeenCalledTimes(2);

    // Simulate the parent re-rendering once the job resolves.
    rerender(<IFramerJobPoller isPending={false} />);

    act(() => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * 5);
    });

    // Should not have gained any more calls after isPending flipped.
    expect(mockRefresh).toHaveBeenCalledTimes(2);
  });

  // ── Re-arm when isPending flips back to true ──────────────────────────────

  it("resumes polling when isPending transitions false → true", () => {
    const { rerender } = render(<IFramerJobPoller isPending={false} />);

    act(() => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * 3);
    });

    expect(mockRefresh).not.toHaveBeenCalled();

    rerender(<IFramerJobPoller isPending={true} />);

    act(() => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * 2);
    });

    expect(mockRefresh).toHaveBeenCalledTimes(2);
  });

  // ── Poll counter resets on re-mount ───────────────────────────────────────

  it("resets the poll counter on a fresh mount so MAX_POLLS fires again", () => {
    const { unmount } = render(<IFramerJobPoller isPending={true} />);

    act(() => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * MAX_POLLS);
    });

    expect(mockRefresh).toHaveBeenCalledTimes(MAX_POLLS);

    unmount();
    mockRefresh.mockClear();

    // A fresh mount should allow another full cycle.
    render(<IFramerJobPoller isPending={true} />);

    act(() => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * MAX_POLLS);
    });

    expect(mockRefresh).toHaveBeenCalledTimes(MAX_POLLS);
  });

  // ── Integration: full parent → child cycle ────────────────────────────────

  it("stops polling as soon as the parent re-renders with isPending=false after a job ID arrives", () => {
    /**
     * Thin wrapper that simulates the real parent component.
     *
     * Starts with no job ID (isPending=true).  When router.refresh() fires for
     * the first time the wrapper transitions to jobArrived=true (isPending=false),
     * mirroring what happens when the webhook delivers an iframerJobId and the
     * server component re-renders via Next.js router.refresh().
     */
    function OrderDetailWrapper() {
      const [jobArrived, setJobArrived] = useState(false);

      // Expose the setter so mockRefresh can drive the state transition.
      mockRefresh.mockImplementation(() => {
        setJobArrived(true);
      });

      return <IFramerJobPoller isPending={!jobArrived} />;
    }

    render(<OrderDetailWrapper />);

    // Before any tick: no refresh calls yet.
    expect(mockRefresh).not.toHaveBeenCalled();

    // Advance one interval — the poller fires router.refresh(), which sets
    // jobArrived=true synchronously inside act(), causing an immediate
    // re-render with isPending=false and clearing the interval.
    act(() => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS);
    });

    expect(mockRefresh).toHaveBeenCalledTimes(1);

    // Advance several more intervals — the interval must already be cleared;
    // no additional refresh calls should occur.
    act(() => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * 5);
    });

    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("does not fire an extra tick between the job ID arriving and the interval clearing", () => {
    /**
     * Verifies the tighter timing guarantee: once isPending flips false the
     * very next scheduled tick must not call router.refresh() again.
     *
     * Uses a wrapper that flips on the SECOND refresh call so we can confirm
     * the third tick is suppressed (not just the first transition).
     */
    let refreshCount = 0;

    function OrderDetailWrapper() {
      const [jobArrived, setJobArrived] = useState(false);

      mockRefresh.mockImplementation(() => {
        refreshCount++;
        if (refreshCount >= 2) {
          setJobArrived(true);
        }
      });

      return <IFramerJobPoller isPending={!jobArrived} />;
    }

    render(<OrderDetailWrapper />);

    // Two ticks: first is a normal poll, second delivers the job and stops the
    // interval inside the same act() flush.
    act(() => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * 2);
    });

    expect(mockRefresh).toHaveBeenCalledTimes(2);

    // Any subsequent ticks should be suppressed.
    act(() => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * 5);
    });

    expect(mockRefresh).toHaveBeenCalledTimes(2);
  });

  // ── Counter reset after true → false → true transition ────────────────────

  it("resets its tick counter when isPending flips back to true after a false stretch", () => {
    /**
     * Wrapper that cycles through three phases, matching the real parent component
     * pattern:
     *
     *   Phase 1 – "pending":  isPending=true  → poller runs, burns some ticks.
     *   Phase 2 – "arrived":  isPending=false → poller stops (job ID present).
     *   Phase 3 – "reset":    isPending=true  → poller re-arms with a FRESH
     *                          MAX_POLLS budget (e.g. after an error clears the
     *                          job ID so the parent is pending again).
     *
     * The key invariant: the second polling run must allow a full MAX_POLLS
     * ticks regardless of how many ticks fired in the first run.
     */
    type Phase = "pending" | "arrived" | "reset";

    function OrderDetailWrapper({ phase }: { phase: Phase }) {
      // "arrived" is the only state where there is a job ID → isPending=false.
      const isPending = phase !== "arrived";
      return <IFramerJobPoller isPending={isPending} />;
    }

    const { rerender } = render(<OrderDetailWrapper phase="pending" />);

    // Phase 1: let 5 ticks fire — partial use of the MAX_POLLS budget.
    const phase1Ticks = 5;
    act(() => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * phase1Ticks);
    });
    expect(mockRefresh).toHaveBeenCalledTimes(phase1Ticks);

    // Phase 2: job ID arrives → isPending flips false → poller stops.
    rerender(<OrderDetailWrapper phase="arrived" />);
    act(() => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * 3);
    });
    // No new ticks should have fired after the flip.
    expect(mockRefresh).toHaveBeenCalledTimes(phase1Ticks);

    // Reset the call count so the second run can be measured in isolation.
    mockRefresh.mockClear();

    // Phase 3: error reset clears the job ID → isPending flips back to true.
    rerender(<OrderDetailWrapper phase="reset" />);

    // The second run must get a full MAX_POLLS budget, not MAX_POLLS - phase1Ticks.
    act(() => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * MAX_POLLS);
    });
    expect(mockRefresh).toHaveBeenCalledTimes(MAX_POLLS);

    // Confirm the auto-stop still works: no ticks beyond MAX_POLLS.
    act(() => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * 5);
    });
    expect(mockRefresh).toHaveBeenCalledTimes(MAX_POLLS);
  });

  // ── Auto-stop via Suspense-boundary transition (startTransition) ──────────

  it("auto-stop fires when the wrapper drives isPending=false via a startTransition (Suspense boundary transition)", () => {
    /**
     * Task #760
     *
     * Verifies that the poller's auto-stop works correctly when the parent
     * component transitions isPending to false using React's startTransition —
     * the deferred-update path that Suspense boundaries use when a pending
     * navigation settles.
     *
     * The concern: concurrent-mode transitions queue state updates differently
     * from synchronous setState.  A naive implementation that relies on the
     * effect cleanup running synchronously might miss the update and let one
     * extra tick fire before the interval clears.
     *
     * How it works:
     *   1. Render a wrapper that starts with isPending=true.
     *   2. Let 3 ticks fire (partial use of the MAX_POLLS budget).
     *   3. Drive isPending=false through startTransition (Suspense-like).
     *   4. Confirm no further ticks fire after the transition settles.
     */
    let driveStop: () => void = () => {};

    function OrderDetailWrapper() {
      const [isJobPending, setIsJobPending] = useState(true);
      const [, startTransition] = useTransition();

      // Expose a handle so the test can trigger the transition externally.
      driveStop = () => {
        startTransition(() => {
          setIsJobPending(false);
        });
      };

      return <IFramerJobPoller isPending={isJobPending} />;
    }

    render(<OrderDetailWrapper />);

    // Let 3 ticks fire — partial budget consumption.
    act(() => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * 3);
    });
    expect(mockRefresh).toHaveBeenCalledTimes(3);

    // Drive isPending=false through a startTransition (Suspense-boundary path).
    act(() => {
      driveStop();
    });

    // No further ticks should fire once the transition settles.
    act(() => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * 5);
    });
    expect(mockRefresh).toHaveBeenCalledTimes(3);
  });

  it("fires exactly the correct number of ticks before the startTransition auto-stop (boundary check)", () => {
    /**
     * Companion boundary check for Task #760.
     *
     * Confirms the pre-transition ticks are all preserved (none are swallowed by
     * the transition scheduling) and only post-transition ticks are suppressed.
     */
    let driveStop: () => void = () => {};

    function OrderDetailWrapper() {
      const [isJobPending, setIsJobPending] = useState(true);
      const [, startTransition] = useTransition();

      driveStop = () => {
        startTransition(() => setIsJobPending(false));
      };

      return <IFramerJobPoller isPending={isJobPending} />;
    }

    render(<OrderDetailWrapper />);

    const preTicks = 7;
    act(() => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * preTicks);
    });
    expect(mockRefresh).toHaveBeenCalledTimes(preTicks);

    act(() => {
      driveStop();
    });

    // Advance well past the remaining budget — must stay at preTicks.
    act(() => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * (MAX_POLLS - preTicks + 5));
    });
    expect(mockRefresh).toHaveBeenCalledTimes(preTicks);
  });

  // ── Counter reset after exhausted-budget → false → true ───────────────────

  it("resets its tick counter when isPending flips back to true after the first run exhausted all MAX_POLLS ticks", () => {
    /**
     * Edge-case variant of the true → false → true test above.
     *
     * Phase 1 – "pending":  isPending=true  → poller runs ALL MAX_POLLS ticks;
     *                        the interval self-clears (budget exhausted).
     * Phase 2 – "arrived":  isPending=false → poller is already stopped but
     *                        the effect still re-runs and returns early.
     * Phase 3 – "reset":    isPending=true  → poller re-arms with a FRESH
     *                        MAX_POLLS budget (the counter was exhausted in run
     *                        1, so this verifies it is reset to 0, not left at
     *                        MAX_POLLS which would cause an immediate no-op).
     *
     * The key invariant: the second polling run must deliver a full MAX_POLLS
     * ticks even though the first run consumed all of them.
     */
    type Phase = "pending" | "arrived" | "reset";

    function OrderDetailWrapper({ phase }: { phase: Phase }) {
      const isPending = phase !== "arrived";
      return <IFramerJobPoller isPending={isPending} />;
    }

    const { rerender } = render(<OrderDetailWrapper phase="pending" />);

    // Phase 1: exhaust the full MAX_POLLS budget — the interval self-clears.
    act(() => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * MAX_POLLS);
    });
    expect(mockRefresh).toHaveBeenCalledTimes(MAX_POLLS);

    // Confirm the auto-stop: additional time must not produce more calls.
    act(() => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * 3);
    });
    expect(mockRefresh).toHaveBeenCalledTimes(MAX_POLLS);

    // Phase 2: isPending flips false (job ID present, or error surfaced).
    rerender(<OrderDetailWrapper phase="arrived" />);
    act(() => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * 3);
    });
    expect(mockRefresh).toHaveBeenCalledTimes(MAX_POLLS);

    // Reset the call count so run 2 can be measured in isolation.
    mockRefresh.mockClear();

    // Phase 3: error reset clears the job ID → isPending flips back to true.
    rerender(<OrderDetailWrapper phase="reset" />);

    // Run 2 must receive a full MAX_POLLS budget, not zero (which would happen
    // if the exhausted counter from run 1 were carried forward).
    act(() => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * MAX_POLLS);
    });
    expect(mockRefresh).toHaveBeenCalledTimes(MAX_POLLS);

    // Confirm the auto-stop still works in run 2.
    act(() => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * 5);
    });
    expect(mockRefresh).toHaveBeenCalledTimes(MAX_POLLS);
  });
});
