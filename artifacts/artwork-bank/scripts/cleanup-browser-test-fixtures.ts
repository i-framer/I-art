/**
 * Development-only cleanup for abandoned browser-test fixtures.
 *
 * Usage:
 *   pnpm --filter @workspace/artwork-bank cleanup:browser-test-fixtures
 *
 * The package script enables browser-test mode for this command. The cleanup
 * helper still requires NODE_ENV to be non-production and requires
 * BROWSER_TEST_DATABASE_URL to exactly match DATABASE_URL before it will
 * inspect or delete anything.
 */

import { cleanupAbandonedBrowserTestFixtures } from "../lib/browser-test-fixture";

export async function main(): Promise<void> {
  const removed = await cleanupAbandonedBrowserTestFixtures();
  console.log(
    `Removed ${removed} stale browser-test fixture${removed === 1 ? "" : "s"}.`,
  );
}

if (process.argv[1]?.endsWith("cleanup-browser-test-fixtures.ts")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}