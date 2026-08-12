/**
 * Task #660 — Catch a weakened stall guard on PRs, not just after it ships
 * to main.
 *
 * Context
 * ───────
 * The stall-guard meta-test job in `.github/workflows/slow-tests.yml` only
 * runs on pushes to main or workflow_dispatch — it takes ~13 minutes and
 * deliberately breaks the slow suite.  Running it on every PR is impractical.
 *
 * However, a weakened stall guard (e.g. increasing UPLOAD_READ_TIMEOUT_MS from
 * 30 000 ms to 300 000 ms, or changing `getTotalTimeoutMs()` to return 0) would
 * NOT be caught by the PR slow-tests run if only the production defaults matter.
 *
 * This file provides a lightweight PR-safe guard that runs as part of the
 * normal fast test suite (milliseconds, no next-dev required):
 *
 *   1. `getReadTimeoutMs()` returns the expected 30 000 ms default.
 *   2. `getTotalTimeoutMs()` returns the expected 120 000 ms default.
 *   3. Both functions respect env overrides (they can be shortened in tests).
 *   4. Neither function returns 0 by default (which would disable the guard).
 *   5. The default per-chunk timeout is at most 60 000 ms (catching if someone
 *      accidentally doubled it to 60 s, which would make stall tests ~2× slower
 *      and the guard less effective).
 *   6. The default total timeout is at least 60 000 ms (the minimum meaningful
 *      slow-drip guard for a 25 MiB upload at any reasonable bandwidth).
 *
 * This set of assertions is the "early warning" that fires on every PR: if
 * someone changes the defaults, CI catches it in seconds rather than after
 * the code ships to main and the 13-minute meta-test runs.
 */
import { describe, it, expect, afterEach } from "vitest";

const savedEnv: Record<string, string | undefined> = {};

function saveAndSet(key: string, value: string | undefined): void {
  savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const key of Object.keys(savedEnv)) delete savedEnv[key];
}

afterEach(restoreEnv);

// Import AFTER mocks so env overrides in each test take effect.
// Both functions read process.env directly on every call — no module reset needed.
import {
  getReadTimeoutMs,
  getTotalTimeoutMs,
} from "@/lib/upload-read-stream";

describe("stall guard defaults — PR regression guard (Task #660)", () => {
  // ── Default values (no env set) ────────────────────────────────────────────

  it("getReadTimeoutMs() returns 30 000 ms (30 s) by default", () => {
    saveAndSet("UPLOAD_READ_TIMEOUT_MS", undefined);
    expect(getReadTimeoutMs()).toBe(30_000);
  });

  it("getTotalTimeoutMs() returns 120 000 ms (2 min) by default", () => {
    saveAndSet("UPLOAD_TOTAL_TIMEOUT_MS", undefined);
    expect(getTotalTimeoutMs()).toBe(120_000);
  });

  it("getReadTimeoutMs() default is not 0 (a zero timeout disables the per-chunk guard)", () => {
    saveAndSet("UPLOAD_READ_TIMEOUT_MS", undefined);
    expect(getReadTimeoutMs()).toBeGreaterThan(0);
  });

  it("getTotalTimeoutMs() default is not 0 (a zero timeout disables the slow-drip guard)", () => {
    saveAndSet("UPLOAD_TOTAL_TIMEOUT_MS", undefined);
    expect(getTotalTimeoutMs()).toBeGreaterThan(0);
  });

  // ── Bounds: catch accidental changes in either direction ──────────────────

  it("getReadTimeoutMs() default is at most 60 000 ms (60 s)", () => {
    // If someone doubles the default to 60 s, stall tests take twice as long
    // and the guard is less sensitive.
    saveAndSet("UPLOAD_READ_TIMEOUT_MS", undefined);
    expect(getReadTimeoutMs()).toBeLessThanOrEqual(60_000);
  });

  it("getTotalTimeoutMs() default is at least 60 000 ms (1 min)", () => {
    // A total timeout below 60 s would be too tight for a real 25 MiB upload
    // at realistic bandwidth and would cause spurious 408s in production.
    saveAndSet("UPLOAD_TOTAL_TIMEOUT_MS", undefined);
    expect(getTotalTimeoutMs()).toBeGreaterThanOrEqual(60_000);
  });

  it("getTotalTimeoutMs() default is greater than getReadTimeoutMs() default", () => {
    // The total deadline must exceed the per-chunk deadline, otherwise the total
    // guard fires on the very first chunk (defeating its purpose).
    saveAndSet("UPLOAD_READ_TIMEOUT_MS", undefined);
    saveAndSet("UPLOAD_TOTAL_TIMEOUT_MS", undefined);
    expect(getTotalTimeoutMs()).toBeGreaterThan(getReadTimeoutMs());
  });

  // ── Env overrides ──────────────────────────────────────────────────────────

  it("UPLOAD_READ_TIMEOUT_MS env overrides the per-chunk deadline", () => {
    saveAndSet("UPLOAD_READ_TIMEOUT_MS", "300");
    expect(getReadTimeoutMs()).toBe(300);
  });

  it("UPLOAD_TOTAL_TIMEOUT_MS env overrides the total-wall-clock deadline", () => {
    saveAndSet("UPLOAD_TOTAL_TIMEOUT_MS", "1200");
    expect(getTotalTimeoutMs()).toBe(1_200);
  });
});
