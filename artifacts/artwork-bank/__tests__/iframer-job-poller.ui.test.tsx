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

import React, { useState } from "react";
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
});
