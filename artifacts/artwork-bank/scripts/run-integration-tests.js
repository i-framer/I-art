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
  "--no-file-parallelism",
  "--reporter=verbose",
];

function buildVitestArgs(extraArgs) {
  // pnpm preserves the separator used in
  // `pnpm test:integration -- __tests__/selected-integration.test.ts`.
  // It is a package-manager delimiter, not a Vitest argument; forwarding it
  // would make Vitest disregard the subsequent file filters.
  const forwardedArgs = extraArgs[0] === "--" ? extraArgs.slice(1) : extraArgs;
  return [...VITEST_ARGS, ...forwardedArgs];
}

function run() {
  const vitestBin = path.resolve(
    __dirname,
    `../node_modules/.bin/vitest${process.platform === "win32" ? ".cmd" : ""}`
  );
  const result = spawnSync(vitestBin, buildVitestArgs(process.argv.slice(2)), {
    stdio: "inherit",
  });

  if (result.error) {
    process.stderr.write(`Failed to start Vitest: ${result.error.message}\n`);
    process.exit(1);
  }

  process.exit(result.status ?? 1);
}

if (require.main === module) {
  run();
}

module.exports = { buildVitestArgs };