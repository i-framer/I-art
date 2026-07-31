/**
 * Pre-flight guard for the integration test suite.
 *
 * Exits non-zero with a clear message when DATABASE_URL is absent so that a
 * misconfigured CI pipeline fails loudly instead of silently skipping every
 * test and reporting a false green.
 *
 * This script is intentionally plain JS (no transpilation needed) so it can
 * run as the very first step before any build tooling is invoked.
 *
 * Environments where DATABASE_URL is intentionally absent (e.g. stripped
 * preview builds) should NOT invoke this script; use the skip-if-no-db
 * helper inside Vitest suites instead.
 */

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
