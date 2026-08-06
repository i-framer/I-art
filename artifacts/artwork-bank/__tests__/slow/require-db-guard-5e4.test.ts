/**
 * Slow-test suite: 5e4 (50 000 ms) timeout boundary for scripts/require-db.js
 *
 * These tests verify that when REQUIRE_DB_PSQL_TIMEOUT_MS is set to the
 * scientific-notation string '5e4' (Number("5e4") === 50000), the guard passes
 * exactly 50 000 ms to spawnSync — not some other order of magnitude.
 *
 * Each test strands a fake psql 200 ms either side of the boundary:
 *
 *   49 800 ms sleep → completes before deadline → guard exits 0
 *   50 200 ms sleep → crosses deadline           → guard exits 1 with 'timed out'
 *
 * The two tests together take ~100 s of real wall-clock time, which makes them
 * unsuitable for the default `pnpm test` run (which must finish in seconds on
 * every save).  They live here instead and run via `pnpm test:slow` in a
 * dedicated CI slot.
 *
 * The 1e3 and 1e4 boundary tests (which take at most ~20 s total) remain in the
 * main require-db-guard.test.ts file under the same describe label.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(__dirname, "../../scripts/require-db.js");

/** Build a temp directory containing a fake `psql` with the given behaviour. */
function makeFakePsqlDir(script: string): string {
  const dir = path.join(
    tmpdir(),
    `fake-psql-${process.pid}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "psql"), `#!/bin/sh\n${script}\n`, {
    mode: 0o755,
  });
  return dir;
}

/** Run require-db.js with the supplied extra env vars merged in. */
function runGuard(
  extraEnv: Record<string, string | undefined>
): ReturnType<typeof spawnSync> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  return spawnSync(process.execPath, [SCRIPT], { env, encoding: "utf8" });
}

// ──────────────────────────────────────────────────────────────────────────────

describe("require-db.js — scientific-notation timeout values reach spawnSync with the correct ms value", () => {
  // ── '5e4' = 50000 ms ─────────────────────────────────────────────────────
  //
  // These tests are separated into this slow-test suite because each one
  // requires ~50 s of real wall-clock time.  See the file-level comment for
  // context.  The 1e3 and 1e4 boundary tests live in the sibling unit-test
  // file (require-db-guard.test.ts) and are fast enough for the normal run.

  it("exits 1 with 'timed out' when REQUIRE_DB_PSQL_TIMEOUT_MS is '5e4' and psql sleeps 50200 ms (just over 50000 ms)", () => {
    // If spawnSync received 50000 ms as the timeout, a 50200 ms sleep must
    // trigger ETIMEDOUT and cause the guard to exit 1 with 'timed out'.
    const fakeBinDir = makeFakePsqlDir("sleep 50.2");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/testdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "5e4",
    });

    expect(result.status).toBe(1);
    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toMatch(/timed out/i);
  }, 55_000);

  it("exits 0 and prints 'dev database confirmed' when REQUIRE_DB_PSQL_TIMEOUT_MS is '5e4' and psql sleeps 49800 ms (just under 50000 ms)", () => {
    // If spawnSync received 50000 ms as the timeout, a 49800 ms sleep must
    // complete before the deadline and allow the guard to exit 0.
    const fakeBinDir = makeFakePsqlDir("sleep 49.8");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "5e4",
    });

    expect(result.status).toBe(0);
    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toContain("dev database confirmed");
  }, 55_000);
});
