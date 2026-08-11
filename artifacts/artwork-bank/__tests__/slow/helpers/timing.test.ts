/**
 * Unit tests for the checkTimingBudget timing helper.
 *
 * These tests run under the normal `pnpm test` suite because they exercise
 * pure logic — no servers are spawned and no I/O is performed.  Only the
 * parent slow-test files that spawn child processes are excluded from the
 * default run.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  checkTimingBudget,
  TIMING_WARNING_THRESHOLD,
} from "./timing";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("checkTimingBudget", () => {
  it("always logs elapsed/deadline/used% via console.log", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    checkTimingBudget(300, 1500, "my label");

    expect(logSpy).toHaveBeenCalledOnce();
    const msg = logSpy.mock.calls[0][0] as string;
    expect(msg).toContain("[timing] my label:");
    expect(msg).toContain("elapsed=300ms");
    expect(msg).toContain("deadline=1500ms");
    expect(msg).toContain("used=20.0%");
  });

  it("emits console.warn when elapsed/deadline >= TIMING_WARNING_THRESHOLD (0.8)", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // 1200 / 1500 = 0.8 — exactly at the threshold
    checkTimingBudget(1200, 1500, "warn label");

    expect(warnSpy).toHaveBeenCalledOnce();
    const msg = warnSpy.mock.calls[0][0] as string;
    expect(msg).toContain("[timing] WARNING:");
    expect(msg).toContain('"warn label"');
    expect(msg).toContain("80.0%");
    expect(msg).toContain("1200ms / 1500ms");
    expect(msg).toContain("dangerously close");
  });

  it("emits console.warn when elapsed/deadline > TIMING_WARNING_THRESHOLD (above threshold)", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // 1400 / 1500 ≈ 0.933 — well above the threshold
    checkTimingBudget(1400, 1500, "over label");

    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("does NOT emit console.warn when elapsed/deadline < TIMING_WARNING_THRESHOLD (0.8)", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // 1199 / 1500 ≈ 0.799 — just under the threshold
    checkTimingBudget(1199, 1500, "safe label");

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does NOT emit console.warn well below the threshold", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    checkTimingBudget(300, 1500, "fast operation");

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("TIMING_WARNING_THRESHOLD is 0.8", () => {
    expect(TIMING_WARNING_THRESHOLD).toBe(0.8);
  });
});
