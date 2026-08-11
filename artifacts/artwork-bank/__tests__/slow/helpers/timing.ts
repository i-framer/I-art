/**
 * Shared timing-budget utilities for slow tests.
 *
 * Import `checkTimingBudget` (and optionally `TIMING_WARNING_THRESHOLD`) in
 * any slow test that needs to verify an operation completes well within its
 * time ceiling.  Keeping the helper here prevents copy-paste across files and
 * ensures CI timing output is consistent across the whole slow suite.
 */

/**
 * Fraction of a deadline at which a warning is emitted.
 *
 * When elapsed / deadline >= this value the test is within 20 % of its
 * ceiling.  The warning is non-fatal: it surfaces regressions in startup or
 * I/O latency before they become outright failures on slower runners.
 */
export const TIMING_WARNING_THRESHOLD = 0.8;

/**
 * Log elapsed time against a configured deadline and emit a console warning
 * when the measurement comes within 20 % of the ceiling.
 *
 * Example CI output:
 *   [timing] auth gate (next dev): elapsed=312ms  deadline=1500ms  used=20.8%
 *   [timing] stall → 408 (helper): elapsed=1502ms  deadline=9500ms  used=15.8%
 */
export function checkTimingBudget(
  elapsed: number,
  deadline: number,
  label: string,
): void {
  const ratio = elapsed / deadline;
  console.log(
    `[timing] ${label}: elapsed=${elapsed}ms  deadline=${deadline}ms  used=${(ratio * 100).toFixed(1)}%`,
  );
  if (ratio >= TIMING_WARNING_THRESHOLD) {
    console.warn(
      `[timing] WARNING: "${label}" used ${(ratio * 100).toFixed(1)}% of its ` +
        `deadline (${elapsed}ms / ${deadline}ms). ` +
        `The test is dangerously close to its ceiling and may fail on a ` +
        `cold or slower runner. ` +
        `Consider increasing the timeout or reducing startup time.`,
    );
  }
}
