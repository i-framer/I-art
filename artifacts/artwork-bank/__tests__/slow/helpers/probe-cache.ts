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
 * Maximum age of a probe-cache sentinel before it is treated as stale and
 * discarded.  A sentinel older than this threshold was almost certainly left
 * over from a prior CI run whose workspace directory was inadvertently cached;
 * reusing it risks a corrupt or mismatched .next-probe build output.
 *
 * Override via the MAX_SENTINEL_AGE_HOURS environment variable for testing or
 * when CI jobs legitimately run more than 24 hours apart.
 */
export const MAX_SENTINEL_AGE_HOURS: number = (() => {
  const env = process.env["MAX_SENTINEL_AGE_HOURS"];
  if (env !== undefined && env !== "") {
    const parsed = Number(env);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 24;
})();

/**
 * Tolerance added to the age-guard rejection threshold to absorb filesystem
 * mtime truncation.  Many filesystems (ext3, HFS+, FAT, some network
 * filesystems) store mtime at 1-second precision.  After a utimesSync
 * round-trip the stored mtime is the floor of the true write time to the
 * nearest second, so a sentinel can appear up to 999 ms older than its true
 * age.  Adding 1 000 ms to the rejection threshold ensures a genuinely fresh
 * sentinel is never falsely discarded because the filesystem rounded its
 * mtime down into the stale zone.
 */
export const MTIME_TRUNCATION_TOLERANCE_MS = 1000;

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

  // Guard against stale sentinels left over from a prior CI run whose
  // workspace directory was inadvertently cached.  A sentinel whose mtime
  // predates the current job by more than MAX_SENTINEL_AGE_HOURS is treated
  // as stale: reusing it risks a corrupt or mismatched .next-probe build.
  //
  // Many filesystems (ext3, HFS+, FAT, some network filesystems) store mtime
  // at 1-second precision.  After a utimesSync round-trip the stored mtime is
  // the floor of the true write time to the nearest second, so a sentinel can
  // appear up to 999 ms older than its true age.  MTIME_TRUNCATION_TOLERANCE_MS
  // adds a 1-second buffer to the rejection threshold so a genuinely fresh
  // sentinel is never falsely discarded because the filesystem rounded its
  // mtime down into the stale zone.
  let sentinelAgeTooOld = false;
  let sentinelMtimeForAge = "";
  try {
    const stat = fs.statSync(sentinelPath);
    sentinelMtimeForAge = stat.mtime.toISOString();
    const ageMs = Date.now() - stat.mtime.getTime();
    const maxAgeMs = MAX_SENTINEL_AGE_HOURS * 60 * 60 * 1000;
    if (ageMs > maxAgeMs + MTIME_TRUNCATION_TOLERANCE_MS) {
      sentinelAgeTooOld = true;
    }
  } catch {
    // If we can't stat the sentinel, we can't verify its age — treat it as
    // safe to continue (the subsequent directory-existence check still guards us).
  }

  if (sentinelAgeTooOld) {
    console.warn(
      `[slow-test] WARNING: probe cache sentinel is too old ` +
        `(created at ${sentinelMtimeForAge}, max age ${MAX_SENTINEL_AGE_HOURS}h). ` +
        `This sentinel was almost certainly left over from a prior CI run whose ` +
        `workspace directory was cached. Discarding stale sentinel and falling back to a cold start.`,
    );
    try {
      fs.rmSync(sentinelPath, { force: true });
    } catch {
      /* best-effort */
    }
    return null;
  }

  // Validate: the build directory must actually exist on disk.
  // If BUILD_DIR was customised to a value different from what the probe used,
  // the sentinel content will name a directory that is no longer present.
  // Emit a clear warning instead of silently falling back to a cold start so
  // the mismatch is visible in CI logs.
  const buildOutputPath = path.join(artworkBankDir, buildDir);
  if (!fs.existsSync(buildOutputPath)) {
    // Capture the sentinel mtime before deleting it so the warning message can
    // record when the probe step created the cache.  This lets operators
    // correlate a stale-sentinel warning with a specific CI run even when
    // multiple jobs run back-to-back.
    let staleMtime = "";
    try {
      staleMtime = fs.statSync(sentinelPath).mtime.toISOString();
    } catch {
      /* best-effort — if stat fails we still proceed */
    }
    console.warn(
      `[slow-test] WARNING: probe cache sentinel names "${buildDir}" but that ` +
        `directory does not exist at ${buildOutputPath}. ` +
        `Sentinel was created at ${staleMtime}. ` +
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

  // Capture the sentinel mtime before deleting it so the log message can
  // record when the probe step created the cache.  This lets operators
  // correlate a warm-start log line with a specific CI run even when
  // multiple jobs run back-to-back.
  let sentinelMtime = "";
  try {
    sentinelMtime = fs.statSync(sentinelPath).mtime.toISOString();
  } catch {
    /* best-effort — if stat fails we still proceed */
  }

  // Consume the sentinel so it is not reused by a subsequent test run.
  try {
    fs.rmSync(sentinelPath, { force: true });
  } catch {
    /* best-effort */
  }

  console.log(
    `[slow-test] Reusing probe build cache from ${buildDir} ` +
      `(probe seeded at ${sentinelMtime}) — skipping cold start.`,
  );
  return buildDir;
}
