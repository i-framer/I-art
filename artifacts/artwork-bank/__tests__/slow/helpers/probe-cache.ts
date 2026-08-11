/**
 * probe-cache.ts
 *
 * Shared constants and helpers for the probe-cache hand-off between
 * probe-nextdev-startup.ts (the CI probe step) and the slow-test suite
 * (upload-stall-timeout-nextdev.test.ts).
 *
 * Kept in a separate module so the logic can be unit-tested without
 * importing the heavy slow-test infrastructure.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Default isolated Next.js build-output directory used by the test-spawned
 * `next dev` when no probe cache is available.
 *
 * next.config.ts reads process.env.BUILD_DIR for distDir, defaulting to ".next".
 * Setting a dedicated directory prevents the slow-test process from sharing
 * (or corrupting) the main workspace .next cache and avoids the
 * `__webpack_require__.C is not a function` instrumentation error that occurs
 * when a stale .next cache from a previous `build:no-db` run is in use.
 */
export const DEV_BUILD_DIR = ".next-slow-test";

/**
 * Sentinel file written by the probe script (probe-nextdev-startup.ts) when
 * PROBE_RETAIN_CACHE=1.  Its content is the name of the retained build
 * directory.  consumeProbeCache reads it and deletes it so the cache is only
 * reused once per CI job.
 */
export const PROBE_CACHE_SENTINEL = ".next-probe-cache-ready";

/**
 * Try to consume the probe's retained build cache.
 *
 * Returns the name of the build directory to use.  Side-effects:
 *   • Deletes the sentinel file (so it is consumed exactly once).
 *   • Skips rmSync on the returned directory (caller must NOT clean it first).
 *
 * Returns null when no valid cache sentinel exists; the caller should fall
 * back to cleaning and rebuilding DEV_BUILD_DIR.
 *
 * Behaviour matrix:
 *   sentinel absent              → returns null, no side effects
 *   sentinel present, dir exists → returns dir name, deletes sentinel
 *   sentinel present, dir absent → returns null, deletes sentinel (stale)
 */
export function consumeProbeCache(artworkBankDir: string): string | null {
  const sentinelPath = path.join(artworkBankDir, PROBE_CACHE_SENTINEL);
  let buildDir: string;
  try {
    buildDir = fs.readFileSync(sentinelPath, "utf8").trim();
  } catch {
    // Sentinel absent or unreadable — no warm cache available.
    return null;
  }

  // Validate: the build directory must actually exist on disk.
  // If BUILD_DIR was customised to a value different from what the probe used,
  // the sentinel content will name a directory that is no longer present.
  // Emit a clear warning instead of silently falling back to a cold start so
  // the mismatch is visible in CI logs.
  const buildOutputPath = path.join(artworkBankDir, buildDir);
  if (!fs.existsSync(buildOutputPath)) {
    console.warn(
      `[slow-test] WARNING: probe cache sentinel names "${buildDir}" but that ` +
        `directory does not exist at ${buildOutputPath}. ` +
        `This usually means BUILD_DIR was changed between the probe step and the ` +
        `test run. Discarding stale sentinel and falling back to a cold start.`,
    );
    // Stale sentinel — clean it up and fall back to cold start.
    try {
      fs.rmSync(sentinelPath, { force: true });
    } catch {
      /* best-effort */
    }
    return null;
  }

  // Consume the sentinel so it is not reused by a subsequent test run.
  try {
    fs.rmSync(sentinelPath, { force: true });
  } catch {
    /* best-effort */
  }

  console.log(
    `[slow-test] Reusing probe build cache from ${buildDir} — skipping cold start.`,
  );
  return buildDir;
}
