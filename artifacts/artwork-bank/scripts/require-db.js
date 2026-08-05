/**
 * Pre-flight guard for the integration test suite.
 *
 * Two checks are performed before any test runner is invoked:
 *
 *  1. DATABASE_URL must be set — exits non-zero with a clear message when it
 *     is absent so a misconfigured CI pipeline fails loudly instead of silently
 *     skipping every test and reporting a false green.
 *
 *  2. The connected database must allow SET LOCAL session_replication_role =
 *     'replica' — the orphan-sweep integration tests insert FK-violating orphan
 *     rows using this GUC.  Neon's production database (PROD_DATABASE_URL)
 *     withholds this permission from non-superusers; running the test suite
 *     against it produces 15 cryptic "permission denied to set parameter
 *     session_replication_role" failures.  This probe catches that mistake at
 *     the pre-flight stage and prints a clear "use the dev database" message
 *     instead.
 *
 * This script is intentionally plain JS (no transpilation needed) so it can
 * run as the very first step before any build tooling is invoked.
 *
 * Environments where DATABASE_URL is intentionally absent (e.g. stripped
 * preview builds) should NOT invoke this script; use the skip-if-no-db
 * helper inside Vitest suites instead.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const { spawnSync } = require("child_process");
/* eslint-enable @typescript-eslint/no-require-imports */

// ── Check 1: DATABASE_URL must be present ────────────────────────────────────

if (!process.env.DATABASE_URL) {
  process.stderr.write(
    "\n" +
    "ERROR: DATABASE_URL is not set.\n" +
    "\n" +
    "The integration test suite requires a live PostgreSQL database.\n" +
    "Set DATABASE_URL before running `pnpm test:integration`.\n" +
    "\n" +
    "If you are running in an environment where a database is intentionally\n" +
    "absent, use the `describeIntegration` helper from\n" +
    "`__tests__/helpers/skip-if-no-db.ts` inside your test files — it will\n" +
    "skip those suites gracefully rather than failing the whole run.\n" +
    "\n"
  );
  process.exit(1);
}

process.stdout.write("✓ DATABASE_URL is set — proceeding with integration tests.\n");

// ── Check 2: session_replication_role GUC must be settable ──────────────────
//
// Probe by issuing SET LOCAL session_replication_role = 'replica' inside a
// transaction, then rolling back.  The rollback means no database state is
// changed; the only purpose is to confirm the permission exists.
//
// Key flags:
//   -v ON_ERROR_STOP=1   causes psql to abort and exit non-zero the moment any
//                        SQL statement fails.  Without this, a multi-statement
//                        -c string continues past a SET error and psql may exit
//                        0 even though the GUC was denied.
//   --no-psqlrc          avoids loading user config that could interfere.
//
// If psql is not on PATH we skip the probe rather than blocking the run — the
// tests themselves will surface a clearer error in that case.

// Validate REQUIRE_DB_PSQL_TIMEOUT_MS before use — Number("abc") silently
// produces NaN and spawnSync behaviour with a NaN timeout is undefined across
// Node versions.  Catching it here produces a clear message instead of an
// uncaught exception or a silently ignored timeout.
let psqlTimeoutMs = 15_000;
if (process.env.REQUIRE_DB_PSQL_TIMEOUT_MS !== undefined) {
  const parsed = Number(process.env.REQUIRE_DB_PSQL_TIMEOUT_MS);
  if (Number.isNaN(parsed)) {
    process.stderr.write(
      "\n" +
      "ERROR: REQUIRE_DB_PSQL_TIMEOUT_MS is set to a non-numeric value: " +
      JSON.stringify(process.env.REQUIRE_DB_PSQL_TIMEOUT_MS) + "\n" +
      "\n" +
      "This variable must be a positive integer (milliseconds), e.g. 15000.\n" +
      "Unset it to use the default (15 000 ms), or set it to a valid number.\n" +
      "\n"
    );
    process.exit(1);
  }
  psqlTimeoutMs = parsed;
}

const probeSQL =
  "BEGIN; SET LOCAL session_replication_role = 'replica'; ROLLBACK;";

const result = spawnSync(
  "psql",
  [
    process.env.DATABASE_URL,
    "--no-psqlrc",
    "-v", "ON_ERROR_STOP=1",
    "-c", probeSQL,
  ],
  {
    encoding: "utf8",
    timeout: psqlTimeoutMs,
  }
);

if (result.error) {
  // psql could not be spawned or the probe timed out.  Without a successful
  // probe we cannot confirm the database allows session_replication_role, so
  // we fail hard rather than continuing into a test run that will produce 15
  // cryptic "permission denied" failures if the wrong database is connected.
  const isTimeout =
    result.error.code === "ETIMEDOUT" || result.error.message.includes("timed out");
  process.stderr.write(
    "\n" +
    (isTimeout
      ? "ERROR: psql probe timed out (15 s) while connecting to the database.\n"
      : "ERROR: psql is not available on PATH — cannot probe session_replication_role.\n") +
    "\n" +
    "The orphan-sweep integration tests require SET LOCAL\n" +
    "session_replication_role = 'replica', which only works on the dev database.\n" +
    "Without a successful probe we cannot confirm the correct database is in use.\n" +
    "\n" +
    (isTimeout
      ? "Check that DATABASE_URL is reachable and try again.\n"
      : "Install PostgreSQL client tools (psql) so the pre-flight probe can run.\n") +
    "\n"
  );
  process.exit(1);
} else if (result.status !== 0) {
  // psql exited non-zero.  With ON_ERROR_STOP=1 this happens as soon as any
  // SQL statement fails, so a non-zero exit here reliably means the SET LOCAL
  // command was denied (or there was a connection error).
  //
  // Match both substrings independently so the check is robust regardless of
  // whether PostgreSQL quotes the parameter name in the error message
  // ('session_replication_role' vs session_replication_role).
  const stderr = (result.stderr || "") + (result.stdout || "");
  const isPermissionDenied =
    stderr.includes("permission denied to set parameter") &&
    stderr.includes("session_replication_role");

  if (isPermissionDenied) {
    process.stderr.write(
      "\n" +
      "ERROR: The connected database does not allow\n" +
      "       SET LOCAL session_replication_role = 'replica'.\n" +
      "\n" +
      "This almost always means DATABASE_URL is pointing at the Neon production\n" +
      "database (PROD_DATABASE_URL) instead of the local / heliumdb development\n" +
      "database.  Neon withholds the session_replication_role GUC from\n" +
      "non-superusers, so the orphan-sweep integration tests cannot insert the\n" +
      "FK-violating test rows they need.\n" +
      "\n" +
      "Fix: make sure DATABASE_URL points to the dev database, not PROD_DATABASE_URL.\n" +
      "\n" +
      "     # correct (dev)\n" +
      "     DATABASE_URL=postgres://... pnpm test:integration\n" +
      "\n" +
      "     # wrong — do NOT do this\n" +
      "     DATABASE_URL=\"$PROD_DATABASE_URL\" pnpm test:integration\n" +
      "\n"
    );
    process.exit(1);
  } else {
    // Some other psql error (e.g. the database is unreachable).  Print the
    // output and exit non-zero so the developer sees the problem immediately
    // rather than getting a flood of confusing test failures.
    process.stderr.write(
      "\n" +
      "ERROR: psql probe failed while connecting to the database.\n" +
      "       Check that DATABASE_URL is reachable before running tests.\n" +
      "\n" +
      "       psql output: " + stderr.trim() + "\n" +
      "\n"
    );
    process.exit(1);
  }
} else {
  process.stdout.write(
    "✓ session_replication_role probe passed — dev database confirmed.\n"
  );
}
