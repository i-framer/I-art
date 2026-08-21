/**
 * Regression checks for the focused database integration-test command.
 *
 * Supported usage:
 *   pnpm test:integration
 *   pnpm test:integration -- __tests__/one-integration.test.ts
 *   pnpm test:integration -- __tests__/one-integration.test.ts __tests__/two-integration.test.ts
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_FULL_SUITE_DURATION_BUDGET_MS,
  FULL_SUITE_PHASE_NAMES,
  PLATFORM_COMMAND_LIMIT_MS,
  buildFullSuiteRuns,
  buildVitestArgs,
  formatDuration,
  getFullSuiteDurationBudgetMs,
  SHARED_DATABASE_STATE_FILES,
} from "../scripts/run-integration-tests.js";

const VITEST_PREFIX = [
  "run",
  "--config",
  "vitest.integration.config.ts",
];

describe("focused integration-test command", () => {
  it("runs the full configured integration suite when no filters are supplied", () => {
    expect(buildVitestArgs([])).toEqual(VITEST_PREFIX);
  });

  it("forwards one or more file filters after pnpm's separator to Vitest", () => {
    const filters = [
      "__tests__/checkout-invalid-inputs-integration.test.ts",
      "__tests__/storage-upload-route-integration.test.ts",
    ];

    expect(buildVitestArgs(["--", ...filters])).toEqual([
      ...VITEST_PREFIX,
      ...filters,
    ]);
  });

  it("runs global database-state assertions in a serial phase", () => {
    const [parallelRun, serialRun] = buildFullSuiteRuns();

    expect(parallelRun).toEqual([
      ...VITEST_PREFIX,
      ...SHARED_DATABASE_STATE_FILES.flatMap((file) => ["--exclude", file]),
    ]);
    expect(serialRun).toEqual([
      ...VITEST_PREFIX,
      "--no-file-parallelism",
      ...SHARED_DATABASE_STATE_FILES,
    ]);
  });

  it("keeps the full suite's budget below the platform command limit", () => {
    expect(DEFAULT_FULL_SUITE_DURATION_BUDGET_MS).toBe(240_000);
    expect(DEFAULT_FULL_SUITE_DURATION_BUDGET_MS).toBeLessThan(
      PLATFORM_COMMAND_LIMIT_MS
    );
    expect(FULL_SUITE_PHASE_NAMES).toEqual([
      "parallel test files",
      "shared database-state test files",
    ]);
  });

  it("allows an explicit full-suite budget override only below the command limit", () => {
    expect(getFullSuiteDurationBudgetMs("180000")).toBe(180_000);
    expect(() => getFullSuiteDurationBudgetMs("300000")).toThrow(
      "below 300000 ms"
    );
    expect(() => getFullSuiteDurationBudgetMs("not-a-number")).toThrow(
      "positive whole number"
    );
  });

  it("formats phase timings for the command output", () => {
    expect(formatDuration(9_876)).toBe("9.88s");
    expect(formatDuration(12_345)).toBe("12.3s");
  });
});