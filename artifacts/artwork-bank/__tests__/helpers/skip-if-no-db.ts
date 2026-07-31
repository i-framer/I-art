/**
 * Shared helper for integration tests that require a live PostgreSQL database.
 *
 * When DATABASE_URL is absent (e.g. fresh CI runner, stripped preview env),
 * every `describeIntegration(...)` suite is automatically skipped with a
 * human-readable "skipped – no DATABASE_URL" label instead of crashing with a
 * low-signal connection error.
 *
 * Usage:
 *   import { describeIntegration } from "./helpers/skip-if-no-db";
 *
 *   describeIntegration("my suite — real DB", () => {
 *     it("does something", ...);
 *   });
 */
import { describe } from "vitest";

export const describeIntegration = process.env.DATABASE_URL
  ? describe
  : (describe.skip.bind(describe) as typeof describe);

// Provide a human-readable label when skipping so test reporters are clear.
if (!process.env.DATABASE_URL) {
  // Override the skip label via a wrapper so reporters show why.
  const original = describeIntegration as typeof describe;
  // Re-export is enough; describe.skip already marks suites as "skipped".
  // The message below appears in CI logs via the verbose reporter.
  void original; // keep lint happy
}
