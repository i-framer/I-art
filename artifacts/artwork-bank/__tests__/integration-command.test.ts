/**
 * Regression checks for the focused database integration-test command.
 *
 * Supported usage:
 *   pnpm test:integration
 *   pnpm test:integration -- __tests__/one-integration.test.ts
 *   pnpm test:integration -- __tests__/one-integration.test.ts __tests__/two-integration.test.ts
 */

import { describe, expect, it } from "vitest";
import { buildVitestArgs } from "../scripts/run-integration-tests.js";

const VITEST_PREFIX = [
  "run",
  "--config",
  "vitest.integration.config.ts",
  "--no-file-parallelism",
  "--reporter=verbose",
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
});