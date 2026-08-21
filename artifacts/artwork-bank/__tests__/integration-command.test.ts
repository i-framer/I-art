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
  buildFullSuiteRuns,
  buildVitestArgs,
  SHARED_DATABASE_STATE_FILES,
} from "../scripts/run-integration-tests.js";

const VITEST_PREFIX = [
  "run",
  "--config",
  "vitest.integration.config.ts",
  "--reporter=default",
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
});