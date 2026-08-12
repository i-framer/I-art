/**
 * Task #670 — Confirm the stall-guard meta-test still catches a regression
 * when dispatched with a custom threshold.
 *
 * Context
 * ───────
 * `scripts/meta-test-stall-guard.sh` is the script run by the
 * `stall-guard-meta-test` job in `.github/workflows/slow-tests.yml`.  The job
 * can be triggered via `workflow_dispatch` with an optional
 * `startup_threshold_s` input, which allows operators to tune the next-dev
 * startup budget without a code change.
 *
 * The script's logic is:
 *   1. Run `probe:nextdev-startup` with PROBE_RETAIN_CACHE=1 and the custom
 *      NEXTDEV_STARTUP_THRESHOLD_S value.
 *   2. Verify the warm-cache sentinel was written.
 *   3. Run `test:slow` with UPLOAD_READ_TIMEOUT_MS=1 (the injected regression).
 *   4. Assert the suite exits non-zero.
 *   5. Assert the output contains "toBeGreaterThanOrEqual" (the expected
 *      failing assertion — distinguishing the targeted stall regression from
 *      an unrelated failure).
 *
 * The concern: if a future edit adds the custom threshold only to the probe
 * step but forgets to forward it to `test:slow`, the stall guard injection
 * (`UPLOAD_READ_TIMEOUT_MS=1`) would still work — but NEXTDEV_STARTUP_THRESHOLD_S
 * would not be forwarded, causing next-dev to fail if the runner is slow.
 *
 * This file verifies the structural properties of the meta-test script
 * that must hold regardless of which custom threshold is passed.
 *
 * What this test verifies
 * ───────────────────────
 *  1. UPLOAD_READ_TIMEOUT_MS=1 is injected when running test:slow.
 *  2. NEXTDEV_STARTUP_THRESHOLD_S is read from env and forwarded to the probe.
 *  3. NEXTDEV_STARTUP_THRESHOLD_S is forwarded to test:slow as well.
 *  4. The script asserts a non-zero exit from test:slow (guard 1).
 *  5. The script checks for "toBeGreaterThanOrEqual" in the output (guard 2).
 *  6. The script exits 1 when test:slow exits 0 (broken guard path).
 *  7. The UPLOAD_READ_TIMEOUT_MS injection appears AFTER the probe step,
 *     not before (so the probe itself is not affected by the short timeout).
 *  8. The sentinel check uses the exact sentinel path expected by the workflow.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

// ── Load the meta-test script once ───────────────────────────────────────────

const SCRIPT_PATH = path.resolve(
  __dirname,
  "../../../scripts/meta-test-stall-guard.sh",
);

let scriptText: string;

try {
  scriptText = readFileSync(SCRIPT_PATH, "utf8");
} catch {
  throw new Error(`meta-test-stall-guard.sh not found at ${SCRIPT_PATH}`);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("stall-guard meta-test — custom threshold structural checks (Task #670)", () => {
  it("UPLOAD_READ_TIMEOUT_MS=1 is injected in the test:slow invocation", () => {
    // The regression injection must use exactly 1 ms — anything larger would
    // allow the stall guard to pass when it should fail.
    expect(scriptText).toContain("UPLOAD_READ_TIMEOUT_MS=1");
  });

  it("NEXTDEV_STARTUP_THRESHOLD_S is read from env with a default fallback", () => {
    // Pattern: NEXTDEV_STARTUP_THRESHOLD_S="${NEXTDEV_STARTUP_THRESHOLD_S:-90}"
    // or similar — must have a fallback so the script is safe to run standalone.
    expect(scriptText).toMatch(
      /NEXTDEV_STARTUP_THRESHOLD_S="\$\{NEXTDEV_STARTUP_THRESHOLD_S[^"]*\}"/,
    );
  });

  it("NEXTDEV_STARTUP_THRESHOLD_S is forwarded to the probe:nextdev-startup invocation", () => {
    // The probe step must receive the custom threshold so a slow runner with
    // startup_threshold_s=120 doesn't time out the probe unnecessarily.
    expect(scriptText).toContain("NEXTDEV_STARTUP_THRESHOLD_S=");
    // It must appear before (or alongside) the probe invocation.
    const probeIdx = scriptText.indexOf("probe:nextdev-startup");
    const thresholdIdx = scriptText.indexOf("NEXTDEV_STARTUP_THRESHOLD_S=");
    expect(probeIdx).toBeGreaterThan(-1);
    expect(thresholdIdx).toBeGreaterThan(-1);
    expect(thresholdIdx).toBeLessThan(probeIdx);
  });

  it("NEXTDEV_STARTUP_THRESHOLD_S is forwarded to the test:slow invocation", () => {
    // test:slow may also spawn next-dev (via warm-cache hand-off); the startup
    // threshold must be consistent between the probe and test:slow runs.
    // Use the specific pnpm invocation string (not comment lines) as the anchor.
    const testSlowCmdIdx = scriptText.indexOf(
      "pnpm --filter @workspace/artwork-bank run test:slow",
    );
    expect(testSlowCmdIdx).toBeGreaterThan(-1);
    // The NEXTDEV_STARTUP_THRESHOLD_S env prefix appears on the line immediately
    // before the pnpm command (within 300 chars).
    const window = scriptText.slice(Math.max(0, testSlowCmdIdx - 300), testSlowCmdIdx + 100);
    expect(window).toContain("NEXTDEV_STARTUP_THRESHOLD_S");
  });

  it("UPLOAD_READ_TIMEOUT_MS=1 injection appears AFTER the probe step (probe is not affected)", () => {
    // If the injection appeared before probe:nextdev-startup, the probe would
    // use a 1 ms read timeout and fail for the wrong reason.
    // Use the actual command form (env prefix with trailing space/backslash)
    // rather than the comment form which also contains "UPLOAD_READ_TIMEOUT_MS=1".
    const injectionIdx = scriptText.indexOf("UPLOAD_READ_TIMEOUT_MS=1 \\");
    const probeIdx = scriptText.indexOf("probe:nextdev-startup");
    expect(injectionIdx).toBeGreaterThan(-1);
    expect(probeIdx).toBeGreaterThan(-1);
    expect(injectionIdx).toBeGreaterThan(probeIdx);
  });

  it("script asserts test:slow exits non-zero (guard 1: suite must fail)", () => {
    // The meta-test must explicitly detect exit code 0 and treat it as failure.
    // Common patterns: `if [[ ... -eq 0 ]]; then ... exit 1` or similar.
    expect(scriptText).toMatch(/SLOW_EXIT.*-eq\s*0|exit.*0.*guard|suite.*exit.*0/i);
  });

  it("script checks for 'toBeGreaterThanOrEqual' in the test output (guard 2)", () => {
    // Guard 2 prevents an unrelated compile error or crash from masquerading
    // as a successful regression detection.
    expect(scriptText).toContain("toBeGreaterThanOrEqual");
  });

  it("script exits 1 when the targeted assertion pattern is not found", () => {
    // The EXPECTED_PATTERN variable assignment and subsequent grep check must
    // be followed by an `exit 1` so the meta-test fails when an unrelated
    // error caused test:slow to exit non-zero.
    // Use the variable assignment line (only in command code, not comments)
    // as the anchor.
    const assignmentIdx = scriptText.indexOf('EXPECTED_PATTERN="toBeGreaterThanOrEqual"');
    expect(assignmentIdx).toBeGreaterThan(-1);
    const windowAfter = scriptText.slice(assignmentIdx, assignmentIdx + 700);
    expect(windowAfter).toMatch(/exit\s+1/);
  });

  it("sentinel path matches the path expected by the workflow YAML", () => {
    // The sentinel must be at the same path checked by the 'Assert warm-cache
    // sentinel exists' step in slow-tests.yml.
    expect(scriptText).toContain("artifacts/artwork-bank/.next-probe-cache-ready");
  });

  it("script has a fallback default of 90 for NEXTDEV_STARTUP_THRESHOLD_S", () => {
    // Default must be 90 s to match the workflow default in slow-tests.yml.
    expect(scriptText).toMatch(/NEXTDEV_STARTUP_THRESHOLD_S[^#\n]*:-90/);
  });
});
