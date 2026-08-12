/**
 * probe-cache-env-check.ts
 *
 * Subprocess helper for the age-guard CI integration test in probe-cache.test.ts.
 *
 * Run this script via tsx with MAX_SENTINEL_AGE_HOURS set in the process
 * environment.  It prints a single JSON line to stdout containing:
 *   - `constant`:  the resolved MAX_SENTINEL_AGE_HOURS value (from probe-cache's IIFE)
 *   - `result`:    the return value of consumeProbeCache() called against a
 *                  sentinel file that was backdated to 2 hours ago
 *
 * Spawning a fresh process guarantees that the module-level IIFE in probe-cache
 * runs against the subprocess environment — Vitest's module-level caching or any
 * prior vi.resetModules() state in the test runner cannot interfere.
 *
 * The test sets MAX_SENTINEL_AGE_HOURS to values above and below 2 (hours) and
 * asserts the constant and the consumeProbeCache result flip accordingly.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAX_SENTINEL_AGE_HOURS,
  consumeProbeCache,
  PROBE_CACHE_SENTINEL,
} from "./probe-cache";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Silence the stale-sentinel console.warn so the subprocess stdout contains
// only the JSON output the test asserts on.
const _warn = console.warn;
console.warn = () => {};
// Also suppress the warm-start console.log for clean stdout.
const _log = console.log;
console.log = () => {};

const buildDir = ".next-probe-ci";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-cache-ci-"));

try {
  // Create a real build directory so the existence check inside consumeProbeCache
  // passes (the stale-age guard fires before the directory check, but we want
  // the test to be unambiguous regardless of threshold value).
  fs.mkdirSync(path.join(tmpDir, buildDir));

  const sentinelPath = path.join(tmpDir, PROBE_CACHE_SENTINEL);
  fs.writeFileSync(sentinelPath, buildDir, "utf8");

  // Backdate the sentinel to exactly 2 hours ago.
  // This sentinel is:
  //   • stale   when MAX_SENTINEL_AGE_HOURS ≤ 2  (threshold below or equal)
  //   • fresh   when MAX_SENTINEL_AGE_HOURS > 2  (threshold above)
  // The test uses 1 h (stale → null) and 3 h (fresh → buildDir).
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(sentinelPath, twoHoursAgo, twoHoursAgo);

  const result = consumeProbeCache(tmpDir);

  // Restore console before writing so the JSON line reaches stdout cleanly.
  console.warn = _warn;
  console.log = _log;

  process.stdout.write(
    JSON.stringify({ constant: MAX_SENTINEL_AGE_HOURS, result }) + "\n",
  );
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
