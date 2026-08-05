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
