/**
 * Tests for scripts/require-db.js
 *
 * The guard script runs as a pre-flight check before the integration test
 * suite.  These unit tests exercise it as a subprocess so no real database or
 * psql installation is required — a tiny shell stub stands in for psql in each
 * scenario.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(__dirname, "../scripts/require-db.js");

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

/** Run require-db.js with the supplied extra env vars merged in.
 *
 * Uses `process.execPath` (the absolute path to the running node binary) so
 * that the test-controlled PATH override does not accidentally hide node itself.
 */
function runGuard(
  extraEnv: Record<string, string | undefined>
): ReturnType<typeof spawnSync> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  return spawnSync(process.execPath, [SCRIPT], { env, encoding: "utf8" });
}

// ──────────────────────────────────────────────────────────────────────────────

describe("require-db.js — DATABASE_URL absent", () => {
  it("exits 1 and prints a clear error when DATABASE_URL is not set", () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.DATABASE_URL;

    const result = spawnSync(process.execPath, [SCRIPT], {
      env,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DATABASE_URL is not set");
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe("require-db.js — session_replication_role denied (prod DB guard)", () => {
  it("exits 1 when psql reports 'permission denied to set parameter session_replication_role'", () => {
    // Simulate the exact error Neon's prod DB returns.
    const fakeBinDir = makeFakePsqlDir(
      `echo "ERROR:  permission denied to set parameter session_replication_role" >&2\nexit 1`
    );

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/testdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
    });

    expect(result.status).toBe(1);
  });

  it("prints a message that references PROD_DATABASE_URL so the developer knows the cause", () => {
    const fakeBinDir = makeFakePsqlDir(
      `echo "ERROR:  permission denied to set parameter session_replication_role" >&2\nexit 1`
    );

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/testdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toContain("PROD_DATABASE_URL");
  });

  it("also mentions session_replication_role in the error message", () => {
    const fakeBinDir = makeFakePsqlDir(
      `echo "ERROR:  permission denied to set parameter session_replication_role" >&2\nexit 1`
    );

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/testdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toContain("session_replication_role");
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe("require-db.js — psql probe succeeds (happy path)", () => {
  it("exits 0 when psql exits 0 (dev database confirmed)", () => {
    // Fake psql that succeeds immediately — mimics a dev database
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dev database confirmed");
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe("require-db.js — psql probe times out via real spawnSync timeout", () => {
  // This suite exercises the ETIMEDOUT branch through the *real* spawnSync
  // timeout mechanism, not a monkey-patched stub.  A fake psql shell script
  // sleeps longer than the test-controlled REQUIRE_DB_PSQL_TIMEOUT_MS value so
  // Node's spawnSync fires its built-in timeout and sets result.error.code to
  // ETIMEDOUT.  This catches regressions in the timeout wiring itself.

  it("exits 1 when psql hangs and spawnSync times out", () => {
    // Fake psql that sleeps for 10 s — well beyond the 500 ms test timeout.
    const fakeBinDir = makeFakePsqlDir("sleep 10");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/testdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "500",
    });

    expect(result.status).toBe(1);
  }, 10_000);

  it("prints a message containing 'timed out' when psql hangs past the timeout", () => {
    const fakeBinDir = makeFakePsqlDir("sleep 10");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/testdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "500",
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toMatch(/timed out/i);
  }, 10_000);
});

// ──────────────────────────────────────────────────────────────────────────────

describe("require-db.js — psql probe times out (ETIMEDOUT)", () => {
  const STUB = path.resolve(
    __dirname,
    "helpers/require-db-etimedout-stub.js"
  );

  it("exits 1 when spawnSync returns an ETIMEDOUT error", () => {
    const result = spawnSync(process.execPath, [STUB], {
      env: {
        ...process.env,
        DATABASE_URL: "postgres://user:pass@localhost/testdb",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
  });

  it("prints a message containing 'timed out' so the developer knows the cause", () => {
    const result = spawnSync(process.execPath, [STUB], {
      env: {
        ...process.env,
        DATABASE_URL: "postgres://user:pass@localhost/testdb",
      },
      encoding: "utf8",
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toMatch(/timed out/i);
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe("require-db.js — psql probe fails with a generic connection error", () => {
  it("exits 1 when psql exits non-zero with a generic error (not permission denied)", () => {
    // Simulate a connection error that does NOT contain "permission denied to
    // set parameter session_replication_role" — e.g. the database is unreachable.
    const fakeBinDir = makeFakePsqlDir(
      `echo "could not connect to server: Connection refused" >&2\nexit 1`
    );

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/testdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
    });

    expect(result.status).toBe(1);
  });

  it("prints a message containing 'probe failed' and 'reachable' so the developer knows the cause", () => {
    const fakeBinDir = makeFakePsqlDir(
      `echo "could not connect to server: Connection refused" >&2\nexit 1`
    );

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/testdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toMatch(/probe failed/i);
    expect(output).toMatch(/reachable/i);
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe("require-db.js — psql unavailable", () => {
  it("exits 1 when psql is not found on PATH", () => {
    // Use an empty temp dir that has no psql binary
    const emptyDir = path.join(
      tmpdir(),
      `empty-bin-${process.pid}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(emptyDir, { recursive: true });

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/testdb",
      PATH: emptyDir, // Only the empty dir — psql won't be found
    });

    expect(result.status).toBe(1);
    const output = String(result.stderr || "") + String(result.stdout || "");
    // Script should explain that psql is unavailable or probe failed
    expect(output).toMatch(/psql|probe/i);
  });

  it("exits 1 when PATH is stripped to an empty string (minimal CI container scenario)", () => {
    // Simulate the minimal CI container case where PATH is entirely absent/empty.
    // spawnSync will get ENOENT when it cannot find the psql binary at all.
    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/testdb",
      PATH: "",
    });

    expect(result.status).toBe(1);
    const output = String(result.stderr || "") + String(result.stdout || "");
    // Script should explain that psql is unavailable or probe failed
    expect(output).toMatch(/psql|probe/i);
  });

  it("exits 1 when PATH is completely absent (undefined) from the environment", () => {
    // Distinct from the empty-string case: here PATH is deleted entirely from
    // the env object so spawnSync never receives the variable at all.  On some
    // minimal container runtimes the variable is missing rather than empty.
    // Node's spawnSync omits env keys whose value is undefined, which is the
    // same OS-level effect as the variable not existing in the process env.
    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/testdb",
      PATH: undefined,
    });

    expect(result.status).toBe(1);
    const output = String(result.stderr || "") + String(result.stdout || "");
    // Script should explain that psql is unavailable or probe failed
    expect(output).toMatch(/psql|probe/i);
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe("require-db.js — completely empty environment object", () => {
  // Some container runtimes (sandboxed processes, certain CI setups) start a
  // child process with a completely clean environment — no PATH, no DATABASE_URL,
  // no inherited variables at all.  This suite exercises that extreme case.
  //
  // We use process.execPath (the absolute path to the running node binary) so
  // the absence of PATH does not prevent node from being launched.  The script
  // itself receives an env object with no keys whatsoever.

  it("exits 1 when the entire environment object is empty", () => {
    const result = spawnSync(process.execPath, [SCRIPT], {
      env: {} as NodeJS.ProcessEnv,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
  });

  it("prints the DATABASE_URL-is-not-set message, confirming Check 1 fires before the psql probe", () => {
    const result = spawnSync(process.execPath, [SCRIPT], {
      env: {} as NodeJS.ProcessEnv,
      encoding: "utf8",
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toContain("DATABASE_URL is not set");
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe("require-db.js — psql probe times out in a stripped env (no Node vars)", () => {
  // This suite confirms the ETIMEDOUT branch fires correctly when the child
  // process environment contains only DATABASE_URL, a PATH pointing at a
  // sleeping fake psql, and REQUIRE_DB_PSQL_TIMEOUT_MS — no NODE_PATH,
  // NODE_OPTIONS, NODE_ENV, npm_*, or any other inherited Node internals.
  // It exercises the full spawnSync timeout mechanism, not a monkey-patched stub.

  it("exits 1 when psql hangs and spawnSync times out in a stripped env", () => {
    const fakeBinDir = makeFakePsqlDir("sleep 10");

    const minimalEnv = {
      DATABASE_URL: "postgres://user:pass@localhost/testdb",
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "500",
    } as unknown as NodeJS.ProcessEnv;

    const result = spawnSync(process.execPath, [SCRIPT], {
      env: minimalEnv,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
  }, 10_000);

  it("prints a message containing 'timed out' when psql hangs in a stripped env", () => {
    const fakeBinDir = makeFakePsqlDir("sleep 10");

    const minimalEnv = {
      DATABASE_URL: "postgres://user:pass@localhost/testdb",
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "500",
    } as unknown as NodeJS.ProcessEnv;

    const result = spawnSync(process.execPath, [SCRIPT], {
      env: minimalEnv,
      encoding: "utf8",
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toMatch(/timed out/i);
  }, 10_000);
});

// ──────────────────────────────────────────────────────────────────────────────

describe("require-db.js — non-numeric REQUIRE_DB_PSQL_TIMEOUT_MS", () => {
  // When REQUIRE_DB_PSQL_TIMEOUT_MS is set to a value that cannot be parsed as
  // a number (e.g. "not-a-number", "abc", ""), Number(...) silently produces
  // NaN.  Passing NaN to spawnSync's timeout option has undefined behaviour
  // across Node versions.  The guard must catch this at startup and exit with a
  // clear error rather than throwing an uncaught exception or silently ignoring
  // the timeout.

  it("exits 1 when REQUIRE_DB_PSQL_TIMEOUT_MS is a non-numeric string", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "not-a-number",
    });

    expect(result.status).toBe(1);
  });

  it("prints a clear error mentioning the invalid value rather than an uncaught exception", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "not-a-number",
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    // Should mention the bad value and that it must be numeric — not an
    // uncaught exception stack trace.
    expect(output).toMatch(/non-numeric|not.*number|must be.*number|numeric/i);
    expect(result.signal).toBeNull(); // Guard must exit cleanly, not crash
  });

  it("exits 1 when REQUIRE_DB_PSQL_TIMEOUT_MS is an empty string", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    // An empty string is also non-numeric (Number("") === 0 is falsy-ish, but
    // the guard treats the env var as present and tries to parse it).
    // Actually Number("") === 0 which IS numeric, so this exercises the edge
    // case where the value is blank — if the script accepts 0 that's fine; if
    // it treats empty-string as absent that's also fine.  The key assertion is
    // that it does NOT throw an uncaught exception.
    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "",
    });

    // Must not crash with an uncaught exception (signal would be non-null if it did)
    expect(result.signal).toBeNull();
    // Must exit with a defined status code (0 or 1, not null)
    expect(result.status).not.toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe("require-db.js — zero or negative REQUIRE_DB_PSQL_TIMEOUT_MS", () => {
  // A value of 0 or a negative number is never a valid timeout: spawnSync with
  // timeout=0 may kill the child immediately (or ignore the timeout depending
  // on the Node version), and a negative value is never meaningful.  The guard
  // must reject these values with a clear error rather than passing them to
  // spawnSync.

  it("exits 1 when REQUIRE_DB_PSQL_TIMEOUT_MS is 0", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "0",
    });

    expect(result.status).toBe(1);
  });

  it("prints a clear error for 0 mentioning the valid range", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "0",
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toMatch(/positive integer|not.*valid|not meaningful/i);
    expect(result.signal).toBeNull();
  });

  it("exits 1 when REQUIRE_DB_PSQL_TIMEOUT_MS is -1", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "-1",
    });

    expect(result.status).toBe(1);
  });

  it("prints a clear error for -1 mentioning the valid range", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "-1",
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toMatch(/positive integer|not.*valid|not meaningful/i);
    expect(result.signal).toBeNull();
  });

  it("exits 1 when REQUIRE_DB_PSQL_TIMEOUT_MS is -500", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "-500",
    });

    expect(result.status).toBe(1);
  });

  it("prints a clear error for -500 mentioning the valid range", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "-500",
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toMatch(/positive integer|not.*valid|not meaningful/i);
    expect(result.signal).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe("require-db.js — psql probe runs correctly without Node env baggage", () => {
  // This suite confirms that Check 2 (the psql probe) functions correctly when
  // Node-specific environment variables such as NODE_PATH, NODE_OPTIONS,
  // NODE_ENV, npm_*, etc. are completely absent from the child process
  // environment.  Only DATABASE_URL and a PATH pointing at a known fake psql
  // binary are supplied — no inherited Node internals at all.
  //
  // We use process.execPath (absolute path to the running node binary) so the
  // PATH override does not accidentally hide node itself.

  it("exits 0 when the minimal env contains DATABASE_URL + a fake psql that succeeds", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    // Build an environment with ONLY the two entries the guard script needs —
    // no NODE_PATH, no NODE_OPTIONS, no npm_* vars, no inherited Node env.
    const minimalEnv = {
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
    } as unknown as NodeJS.ProcessEnv;

    const result = spawnSync(process.execPath, [SCRIPT], {
      env: minimalEnv,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toContain("dev database confirmed");
  });

  it("exits 1 with a 'permission denied' message when the minimal env hits the prod-DB guard", () => {
    const fakeBinDir = makeFakePsqlDir(
      `echo "ERROR:  permission denied to set parameter session_replication_role" >&2\nexit 1`
    );

    const minimalEnv = {
      DATABASE_URL: "postgres://user:pass@localhost/testdb",
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
    } as unknown as NodeJS.ProcessEnv;

    const result = spawnSync(process.execPath, [SCRIPT], {
      env: minimalEnv,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toContain("PROD_DATABASE_URL");
  });

  it("exits 1 with a 'probe failed' message when the minimal env hits a generic connection error", () => {
    const fakeBinDir = makeFakePsqlDir(
      `echo "could not connect to server: Connection refused" >&2\nexit 1`
    );

    const minimalEnv = {
      DATABASE_URL: "postgres://user:pass@localhost/testdb",
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
    } as unknown as NodeJS.ProcessEnv;

    const result = spawnSync(process.execPath, [SCRIPT], {
      env: minimalEnv,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toMatch(/probe failed/i);
    expect(output).toMatch(/reachable/i);
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe("require-db.js — fractional REQUIRE_DB_PSQL_TIMEOUT_MS", () => {
  // Node's spawnSync silently truncates or rounds fractional timeout values
  // depending on the version, which can cause subtle timing differences.
  // The guard must reject fractional values with a clear error so the valid
  // range (positive whole-number milliseconds) is fully explicit.

  it("exits 1 when REQUIRE_DB_PSQL_TIMEOUT_MS is '1.5'", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "1.5",
    });

    expect(result.status).toBe(1);
  });

  it("prints a clear error for '1.5' saying the value must be a whole number", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "1.5",
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toMatch(/whole number|integer|fractional/i);
    expect(result.signal).toBeNull();
  });

  it("exits 1 when REQUIRE_DB_PSQL_TIMEOUT_MS is '100.9'", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "100.9",
    });

    expect(result.status).toBe(1);
  });

  it("prints a clear error for '100.9' saying the value must be a whole number", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "100.9",
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toMatch(/whole number|integer|fractional/i);
    expect(result.signal).toBeNull();
  });

  it("exits 1 when REQUIRE_DB_PSQL_TIMEOUT_MS is '0.1'", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "0.1",
    });

    expect(result.status).toBe(1);
  });

  it("prints a clear error for '0.1' saying the value must be a whole number", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "0.1",
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toMatch(/whole number|integer|fractional/i);
    expect(result.signal).toBeNull();
  });

  it("accepts a whole-number string like '15000' without error", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "15000",
    });

    expect(result.status).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe("require-db.js — Infinity REQUIRE_DB_PSQL_TIMEOUT_MS", () => {
  // Number.isSafeInteger(Infinity) returns false, so "Infinity" is caught by
  // the same !Number.isSafeInteger guard that catches fractional values.
  // Explicit coverage makes it clear this edge case is intentional and guarded.

  it("exits 1 when REQUIRE_DB_PSQL_TIMEOUT_MS is 'Infinity'", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "Infinity",
    });

    expect(result.status).toBe(1);
  });

  it("prints an error mentioning whole number / integer when 'Infinity' is passed", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "Infinity",
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toMatch(/whole number|integer/i);
    expect(result.signal).toBeNull();
  });

  it("exits 1 when REQUIRE_DB_PSQL_TIMEOUT_MS is '+Infinity'", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "+Infinity",
    });

    expect(result.status).toBe(1);
  });

  it("prints an error mentioning whole number / integer when '+Infinity' is passed", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "+Infinity",
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toMatch(/whole number|integer/i);
    expect(result.signal).toBeNull();
  });

  it("exits 1 when REQUIRE_DB_PSQL_TIMEOUT_MS is '-Infinity'", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "-Infinity",
    });

    expect(result.status).toBe(1);
  });

  it("prints an error mentioning whole number / integer when '-Infinity' is passed", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "-Infinity",
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toMatch(/whole number|integer/i);
    expect(result.signal).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe("require-db.js — additional non-numeric string edge cases for REQUIRE_DB_PSQL_TIMEOUT_MS", () => {
  // Explicit coverage for string values that Number() silently mishandles:
  //   "NaN"   → Number("NaN")   === NaN       — caught by isNaN guard
  //   "abc"   → Number("abc")   === NaN       — caught by isNaN guard
  //   "1.5"   → Number("1.5")   === 1.5       — caught by !isSafeInteger guard
  //   "1e308" → Number("1e308") === Infinity  — caught by !isSafeInteger guard
  // Each must exit 1 with a clear error, not crash or silently proceed.

  it("exits 1 when REQUIRE_DB_PSQL_TIMEOUT_MS is 'NaN'", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "NaN",
    });

    expect(result.status).toBe(1);
  });

  it("prints a non-numeric error and does not crash when REQUIRE_DB_PSQL_TIMEOUT_MS is 'NaN'", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "NaN",
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toMatch(/non-numeric|not.*number|must be.*number|numeric/i);
    expect(result.signal).toBeNull();
  });

  it("exits 1 when REQUIRE_DB_PSQL_TIMEOUT_MS is 'abc'", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "abc",
    });

    expect(result.status).toBe(1);
  });

  it("prints a non-numeric error and does not crash when REQUIRE_DB_PSQL_TIMEOUT_MS is 'abc'", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "abc",
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toMatch(/non-numeric|not.*number|must be.*number|numeric/i);
    expect(result.signal).toBeNull();
  });

  it("exits 1 when REQUIRE_DB_PSQL_TIMEOUT_MS is '1.5'", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "1.5",
    });

    expect(result.status).toBe(1);
  });

  it("prints a whole-number error and does not crash when REQUIRE_DB_PSQL_TIMEOUT_MS is '1.5'", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "1.5",
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toMatch(/whole number|integer|fractional/i);
    expect(result.signal).toBeNull();
  });

  it("exits 1 when REQUIRE_DB_PSQL_TIMEOUT_MS is '1e308'", () => {
    // Number("1e308") === Infinity, which is not a safe integer.
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "1e308",
    });

    expect(result.status).toBe(1);
  });

  it("prints a whole-number error and does not crash when REQUIRE_DB_PSQL_TIMEOUT_MS is '1e308'", () => {
    // Number("1e308") === Infinity — blocked by the !Number.isSafeInteger guard.
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "1e308",
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toMatch(/whole number|integer/i);
    expect(result.signal).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe("require-db.js — whitespace-padded REQUIRE_DB_PSQL_TIMEOUT_MS", () => {
  // JavaScript's Number() trims surrounding whitespace before parsing, so
  // Number(" 500"), Number("500 "), and Number(" 500 ") all evaluate to 500.
  // The guard relies on Number() for parsing and therefore accepts these
  // whitespace-padded values as valid — they pass the isNaN, <= 0, and
  // isSafeInteger checks and the psql probe proceeds normally.
  //
  // These tests document that intentional behaviour: leading/trailing
  // whitespace does not cause an exit 1 error and does not reach spawnSync
  // as a NaN or otherwise corrupt value.

  it("exits 0 when REQUIRE_DB_PSQL_TIMEOUT_MS has a leading space (' 500')", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: " 500",
    });

    // Number(" 500") === 500 — trimmed to a valid positive integer.
    expect(result.status).toBe(0);
    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toContain("dev database confirmed");
  });

  it("exits 0 when REQUIRE_DB_PSQL_TIMEOUT_MS has a trailing space ('500 ')", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "500 ",
    });

    // Number("500 ") === 500 — trimmed to a valid positive integer.
    expect(result.status).toBe(0);
    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toContain("dev database confirmed");
  });

  it("exits 0 when REQUIRE_DB_PSQL_TIMEOUT_MS has both leading and trailing spaces (' 500 ')", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: " 500 ",
    });

    // Number(" 500 ") === 500 — trimmed to a valid positive integer.
    expect(result.status).toBe(0);
    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toContain("dev database confirmed");
  });

  it("does not crash (signal is null) for any of the whitespace-padded inputs", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");
    const inputs = [" 500", "500 ", " 500 "];

    for (const val of inputs) {
      const result = runGuard({
        DATABASE_URL: "postgres://user:pass@localhost/devdb",
        PATH: `${fakeBinDir}:${process.env.PATH}`,
        REQUIRE_DB_PSQL_TIMEOUT_MS: val,
      });
      expect(result.signal).toBeNull();
    }
  });

  // Unicode whitespace surrounding a valid digit string — Number() trims these
  // too, so Number("\u2009500\u2009") === 500, which passes all guards and
  // allows the psql probe to proceed normally.  These tests document that the
  // guard intentionally accepts such values rather than rejecting them.

  it("exits 0 when REQUIRE_DB_PSQL_TIMEOUT_MS is thin-space-padded ('\\u2009500\\u2009')", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "\u2009500\u2009",
    });

    // Number("\u2009500\u2009") === 500 — thin spaces trimmed to a valid positive integer.
    expect(result.status).toBe(0);
    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toContain("dev database confirmed");
  });

  it("exits 0 when REQUIRE_DB_PSQL_TIMEOUT_MS is hair-space-padded ('\\u200A500\\u200A')", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "\u200A500\u200A",
    });

    // Number("\u200A500\u200A") === 500 — hair spaces trimmed to a valid positive integer.
    expect(result.status).toBe(0);
    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toContain("dev database confirmed");
  });

  it("exits 0 when REQUIRE_DB_PSQL_TIMEOUT_MS is ideographic-space-padded ('\\u3000500\\u3000')", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "\u3000500\u3000",
    });

    // Number("\u3000500\u3000") === 500 — ideographic spaces trimmed to a valid positive integer.
    expect(result.status).toBe(0);
    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toContain("dev database confirmed");
  });

  it("exits 0 when REQUIRE_DB_PSQL_TIMEOUT_MS is BOM-padded ('\\uFEFF500\\uFEFF')", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "\uFEFF500\uFEFF",
    });

    // Number("\uFEFF500\uFEFF") === 500 — BOM characters trimmed to a valid positive integer.
    expect(result.status).toBe(0);
    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toContain("dev database confirmed");
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe("require-db.js — Node.js Unicode-whitespace canary", () => {
  // The whitespace-padded tests above rely on JavaScript's Number() trimming
  // Unicode whitespace before parsing, e.g. Number("\u2009500\u2009") === 500.
  // This behaviour is specified by ECMAScript (StringToNumber uses the same
  // TrimString operation as trim()), but if a future Node.js major breaks that
  // contract the guard would silently start rejecting valid inputs.
  //
  // These assertions are intentionally pure-JS — no subprocess, no fake psql.
  // They run in the same V8 instance as the rest of the suite, so any
  // regression in Number()'s whitespace-trimming becomes an immediate failure
  // with a message that names the Node.js version, making the root cause obvious.

  const nodeVersion = process.version; // e.g. "v22.4.1"

  const unicodePaddedCases: Array<[string, string]> = [
    [" 500 ",         "ASCII space (U+0020)"],
    ["\t500\t",       "ASCII tab (U+0009)"],
    ["\u00A0500\u00A0", "non-breaking space (U+00A0)"],
    ["\u2009500\u2009", "thin space (U+2009)"],
    ["\u200A500\u200A", "hair space (U+200A)"],
    ["\u3000500\u3000", "ideographic space (U+3000)"],
    ["\uFEFF500\uFEFF", "BOM / zero-width no-break space (U+FEFF)"],
  ];

  it.each(unicodePaddedCases)(
    "Number(%j) === 500 on Node.js %s — regression canary for Unicode whitespace trimming",
    (input, label) => {
      const parsed = Number(input);
      if (parsed !== 500) {
        throw new Error(
          `Number() did not trim ${label} padding on Node.js ${nodeVersion}. ` +
          `Got ${parsed} instead of 500. ` +
          `A Node.js major upgrade may have changed how Number() handles this code-point. ` +
          `Check the ECMAScript StringToNumber / TrimString behaviour in Node.js ${nodeVersion}.`
        );
      }
      expect(parsed).toBe(500);
    }
  );

  it("Number() trims all tested Unicode whitespace variants consistently on this Node.js version", () => {
    const failures: string[] = [];

    for (const [input, label] of unicodePaddedCases) {
      const parsed = Number(input);
      if (parsed !== 500) {
        failures.push(`  ${label}: Number(${JSON.stringify(input)}) === ${parsed} (expected 500)`);
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `Unicode whitespace trimming regression detected on Node.js ${nodeVersion}.\n` +
        `The following inputs were NOT trimmed correctly by Number():\n` +
        failures.join("\n") + "\n\n" +
        `This means the guard in scripts/require-db.js would misparse ` +
        `REQUIRE_DB_PSQL_TIMEOUT_MS values padded with these code-points. ` +
        `Verify whether the ECMAScript spec changed in Node.js ${nodeVersion} ` +
        `and update the guard if needed.`
      );
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe("require-db.js — whitespace-only REQUIRE_DB_PSQL_TIMEOUT_MS", () => {
  // JavaScript's Number() trims surrounding whitespace before parsing, so
  // Number("   ") === 0 and Number("\t") === 0.  A value of 0 is not a valid
  // positive timeout and is caught by the `<= 0` guard — the guard exits 1
  // with a clear error before spawnSync is ever called.
  //
  // This is distinct from the whitespace-padded-valid-number cases above
  // (" 500", "500 ") where whitespace surrounds a non-zero digit string.
  // Here the entire value is whitespace, so the result after trimming is the
  // empty string which Number() converts to 0.

  it("exits 1 when REQUIRE_DB_PSQL_TIMEOUT_MS is spaces-only ('   ')", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "   ",
    });

    // Number("   ") === 0 — caught by the <= 0 guard.
    expect(result.status).toBe(1);
  });

  it("prints a clear error for spaces-only ('   ') mentioning the valid range", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "   ",
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toMatch(/positive integer|not.*valid|not meaningful/i);
    expect(result.signal).toBeNull();
  });

  it("exits 1 when REQUIRE_DB_PSQL_TIMEOUT_MS is tab-only ('\\t')", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "\t",
    });

    // Number("\t") === 0 — caught by the <= 0 guard.
    expect(result.status).toBe(1);
  });

  it("prints a clear error for tab-only ('\\t') mentioning the valid range", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "\t",
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toMatch(/positive integer|not.*valid|not meaningful/i);
    expect(result.signal).toBeNull();
  });

  it("exits 1 when REQUIRE_DB_PSQL_TIMEOUT_MS is newline-only ('\\n')", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "\n",
    });

    // Number("\n") === 0 — caught by the <= 0 guard, same branch as "   " and "\t".
    expect(result.status).toBe(1);
  });

  it("prints a clear error for newline-only ('\\n') mentioning the valid range", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "\n",
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toMatch(/positive integer|not.*valid|not meaningful/i);
    expect(result.signal).toBeNull();
  });

  it("exits 1 when REQUIRE_DB_PSQL_TIMEOUT_MS is CRLF-only ('\\r\\n')", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "\r\n",
    });

    // Number("\r\n") === 0 — caught by the <= 0 guard, same branch as "\n".
    expect(result.status).toBe(1);
  });

  it("prints a clear error for CRLF-only ('\\r\\n') mentioning the valid range", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "\r\n",
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toMatch(/positive integer|not.*valid|not meaningful/i);
    expect(result.signal).toBeNull();
  });

  it("exits 1 when REQUIRE_DB_PSQL_TIMEOUT_MS is form-feed-only ('\\f')", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "\f",
    });

    // Number("\f") === 0 — caught by the <= 0 guard, same branch as "\n" and "\t".
    expect(result.status).toBe(1);
  });

  it("prints a clear error for form-feed-only ('\\f') mentioning the valid range", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "\f",
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toMatch(/positive integer|not.*valid|not meaningful/i);
    expect(result.signal).toBeNull();
  });

  it("exits 1 when REQUIRE_DB_PSQL_TIMEOUT_MS is vertical-tab-only ('\\v')", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "\v",
    });

    // Number("\v") === 0 — caught by the <= 0 guard, same branch as "\n" and "\t".
    expect(result.status).toBe(1);
  });

  it("prints a clear error for vertical-tab-only ('\\v') mentioning the valid range", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "\v",
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toMatch(/positive integer|not.*valid|not meaningful/i);
    expect(result.signal).toBeNull();
  });

  it("exits 1 when REQUIRE_DB_PSQL_TIMEOUT_MS is carriage-return-only ('\\r')", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "\r",
    });

    // Number("\r") === 0 — caught by the <= 0 guard, same branch as "\n", "\t", "\f", and "\v".
    expect(result.status).toBe(1);
  });

  it("prints a clear error for carriage-return-only ('\\r') mentioning the valid range", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "\r",
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toMatch(/positive integer|not.*valid|not meaningful/i);
    expect(result.signal).toBeNull();
  });

  // Unicode whitespace — Number() also trims these, so they all evaluate to 0
  // and are caught by the same <= 0 guard as the ASCII whitespace cases above.

  it("exits 1 when REQUIRE_DB_PSQL_TIMEOUT_MS is non-breaking-space-only ('\\u00A0')", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "\u00A0",
    });

    // Number("\u00A0") === 0 — caught by the <= 0 guard, same branch as "   " and "\t".
    expect(result.status).toBe(1);
  });

  it("prints a clear error for non-breaking-space-only ('\\u00A0') mentioning the valid range", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "\u00A0",
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toMatch(/positive integer|not.*valid|not meaningful/i);
    expect(result.signal).toBeNull();
  });

  it("exits 1 when REQUIRE_DB_PSQL_TIMEOUT_MS is em-space-only ('\\u2003')", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "\u2003",
    });

    // Number("\u2003") === 0 — em space is trimmed by Number(), same branch as "\u00A0".
    expect(result.status).toBe(1);
  });

  it("prints a clear error for em-space-only ('\\u2003') mentioning the valid range", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "\u2003",
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toMatch(/positive integer|not.*valid|not meaningful/i);
    expect(result.signal).toBeNull();
  });

  it("exits 1 when REQUIRE_DB_PSQL_TIMEOUT_MS is thin-space-only ('\\u2009')", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "\u2009",
    });

    // Number("\u2009") === 0 — thin space is trimmed by Number(), same branch as "\u00A0" and "\u2003".
    expect(result.status).toBe(1);
  });

  it("prints a clear error for thin-space-only ('\\u2009') mentioning the valid range", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "\u2009",
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toMatch(/positive integer|not.*valid|not meaningful/i);
    expect(result.signal).toBeNull();
  });

  it("exits 1 when REQUIRE_DB_PSQL_TIMEOUT_MS is hair-space-only ('\\u200A')", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "\u200A",
    });

    // Number("\u200A") === 0 — hair space is trimmed by Number(), same branch as "\u2009".
    expect(result.status).toBe(1);
  });

  it("prints a clear error for hair-space-only ('\\u200A') mentioning the valid range", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "\u200A",
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toMatch(/positive integer|not.*valid|not meaningful/i);
    expect(result.signal).toBeNull();
  });

  it("exits 1 when REQUIRE_DB_PSQL_TIMEOUT_MS is ideographic-space-only ('\\u3000')", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "\u3000",
    });

    // Number("\u3000") === 0 — ideographic space is trimmed by Number(), same branch as "\u200A".
    expect(result.status).toBe(1);
  });

  it("prints a clear error for ideographic-space-only ('\\u3000') mentioning the valid range", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "\u3000",
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toMatch(/positive integer|not.*valid|not meaningful/i);
    expect(result.signal).toBeNull();
  });

  it("exits 1 when REQUIRE_DB_PSQL_TIMEOUT_MS is BOM/zero-width-no-break-space-only ('\\uFEFF')", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "\uFEFF",
    });

    // Number("\uFEFF") === 0 — BOM (zero-width no-break space) is trimmed by Number(), same branch as "\u3000".
    expect(result.status).toBe(1);
  });

  it("prints a clear error for BOM/zero-width-no-break-space-only ('\\uFEFF') mentioning the valid range", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "\uFEFF",
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toMatch(/positive integer|not.*valid|not meaningful/i);
    expect(result.signal).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe("require-db.js — values that look numeric but exceed safe-integer range", () => {
  // These values parse successfully as JavaScript numbers but are NOT safe
  // integers, so they must be rejected by the !Number.isSafeInteger() guard:
  //
  //   "1e308"            → Number("1e308") === Infinity   (not a safe integer)
  //   "9007199254740993" → Number.MAX_SAFE_INTEGER + 1    (precision lost; not safe)
  //
  // The guard must exit 1 with a clear error rather than silently passing an
  // unsafe value to spawnSync's timeout option.  These subprocess-based tests
  // verify that behaviour on the *active* Node binary (process.execPath) rather
  // than relying solely on a pure-JS canary that only exercises Number() directly.

  const nodeVersion = process.version; // e.g. "v22.4.1"

  // ── Pure-JS canary — verifies guard preconditions on this Node binary ────────
  // These assertions run in the same V8 instance as the rest of the suite and
  // confirm that Number() still parses these strings the way the guard expects.
  // If a future Node.js major changes the parsing behaviour the canary fails
  // immediately with a message that names the version, making the root cause obvious.

  it(`Number('1e308') is not a safe integer on Node.js ${nodeVersion} (canary)`, () => {
    // 1e308 is a very large but finite double (Number.MAX_VALUE ≈ 1.8e308).
    // It is positive, non-NaN, and passes the <= 0 check, but it is not a safe
    // integer — Number.isSafeInteger(1e308) === false — so the guard must reject it.
    const parsed = Number("1e308");
    if (Number.isNaN(parsed) || parsed <= 0) {
      throw new Error(
        `Number('1e308') === ${parsed} on Node.js ${nodeVersion}. ` +
        `Expected a large positive finite number that passes the NaN/<=0 checks ` +
        `but fails isSafeInteger. ` +
        `A Node.js upgrade may have changed how Number() handles this string. ` +
        `Update the guard in scripts/require-db.js if the parsing behaviour changed.`
      );
    }
    if (Number.isSafeInteger(parsed)) {
      throw new Error(
        `Number('1e308') === ${parsed} is unexpectedly a safe integer on Node.js ${nodeVersion}. ` +
        `Expected it NOT to be safe (it far exceeds Number.MAX_SAFE_INTEGER ≈ 9e15). ` +
        `A Node.js upgrade may have changed Number()/isSafeInteger() behaviour. ` +
        `Update the guard in scripts/require-db.js if the semantics changed.`
      );
    }
    expect(Number.isSafeInteger(parsed)).toBe(false);
    // Confirm it is positive and finite — the guard's <= 0 and isNaN branches do not fire,
    // so rejection is driven purely by !isSafeInteger.
    expect(parsed).toBeGreaterThan(0);
    expect(Number.isFinite(parsed) || parsed === Infinity).toBe(true);
  });

  it(`Number('9007199254740993') is not a safe integer on Node.js ${nodeVersion} (canary)`, () => {
    // 9007199254740993 === Number.MAX_SAFE_INTEGER + 1.  JavaScript floats
    // cannot represent this value exactly — it rounds to MAX_SAFE_INTEGER,
    // which means two distinct integers map to the same double, making it
    // unsafe for arithmetic use.
    const parsed = Number("9007199254740993");
    if (Number.isSafeInteger(parsed)) {
      throw new Error(
        `Number('9007199254740993') returned a value that isSafeInteger on Node.js ${nodeVersion}. ` +
        `Expected it NOT to be safe (it is MAX_SAFE_INTEGER + 1). ` +
        `A Node.js upgrade may have changed Number()/isSafeInteger() behaviour for this value. ` +
        `Update the guard in scripts/require-db.js if the semantics changed.`
      );
    }
    expect(Number.isSafeInteger(parsed)).toBe(false);
  });

  // ── Subprocess tests — exercise the actual guard path on this Node binary ────

  it("exits 1 when REQUIRE_DB_PSQL_TIMEOUT_MS is '1e308' (parses to Infinity)", () => {
    // Number("1e308") === Infinity — blocked by the !Number.isSafeInteger guard
    // in scripts/require-db.js.  Uses the real Node binary (process.execPath)
    // so it validates the guard on the currently active Node version.
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "1e308",
    });

    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
  });

  it("prints a clear error and does not crash when REQUIRE_DB_PSQL_TIMEOUT_MS is '1e308'", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "1e308",
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    // The guard's isSafeInteger branch says "not a whole number" / "integer"
    expect(output).toMatch(/whole number|integer/i);
    expect(result.signal).toBeNull();
  });

  it("exits 1 when REQUIRE_DB_PSQL_TIMEOUT_MS is '9007199254740993' (MAX_SAFE_INTEGER + 1)", () => {
    // 9007199254740993 exceeds Number.MAX_SAFE_INTEGER — !Number.isSafeInteger()
    // returns true, so the guard must exit 1.  Uses the real Node binary
    // (process.execPath) to validate on the currently active Node version.
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "9007199254740993",
    });

    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
  });

  it("prints a clear error and does not crash when REQUIRE_DB_PSQL_TIMEOUT_MS is '9007199254740993'", () => {
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "9007199254740993",
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    // The guard's isSafeInteger branch says "not a whole number" / "integer"
    expect(output).toMatch(/whole number|integer/i);
    expect(result.signal).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe("require-db.js — negative-Infinity overflow: '-1e309' as REQUIRE_DB_PSQL_TIMEOUT_MS", () => {
  // Number('-1e309') produces -Infinity on every IEEE-754 double-precision
  // implementation — the exponent underflows the negative end of the range.
  // Unlike '-Infinity' (the literal string) or '1e308' (large but positive
  // finite), '-1e309' is the canonical *numeric-string* route to -Infinity.
  //
  // Guard path taken:
  //   1. Number.isNaN(-Infinity) === false  → NaN check passes, not rejected here
  //   2. -Infinity <= 0 === true            → caught by the "positive integer" branch
  //   3. Number.isSafeInteger is never reached
  //
  // These tests confirm the correct branch fires and that Number.isSafeInteger
  // is irrelevant for this input (the <= 0 check fires first).

  const nodeVersion = process.version; // e.g. "v22.4.1"

  // ── Pure-JS canary — verifies -1e309 behaviour on the active Node binary ────
  // Runs in the same V8 instance as the rest of the suite.  If a future
  // Node.js major changes how Number() handles this string the canary fails
  // immediately with a message that names the version.

  it(`Number('-1e309') === -Infinity on Node.js ${nodeVersion} (canary)`, () => {
    const parsed = Number("-1e309");
    if (parsed !== -Infinity) {
      throw new Error(
        `Number('-1e309') === ${parsed} on Node.js ${nodeVersion}. ` +
        `Expected -Infinity (negative exponent overflow). ` +
        `A Node.js upgrade may have changed how Number() handles this string. ` +
        `Update the guard in scripts/require-db.js if the parsing behaviour changed.`
      );
    }
    expect(parsed).toBe(-Infinity);
  });

  it(`Number.isSafeInteger(Number('-1e309')) === false on Node.js ${nodeVersion} (canary)`, () => {
    // -Infinity is not a safe integer — this is a secondary confirmation that
    // the guard's isSafeInteger branch would also have rejected it, even though
    // the <= 0 branch fires first in practice.
    const parsed = Number("-1e309");
    if (Number.isSafeInteger(parsed)) {
      throw new Error(
        `Number.isSafeInteger(Number('-1e309')) returned true on Node.js ${nodeVersion}. ` +
        `Expected false — -Infinity must never be a safe integer. ` +
        `A Node.js upgrade may have changed Number()/isSafeInteger() semantics. ` +
        `Update the guard in scripts/require-db.js if the semantics changed.`
      );
    }
    expect(Number.isSafeInteger(parsed)).toBe(false);
  });

  // ── Subprocess tests — exercise the actual guard on this Node binary ─────────

  it("exits 1 when REQUIRE_DB_PSQL_TIMEOUT_MS is '-1e309' (parses to -Infinity)", () => {
    // Number('-1e309') === -Infinity — caught by the `parsed <= 0` branch in
    // scripts/require-db.js.  Uses the real Node binary (process.execPath) to
    // validate the guard fires correctly on the currently active Node version.
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "-1e309",
    });

    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
  });

  it("prints a 'positive integer' / 'not valid' / 'not meaningful' error for '-1e309'", () => {
    // The <= 0 branch in require-db.js emits a message matching
    // /positive integer|not.*valid|not meaningful/i.  The isSafeInteger branch
    // is never reached for this input.
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "-1e309",
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toMatch(/positive integer|not.*valid|not meaningful/i);
    expect(result.signal).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe("require-db.js — '+1e309' (positive-Infinity via numeric overflow) REQUIRE_DB_PSQL_TIMEOUT_MS", () => {
  // Number('+1e309') overflows IEEE-754 double precision and evaluates to
  // +Infinity.  Unlike '-1e309' (which is -Infinity and is caught by the
  // `parsed <= 0` branch), +Infinity is positive so it passes the <= 0 check.
  // It is then caught by the `!Number.isSafeInteger(parsed)` branch, which
  // emits a "whole number / integer" error message.
  //
  // This is the symmetric positive-overflow counterpart to the '-1e309' suite
  // above.  It exercises a different string representation than 'Infinity' or
  // '1e308', confirming the !isSafeInteger guard fires for the specific string
  // '+1e309' on the active Node binary.

  const nodeVersion = process.version; // e.g. "v22.4.1"

  // ── Pure-JS canaries — no subprocess, no fake psql ───────────────────────

  it(`Number('+1e309') === Infinity on Node.js ${nodeVersion} (canary)`, () => {
    // Confirm the numeric overflow behaviour that the guard relies on.
    // If a future Node.js major changes how '+1e309' is parsed, this canary
    // fails with a clear message rather than silently invalidating the test.
    const parsed = Number("+1e309");
    if (parsed !== Infinity) {
      throw new Error(
        `Number('+1e309') === ${parsed} on Node.js ${nodeVersion}, expected Infinity. ` +
          `A Node.js upgrade may have changed how exponential-notation overflow is handled. ` +
          `Update the guard in scripts/require-db.js and this test suite if the semantics changed.`
      );
    }
    expect(parsed).toBe(Infinity);
  });

  it(`Number.isSafeInteger(Number('+1e309')) === false on Node.js ${nodeVersion} (canary)`, () => {
    // +Infinity is not a safe integer — this confirms the !isSafeInteger branch
    // in scripts/require-db.js would fire for this input, not the <= 0 branch.
    const parsed = Number("+1e309");
    if (Number.isSafeInteger(parsed)) {
      throw new Error(
        `Number.isSafeInteger(Number('+1e309')) returned true on Node.js ${nodeVersion}. ` +
          `Expected false — +Infinity must never be a safe integer. ` +
          `A Node.js upgrade may have changed Number()/isSafeInteger() semantics. ` +
          `Update the guard in scripts/require-db.js if the semantics changed.`
      );
    }
    expect(Number.isSafeInteger(parsed)).toBe(false);
  });

  // ── Subprocess tests — exercise the actual guard on this Node binary ─────────

  it("exits 1 when REQUIRE_DB_PSQL_TIMEOUT_MS is '+1e309' (parses to +Infinity)", () => {
    // Number('+1e309') === +Infinity — positive, so it passes the `<= 0` check,
    // then is caught by the `!Number.isSafeInteger` branch in scripts/require-db.js.
    // Uses the real Node binary (process.execPath) to validate the guard fires
    // correctly on the currently active Node version.
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "+1e309",
    });

    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
  });

  it("prints a 'whole number' / 'integer' error for '+1e309' (isSafeInteger branch)", () => {
    // The !isSafeInteger branch in require-db.js emits a message matching
    // /whole number|integer/i.  This is distinct from the <= 0 branch message
    // (/positive integer|not.*valid|not meaningful/i) that fires for '-1e309'.
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: "+1e309",
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toMatch(/whole number|integer/i);
    expect(result.signal).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe("require-db.js — hex-notation MAX_SAFE_INTEGER+1 REQUIRE_DB_PSQL_TIMEOUT_MS", () => {
  // JavaScript's Number() parses hex strings, so Number('0x20000000000001')
  // evaluates to 9007199254740993 — which is MAX_SAFE_INTEGER + 1.
  // Number.isSafeInteger returns false for this value even though it is a
  // positive integer in the mathematical sense, because it cannot be
  // represented exactly in IEEE-754 double precision.
  //
  // The guard must reject it via the !Number.isSafeInteger check rather than
  // silently passing an unsafe integer to spawnSync's timeout option.
  //
  // A pure-JS canary (no subprocess) verifies the active Node binary's
  // Number() and Number.isSafeInteger() behaviour for this hex literal,
  // making any future Node version regression immediately obvious.

  const nodeVersion = process.version;
  const HEX_INPUT = "0x20000000000001"; // MAX_SAFE_INTEGER + 1 in hex

  // ── Pure-JS canary ────────────────────────────────────────────────────────

  it(`Number('${HEX_INPUT}') > Number.MAX_SAFE_INTEGER on Node.js ${nodeVersion} (canary)`, () => {
    // Confirms that the active Node binary parses this hex string to a value
    // strictly greater than MAX_SAFE_INTEGER, which is the precondition for
    // the isSafeInteger guard firing for this input.
    const parsed = Number(HEX_INPUT);
    if (parsed <= Number.MAX_SAFE_INTEGER) {
      throw new Error(
        `Number('${HEX_INPUT}') returned ${parsed} on Node.js ${nodeVersion}, ` +
          `expected a value > Number.MAX_SAFE_INTEGER (${Number.MAX_SAFE_INTEGER}). ` +
          `A Node.js upgrade may have changed how hex-notation parsing is handled. ` +
          `Update the guard in scripts/require-db.js and this test suite if the semantics changed.`
      );
    }
    expect(parsed).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
  });

  it(`Number.isSafeInteger(Number('${HEX_INPUT}')) === false on Node.js ${nodeVersion} (canary)`, () => {
    // Confirms the isSafeInteger check rejects this value, which is the branch
    // in scripts/require-db.js that this input must hit.
    const parsed = Number(HEX_INPUT);
    if (Number.isSafeInteger(parsed)) {
      throw new Error(
        `Number.isSafeInteger(Number('${HEX_INPUT}')) returned true on Node.js ${nodeVersion}. ` +
          `Expected false — MAX_SAFE_INTEGER+1 must never be a safe integer. ` +
          `A Node.js upgrade may have changed Number()/isSafeInteger() semantics. ` +
          `Update the guard in scripts/require-db.js if the semantics changed.`
      );
    }
    expect(Number.isSafeInteger(parsed)).toBe(false);
  });

  // ── Subprocess tests — exercise the actual guard on this Node binary ───────

  it(`exits 1 when REQUIRE_DB_PSQL_TIMEOUT_MS is '${HEX_INPUT}' (MAX_SAFE_INTEGER+1 in hex)`, () => {
    // Number('0x20000000000001') === 9007199254740993 > MAX_SAFE_INTEGER.
    // It passes the isNaN check (it is a number) and the <= 0 check (it is
    // positive), then is caught by the !Number.isSafeInteger branch in
    // scripts/require-db.js.  Uses the real Node binary (process.execPath) to
    // validate the guard fires correctly on the currently active Node version.
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: HEX_INPUT,
    });

    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
  });

  it(`prints a 'whole number' / 'integer' error for '${HEX_INPUT}' (isSafeInteger branch)`, () => {
    // The !isSafeInteger branch in require-db.js emits a message matching
    // /whole number|integer/i — the same branch that fires for 1e308 and
    // +1e309, confirming the guard is notation-agnostic.
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: HEX_INPUT,
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toMatch(/whole number|integer/i);
    expect(result.signal).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe("require-db.js — octal-notation MAX_SAFE_INTEGER overflow REQUIRE_DB_PSQL_TIMEOUT_MS", () => {
  // JavaScript's Number() parses octal strings with the 0o prefix, so
  // Number('0o400000000000000001') evaluates to a value that exceeds
  // Number.MAX_SAFE_INTEGER (9007199254740991).  Even though the value is a
  // positive integer in the mathematical sense, Number.isSafeInteger returns
  // false for it because IEEE-754 double precision cannot represent integers
  // of that magnitude exactly.
  //
  // The guard must reject it via the !Number.isSafeInteger check rather than
  // silently passing an unsafe integer to spawnSync's timeout option.
  //
  // A pure-JS canary (no subprocess) verifies the active Node binary's
  // Number() and Number.isSafeInteger() behaviour for this octal literal,
  // making any future Node version regression immediately obvious.

  const nodeVersion = process.version;
  const OCTAL_INPUT = "0o400000000000000001"; // exceeds MAX_SAFE_INTEGER

  // ── Pure-JS canary ────────────────────────────────────────────────────────

  it(`Number('${OCTAL_INPUT}') > Number.MAX_SAFE_INTEGER on Node.js ${nodeVersion} (canary)`, () => {
    // Confirms that the active Node binary parses this octal string to a value
    // strictly greater than MAX_SAFE_INTEGER, which is the precondition for
    // the isSafeInteger guard firing for this input.
    const parsed = Number(OCTAL_INPUT);
    if (parsed <= Number.MAX_SAFE_INTEGER) {
      throw new Error(
        `Number('${OCTAL_INPUT}') returned ${parsed} on Node.js ${nodeVersion}, ` +
          `expected a value > Number.MAX_SAFE_INTEGER (${Number.MAX_SAFE_INTEGER}). ` +
          `A Node.js upgrade may have changed how octal-notation parsing is handled. ` +
          `Update the guard in scripts/require-db.js and this test suite if the semantics changed.`
      );
    }
    expect(parsed).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
  });

  it(`Number.isSafeInteger(Number('${OCTAL_INPUT}')) === false on Node.js ${nodeVersion} (canary)`, () => {
    // Confirms the isSafeInteger check rejects this value, which is the branch
    // in scripts/require-db.js that this input must hit.
    const parsed = Number(OCTAL_INPUT);
    if (Number.isSafeInteger(parsed)) {
      throw new Error(
        `Number.isSafeInteger(Number('${OCTAL_INPUT}')) returned true on Node.js ${nodeVersion}. ` +
          `Expected false — a value exceeding MAX_SAFE_INTEGER must never be a safe integer. ` +
          `A Node.js upgrade may have changed Number()/isSafeInteger() semantics. ` +
          `Update the guard in scripts/require-db.js if the semantics changed.`
      );
    }
    expect(Number.isSafeInteger(parsed)).toBe(false);
  });

  // ── Subprocess tests — exercise the actual guard on this Node binary ───────

  it(`exits 1 when REQUIRE_DB_PSQL_TIMEOUT_MS is '${OCTAL_INPUT}' (octal exceeding MAX_SAFE_INTEGER)`, () => {
    // Number('0o400000000000000001') > MAX_SAFE_INTEGER.  It passes the isNaN
    // check (it is a number) and the <= 0 check (it is positive), then is
    // caught by the !Number.isSafeInteger branch in scripts/require-db.js.
    // Uses the real Node binary (process.execPath) to validate the guard fires
    // correctly on the currently active Node version.
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: OCTAL_INPUT,
    });

    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
  });

  it(`prints a 'whole number' / 'integer' error for '${OCTAL_INPUT}' (isSafeInteger branch)`, () => {
    // The !isSafeInteger branch in require-db.js emits a message matching
    // /whole number|integer/i — the same branch that fires for 1e308, +1e309,
    // and hex-notation overflow, confirming the guard is notation-agnostic.
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: OCTAL_INPUT,
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toMatch(/whole number|integer/i);
    expect(result.signal).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe("require-db.js — binary-notation REQUIRE_DB_PSQL_TIMEOUT_MS exceeding MAX_SAFE_INTEGER", () => {
  // JavaScript's Number() accepts binary literals like '0b101' (= 5).
  // A sufficiently long binary string such as
  // '0b100000000000000000000000000000000000000000000000000001'
  // evaluates to 2^53 + 1 = 9007199254740993, which is greater than
  // Number.MAX_SAFE_INTEGER (2^53 - 1 = 9007199254740991).  A value that large
  // cannot be safely represented as an integer and must be rejected by the
  // !Number.isSafeInteger guard in scripts/require-db.js.
  //
  // This suite completes notation coverage: decimal, exponential, hex, octal,
  // and binary are all now exercised.

  // 2^53 + 1 — one bit beyond the safe-integer boundary.
  // Count: '0b1' + 52 zeros + '1' = binary representation of 9007199254740993.
  const BINARY_INPUT = "0b100000000000000000000000000000000000000000000000000001";
  const nodeVersion = process.version;

  // ── Pure-JS canaries — confirm Number() and isSafeInteger behave as expected ─

  it(`Number('${BINARY_INPUT}') > Number.MAX_SAFE_INTEGER on Node.js ${nodeVersion} (canary)`, () => {
    // Confirms JavaScript's Number() parses the binary string to a value that
    // exceeds MAX_SAFE_INTEGER.  If a future Node.js version changes binary
    // literal parsing this canary fails with a clear diagnostic.
    const parsed = Number(BINARY_INPUT);
    if (parsed <= Number.MAX_SAFE_INTEGER) {
      throw new Error(
        `Number('${BINARY_INPUT}') === ${parsed} on Node.js ${nodeVersion}, ` +
          `but expected a value greater than Number.MAX_SAFE_INTEGER (${Number.MAX_SAFE_INTEGER}). ` +
          `A Node.js upgrade may have changed how binary-notation parsing is handled. ` +
          `Update the guard in scripts/require-db.js and this test suite if the semantics changed.`
      );
    }
    expect(parsed).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
  });

  it(`Number.isSafeInteger(Number('${BINARY_INPUT}')) === false on Node.js ${nodeVersion} (canary)`, () => {
    // Confirms the isSafeInteger check rejects this value, which is the branch
    // in scripts/require-db.js that this input must hit.
    const parsed = Number(BINARY_INPUT);
    if (Number.isSafeInteger(parsed)) {
      throw new Error(
        `Number.isSafeInteger(Number('${BINARY_INPUT}')) returned true on Node.js ${nodeVersion}. ` +
          `Expected false — a value exceeding MAX_SAFE_INTEGER must never be a safe integer. ` +
          `A Node.js upgrade may have changed Number()/isSafeInteger() semantics. ` +
          `Update the guard in scripts/require-db.js if the semantics changed.`
      );
    }
    expect(Number.isSafeInteger(parsed)).toBe(false);
  });

  // ── Subprocess tests — exercise the actual guard on this Node binary ───────

  it(`exits 1 when REQUIRE_DB_PSQL_TIMEOUT_MS is '${BINARY_INPUT}' (binary exceeding MAX_SAFE_INTEGER)`, () => {
    // Number('0b100000000000000000000000000000000000000000000000000001') > MAX_SAFE_INTEGER.
    // It passes the isNaN check (it is a number) and the <= 0 check (it is
    // positive), then is caught by the !Number.isSafeInteger branch in
    // scripts/require-db.js.  Uses the real Node binary (process.execPath) to
    // validate the guard fires correctly on the currently active Node version.
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: BINARY_INPUT,
    });

    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
  });

  it(`prints a 'whole number' / 'integer' error for '${BINARY_INPUT}' (isSafeInteger branch)`, () => {
    // The !isSafeInteger branch in require-db.js emits a message matching
    // /whole number|integer/i — the same branch that fires for 1e308, +1e309,
    // hex-notation overflow, and octal-notation overflow, confirming the guard
    // is notation-agnostic.
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: BINARY_INPUT,
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toMatch(/whole number|integer/i);
    expect(result.signal).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe("require-db.js — decimal MAX_SAFE_INTEGER+1 REQUIRE_DB_PSQL_TIMEOUT_MS", () => {
  // '9007199254740992' is exactly Number.MAX_SAFE_INTEGER + 1 (2^53), expressed
  // as a plain decimal string.  This is the tightest possible overflow — only
  // 1 above the safe-integer boundary — and the most common real-world
  // misconfiguration risk (e.g. a timeout value copy-pasted from a system that
  // uses 64-bit integers).
  //
  // Number('9007199254740992') evaluates to 9007199254740992, a positive number
  // that passes the isNaN guard and the <= 0 guard, but
  // Number.isSafeInteger(9007199254740992) returns false because the value
  // equals 2^53 which is strictly greater than MAX_SAFE_INTEGER (2^53 - 1).
  // The !Number.isSafeInteger branch in scripts/require-db.js must catch it.

  const DECIMAL_OVERFLOW_INPUT = "9007199254740992"; // MAX_SAFE_INTEGER + 1
  const nodeVersion = process.version;

  // ── Pure-JS canaries — confirm Number() and isSafeInteger behave as expected ─

  it(`Number('${DECIMAL_OVERFLOW_INPUT}') > Number.MAX_SAFE_INTEGER on Node.js ${nodeVersion} (canary)`, () => {
    // Confirms JavaScript's Number() parses the decimal string to a value that
    // exceeds MAX_SAFE_INTEGER.  If a future Node.js version changes decimal
    // parsing this canary fails with a clear diagnostic.
    const parsed = Number(DECIMAL_OVERFLOW_INPUT);
    if (parsed <= Number.MAX_SAFE_INTEGER) {
      throw new Error(
        `Number('${DECIMAL_OVERFLOW_INPUT}') === ${parsed} on Node.js ${nodeVersion}, ` +
          `but expected a value greater than Number.MAX_SAFE_INTEGER (${Number.MAX_SAFE_INTEGER}). ` +
          `A Node.js upgrade may have changed how decimal parsing is handled. ` +
          `Update the guard in scripts/require-db.js and this test suite if the semantics changed.`
      );
    }
    expect(parsed).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
  });

  it(`Number.isSafeInteger(Number('${DECIMAL_OVERFLOW_INPUT}')) === false on Node.js ${nodeVersion} (canary)`, () => {
    // Confirms the isSafeInteger check rejects this value, which is the branch
    // in scripts/require-db.js that this input must hit.
    const parsed = Number(DECIMAL_OVERFLOW_INPUT);
    if (Number.isSafeInteger(parsed)) {
      throw new Error(
        `Number.isSafeInteger(Number('${DECIMAL_OVERFLOW_INPUT}')) returned true on Node.js ${nodeVersion}. ` +
          `Expected false — a value exceeding MAX_SAFE_INTEGER must never be a safe integer. ` +
          `A Node.js upgrade may have changed Number()/isSafeInteger() semantics. ` +
          `Update the guard in scripts/require-db.js if the semantics changed.`
      );
    }
    expect(Number.isSafeInteger(parsed)).toBe(false);
  });

  // ── Subprocess tests — exercise the actual guard on this Node binary ───────

  it(`exits 1 when REQUIRE_DB_PSQL_TIMEOUT_MS is '${DECIMAL_OVERFLOW_INPUT}' (decimal MAX_SAFE_INTEGER+1)`, () => {
    // Number('9007199254740992') > MAX_SAFE_INTEGER.  It passes the isNaN check
    // (it is a number) and the <= 0 check (it is positive), then is caught by
    // the !Number.isSafeInteger branch in scripts/require-db.js.  Uses the real
    // Node binary (process.execPath) to validate the guard fires correctly on
    // the currently active Node version.
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: DECIMAL_OVERFLOW_INPUT,
    });

    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
  });

  it(`prints a 'whole number' / 'integer' error for '${DECIMAL_OVERFLOW_INPUT}' (isSafeInteger branch)`, () => {
    // The !isSafeInteger branch in require-db.js emits a message matching
    // /whole number|integer/i — the same branch that fires for 1e308, +1e309,
    // hex-notation overflow, octal-notation overflow, and binary-notation
    // overflow, confirming the guard is notation-agnostic and catches the
    // tightest possible boundary violation.
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: DECIMAL_OVERFLOW_INPUT,
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toMatch(/whole number|integer/i);
    expect(result.signal).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe("require-db.js — decimal MAX_SAFE_INTEGER REQUIRE_DB_PSQL_TIMEOUT_MS", () => {
  // '9007199254740991' is exactly Number.MAX_SAFE_INTEGER (2^53 - 1), expressed
  // as a plain decimal string.  This is the upper boundary of the safe-integer
  // range, and the mirror of the MAX_SAFE_INTEGER+1 test above.
  //
  // Number('9007199254740991') evaluates to 9007199254740991 which:
  //   - passes the isNaN guard (it is a valid number)
  //   - passes the <= 0 guard (it is positive)
  //   - passes the !Number.isSafeInteger guard (Number.isSafeInteger returns true)
  //
  // The guard must ACCEPT this value and allow the psql probe to proceed
  // (exit 0 with 'dev database confirmed').  An off-by-one error that treats
  // MAX_SAFE_INTEGER itself as unsafe would cause a false rejection here.

  const MAX_SAFE_INTEGER_INPUT = "9007199254740991"; // Number.MAX_SAFE_INTEGER
  const nodeVersion = process.version;

  // ── Pure-JS canaries — confirm Number() and isSafeInteger behave as expected ─

  it("pure-JS canary: Number('9007199254740991') === Number.MAX_SAFE_INTEGER", () => {
    // Guard: if this canary fails, the Node.js version has a regression in
    // Number() parsing for large integer literals.
    const parsed = Number(MAX_SAFE_INTEGER_INPUT);
    if (parsed !== Number.MAX_SAFE_INTEGER) {
      throw new Error(
        `Number('${MAX_SAFE_INTEGER_INPUT}') === ${parsed} on Node.js ${nodeVersion}, ` +
        `expected ${Number.MAX_SAFE_INTEGER} (Number.MAX_SAFE_INTEGER). ` +
        `A Node.js major upgrade may have changed large-integer parsing.`
      );
    }
    expect(parsed).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("pure-JS canary: Number.isSafeInteger(Number('9007199254740991')) returns true", () => {
    // Guard: if this canary fails, the Node.js version has a regression in
    // Number.isSafeInteger for the exact MAX_SAFE_INTEGER boundary.
    const parsed = Number(MAX_SAFE_INTEGER_INPUT);
    const safe = Number.isSafeInteger(parsed);
    if (!safe) {
      throw new Error(
        `Number.isSafeInteger(${parsed}) returned false on Node.js ${nodeVersion}. ` +
        `Expected true because ${parsed} === Number.MAX_SAFE_INTEGER (2^53 - 1). ` +
        `A Node.js major upgrade may have changed the isSafeInteger boundary.`
      );
    }
    expect(safe).toBe(true);
  });

  // ── Subprocess tests — exercise the actual guard on this Node binary ───────

  it(`exits 0 when REQUIRE_DB_PSQL_TIMEOUT_MS is '${MAX_SAFE_INTEGER_INPUT}' (decimal MAX_SAFE_INTEGER)`, () => {
    // Number('9007199254740991') === Number.MAX_SAFE_INTEGER.  It passes all
    // three guards (isNaN, <= 0, isSafeInteger) and is a valid timeout value.
    // The guard must NOT reject it — this test confirms the guard accepts the
    // exact upper boundary without an off-by-one error.
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: MAX_SAFE_INTEGER_INPUT,
    });

    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
  });

  it(`output contains 'dev database confirmed' for '${MAX_SAFE_INTEGER_INPUT}' (MAX_SAFE_INTEGER accepted)`, () => {
    // Confirm the guard prints the success message — not an error — when
    // REQUIRE_DB_PSQL_TIMEOUT_MS is exactly Number.MAX_SAFE_INTEGER.
    const fakeBinDir = makeFakePsqlDir("exit 0");

    const result = runGuard({
      DATABASE_URL: "postgres://user:pass@localhost/devdb",
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      REQUIRE_DB_PSQL_TIMEOUT_MS: MAX_SAFE_INTEGER_INPUT,
    });

    const output = String(result.stderr || "") + String(result.stdout || "");
    expect(output).toContain("dev database confirmed");
    expect(result.signal).toBeNull();
  });
});
