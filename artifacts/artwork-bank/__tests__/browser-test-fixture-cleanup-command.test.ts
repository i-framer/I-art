/**
 * The cleanup script is invoked by a package command, so exercise that command
 * as a real subprocess for the safety checks that must run before DB access.
 */

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

const PACKAGE_DIR = path.resolve(__dirname, "..");
const ERROR_MESSAGE =
  "Browser test mode requires an explicit matching BROWSER_TEST_DATABASE_URL.";

function runCleanupCommand(
  env: Record<string, string | undefined>,
): ReturnType<typeof spawnSync> {
  return spawnSync("pnpm", ["run", "cleanup:browser-test-fixtures"], {
    cwd: PACKAGE_DIR,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

describe("cleanup:browser-test-fixtures", () => {
  it("refuses production mode before querying the database", () => {
    const result = runCleanupCommand({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://test.example/browser-test",
      BROWSER_TEST_DATABASE_URL: "postgresql://test.example/browser-test",
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(ERROR_MESSAGE);
  });

  it("refuses a database that was not explicitly designated for browser tests", () => {
    const result = runCleanupCommand({
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://production.example/artwork-bank",
      BROWSER_TEST_DATABASE_URL: "postgresql://test.example/browser-test",
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(ERROR_MESSAGE);
  });
});