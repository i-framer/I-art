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
const path = require("node:path");
/* eslint-enable @typescript-eslint/no-require-imports */

const VITEST_ARGS = [
  "run",
  "--config",
  "vitest.integration.config.ts",
  "--reporter=default",
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

function runVitest(vitestBin, args) {
  const result = spawnSync(vitestBin, args, {
    stdio: "inherit",
  });

  if (result.error) {
    process.stderr.write(`Failed to start Vitest: ${result.error.message}\n`);
    return 1;
  }

  return result.status ?? 1;
}

function run() {
  const vitestBin = path.resolve(
    __dirname,
    `../node_modules/.bin/vitest${process.platform === "win32" ? ".cmd" : ""}`
  );
  const extraArgs = process.argv.slice(2);
  const runs = extraArgs.length
    ? [buildVitestArgs(extraArgs)]
    : buildFullSuiteRuns();

  for (const args of runs) {
    const status = runVitest(vitestBin, args);
    if (status !== 0) {
      process.exit(status);
    }
  }
}

if (require.main === module) {
  run();
}

module.exports = {
  buildFullSuiteRuns,
  buildVitestArgs,
  SHARED_DATABASE_STATE_FILES,
};