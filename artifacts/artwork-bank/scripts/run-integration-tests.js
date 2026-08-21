/**
 * Run the PostgreSQL-backed Vitest suite.
 *
 * Keeping this in a Node script instead of chaining Vitest directly in the
 * package command makes pnpm's extra arguments unambiguous: every argument
 * after `pnpm test:integration --` is forwarded to Vitest as a file filter
 * (or another Vitest option), while no arguments preserves the full suite.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const { spawnSync } = require("node:child_process");
const { readFileSync, unlinkSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
/* eslint-enable @typescript-eslint/no-require-imports */

// Replit's validation command limit is five minutes. Four minutes gives the
// database pre-flight and CI overhead a full minute of headroom, while still
// making a gradual integration-suite regression visible well before an outer
// timeout turns the result into an unreliable failure.
const PLATFORM_COMMAND_LIMIT_MS = 5 * 60 * 1_000;
const DEFAULT_FULL_SUITE_DURATION_BUDGET_MS = 4 * 60 * 1_000;
const FULL_SUITE_PHASE_NAMES = [
  "parallel test files",
  "shared database-state test files",
];

const VITEST_ARGS = [
  "run",
  "--config",
  "vitest.integration.config.ts",
];

// These checks deliberately inspect database-wide queues or totals. Run them
// one at a time so fixtures created by another integration file cannot become
// candidates while an assertion is in progress. Every other file retains the
// bounded parallel worker pool configured in Vitest.
const SHARED_DATABASE_STATE_FILES = [
  "__tests__/billing-alert-corrupted-eventtype-integration.test.ts",
  "__tests__/billing-alert-slack-banner-clear-integration.test.ts",
  "__tests__/billing-alert-slack-replay-integration.test.ts",
  "__tests__/email-sweep-route-integration.test.ts",
  "__tests__/iframer-slack-integration.test.ts",
  "__tests__/iframer-slack-replay-clear-integration.test.ts",
  "__tests__/iframer-slack-replay-integration.test.ts",
  "__tests__/no-contact-banner-count-mid-sweep-integration.test.ts",
  "__tests__/orphan-image-sweep-integration.test.ts",
  "__tests__/platform-admin-replay-slack-alerts-integration.test.ts",
  "__tests__/platform-admin-billing-state-filter-integration.test.ts",
  "__tests__/platform-billing-alert-slack-replay-clears-flag-integration.test.ts",
  "__tests__/platform-billing-alerts-panel-checkout-integration.test.ts",
  "__tests__/platform-replay-slack-alerts-integration.test.ts",
  "__tests__/reservation-sweep-integration.test.ts",
  "__tests__/slack-replay-route-integration.test.ts",
  "__tests__/sweep-self-heal-stuck-nonces-integration.test.ts",
];

function buildVitestArgs(extraArgs) {
  // pnpm preserves the separator used in
  // `pnpm test:integration -- __tests__/selected-integration.test.ts`.
  // It is a package-manager delimiter, not a Vitest argument; forwarding it
  // would make Vitest disregard the subsequent file filters.
  const forwardedArgs = extraArgs[0] === "--" ? extraArgs.slice(1) : extraArgs;
  return [...VITEST_ARGS, ...forwardedArgs];
}

function buildFullSuiteRuns() {
  const baseArgs = buildVitestArgs([]);

  return [
    [
      ...baseArgs,
      ...SHARED_DATABASE_STATE_FILES.flatMap((file) => ["--exclude", file]),
    ],
    [
      ...baseArgs,
      "--no-file-parallelism",
      ...SHARED_DATABASE_STATE_FILES,
    ],
  ];
}

function getFullSuiteDurationBudgetMs(value = process.env.INTEGRATION_DURATION_BUDGET_MS) {
  if (value === undefined) {
    return DEFAULT_FULL_SUITE_DURATION_BUDGET_MS;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed >= PLATFORM_COMMAND_LIMIT_MS) {
    throw new Error(
      "INTEGRATION_DURATION_BUDGET_MS must be a positive whole number below " +
        `${PLATFORM_COMMAND_LIMIT_MS} ms (the platform command limit).`
    );
  }

  return parsed;
}

function formatDuration(durationMs) {
  return `${(durationMs / 1_000).toFixed(durationMs >= 10_000 ? 1 : 2)}s`;
}

function getTimingReportPath(phaseIndex) {
  return path.join(
    os.tmpdir(),
    `artwork-bank-integration-timing-${process.pid}-${phaseIndex}.json`
  );
}

function readTimingReport(timingReportPath) {
  try {
    const report = JSON.parse(readFileSync(timingReportPath, "utf8"));
    if (!Array.isArray(report.files)) {
      throw new Error("the report has no files array");
    }

    return report;
  } catch (error) {
    process.stderr.write(
      `[integration timing] Could not read file timing diagnostics: ${error.message}\n`
    );
    return null;
  } finally {
    try {
      unlinkSync(timingReportPath);
    } catch {
      // Vitest can fail before the reporter initializes. The warning above is
      // enough context in that case, and there is no generated file to clean.
    }
  }
}

function printPhaseTiming(phaseName, wallClockMs, report) {
  process.stdout.write(
    `\n[integration timing] ${phaseName}: ${formatDuration(wallClockMs)} wall time\n`
  );

  if (!report) {
    return;
  }

  const files = report.files;
  const sum = (field) =>
    files.reduce((total, file) => total + (Number(file[field]) || 0), 0);
  const workerSetupMs = sum("workerSetupMs");
  const importAndCollectionMs = sum("importAndCollectionMs");
  const testAndHookMs = sum("testAndHookMs");
  process.stdout.write(
    `[integration timing] Worker setup: ${formatDuration(workerSetupMs)} ` +
      `(summed across ${files.length} files); module imports/collection: ` +
      `${formatDuration(importAndCollectionMs)}; tests/hooks: ` +
      `${formatDuration(testAndHookMs)}.\n`
  );

  const slowestFiles = [...files]
    .sort(
      (left, right) =>
        right.testAndHookMs +
        right.importAndCollectionMs -
        (left.testAndHookMs + left.importAndCollectionMs)
    )
    .slice(0, 5);

  if (slowestFiles.length) {
    process.stdout.write("[integration timing] Slowest test files:\n");
    for (const file of slowestFiles) {
      process.stdout.write(
        `  ${formatDuration(file.testAndHookMs + file.importAndCollectionMs)} ` +
          `(tests/hooks ${formatDuration(file.testAndHookMs)}, ` +
          `imports ${formatDuration(file.importAndCollectionMs)}, ` +
          `worker setup ${formatDuration(file.workerSetupMs)}) ${file.file}\n`
      );
    }
  }
}

function runVitest(vitestBin, args, timingReportPath) {
  const startedAt = performance.now();
  const result = spawnSync(vitestBin, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      INTEGRATION_TIMING_REPORT_PATH: timingReportPath,
    },
  });
  const wallClockMs = performance.now() - startedAt;

  if (result.error) {
    process.stderr.write(`Failed to start Vitest: ${result.error.message}\n`);
    return { status: 1, wallClockMs };
  }

  return { status: result.status ?? 1, wallClockMs };
}

function run() {
  const vitestBin = path.resolve(
    __dirname,
    `../node_modules/.bin/vitest${process.platform === "win32" ? ".cmd" : ""}`
  );
  const extraArgs = process.argv.slice(2);
  const isFullSuite = extraArgs.length === 0;
  const runs = isFullSuite
    ? buildFullSuiteRuns()
    : [buildVitestArgs(extraArgs)];
  const durationBudgetMs = isFullSuite ? getFullSuiteDurationBudgetMs() : null;
  const startedAt = performance.now();
  let status = 0;

  for (const [phaseIndex, args] of runs.entries()) {
    const timingReportPath = getTimingReportPath(phaseIndex);
    const result = runVitest(vitestBin, args, timingReportPath);
    const phaseName = isFullSuite
      ? FULL_SUITE_PHASE_NAMES[phaseIndex]
      : "selected test files";
    printPhaseTiming(
      phaseName,
      result.wallClockMs,
      readTimingReport(timingReportPath)
    );

    if (result.status !== 0) {
      status = result.status;
      break;
    }
  }

  const totalDurationMs = performance.now() - startedAt;
  if (isFullSuite) {
    process.stdout.write(
      `\n[integration timing] Full suite: ${formatDuration(totalDurationMs)} ` +
        `of ${formatDuration(durationBudgetMs)} budget.\n`
    );
    if (totalDurationMs > durationBudgetMs) {
      process.stderr.write(
        "\nERROR: The full integration suite exceeded its duration budget. " +
          `It took ${formatDuration(totalDurationMs)}; the budget is ` +
          `${formatDuration(durationBudgetMs)} to leave headroom below the ` +
          `${formatDuration(PLATFORM_COMMAND_LIMIT_MS)} platform command limit.\n` +
          "Use the phase, worker setup, import, and slow-file timings above " +
          "to locate the regression before increasing this budget.\n"
      );
      status = 1;
    }
  }

  return status;
}

if (require.main === module) {
  process.exitCode = run();
}

module.exports = {
  DEFAULT_FULL_SUITE_DURATION_BUDGET_MS,
  FULL_SUITE_PHASE_NAMES,
  PLATFORM_COMMAND_LIMIT_MS,
  buildFullSuiteRuns,
  buildVitestArgs,
  formatDuration,
  getFullSuiteDurationBudgetMs,
  SHARED_DATABASE_STATE_FILES,
};