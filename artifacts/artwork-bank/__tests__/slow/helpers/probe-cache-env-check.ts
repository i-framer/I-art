/**
 * probe-cache-env-check.ts
 *
 * Subprocess helper for the age-guard CI integration test in probe-cache.test.ts.
 *
 * Run this script via tsx with MAX_SENTINEL_AGE_HOURS set in the process
 * environment.  It prints a single JSON line to stdout containing:
 *   - `constant`:  the resolved MAX_SENTINEL_AGE_HOURS value (from probe-cache's IIFE)
 *   - `result`:    the return value of consumeProbeCache() called against a
 *                  sentinel file that was backdated by SENTINEL_BACKDATE_MS milliseconds
 *
 * Spawning a fresh process guarantees that the module-level IIFE in probe-cache
 * runs against the subprocess environment — Vitest's module-level caching or any
 * prior vi.resetModules() state in the test runner cannot interfere.
 *
 * The test sets MAX_SENTINEL_AGE_HOURS to values above and below the sentinel age
 * and asserts the constant and the consumeProbeCache result flip accordingly.
 *
 * SENTINEL_BACKDATE_MS controls how far in the past the sentinel's mtime is set.
 * Defaults to 2 hours (7_200_000 ms) when not provided, preserving the original
 * behaviour used by the 1 h / 3 h / 0.5 h / 3.5 h test cases.
 *
 * NOW_MS (optional) freezes Date.now() to the given millisecond timestamp for the
 * duration of the consumeProbeCache() call.  When supplied, the mtime backdate is
 * computed relative to NOW_MS rather than the real clock, so the age observed by
 * consumeProbeCache() is exactly SENTINEL_BACKDATE_MS with no wall-clock drift.
 * This is used by boundary tests that need a deterministic age at exact-threshold
 * values (e.g. ageMs === 36 000 ms with MTIME_TRUNCATION_TOLERANCE_MS=0).
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

  // Backdate the sentinel by SENTINEL_BACKDATE_MS milliseconds (default: 2 hours).
  //
  // The default of 2 hours preserves the original behaviour used by the
  // 1 h / 3 h / 0.5 h / 3.5 h test cases:
  //   • stale   when MAX_SENTINEL_AGE_HOURS ≤ 2  (threshold below or equal)
  //   • fresh   when MAX_SENTINEL_AGE_HOURS > 2  (threshold above)
  //
  // Tests that need sub-minute thresholds (e.g. MAX_SENTINEL_AGE_HOURS=0.01)
  // supply a small SENTINEL_BACKDATE_MS value (e.g. 10_000 for 10 seconds) so
  // the sentinel falls within or beyond the 36-second window respectively.
  const backdateEnv = process.env["SENTINEL_BACKDATE_MS"];
  const backdateMs =
    backdateEnv !== undefined &&
    backdateEnv !== "" &&
    Number.isFinite(Number(backdateEnv)) &&
    Number(backdateEnv) > 0
      ? Number(backdateEnv)
      : 2 * 60 * 60 * 1000; // default: 2 hours

  // NOW_MS: optional frozen clock value.  When provided, Date.now() is replaced
  // with a function that always returns this value for the duration of the
  // consumeProbeCache() call.  The mtime is then set to (nowMs - backdateMs),
  // so the age observed by consumeProbeCache() is exactly backdateMs with no
  // wall-clock drift.  Without this override, a few milliseconds of elapsed time
  // between utimesSync and consumeProbeCache's internal Date.now() call make the
  // observed age slightly larger than backdateMs — enough to cause a spurious
  // rejection when MTIME_TRUNCATION_TOLERANCE_MS=0 and backdateMs equals
  // maxAgeMs exactly (the strict-greater-than boundary case).
  const nowMsEnv = process.env["NOW_MS"];
  const frozenNowMs =
    nowMsEnv !== undefined &&
    nowMsEnv !== "" &&
    Number.isFinite(Number(nowMsEnv))
      ? Number(nowMsEnv)
      : undefined;

  // Use the frozen clock (if provided) as the reference for the mtime write.
  const effectiveNow = frozenNowMs ?? Date.now();
  const backdatedDate = new Date(effectiveNow - backdateMs);
  fs.utimesSync(sentinelPath, backdatedDate, backdatedDate);

  // If a frozen clock was requested, monkey-patch Date.now for the duration of
  // consumeProbeCache() so the age computation inside the module sees exactly
  // (effectiveNow - backdatedDate) = backdateMs, with no wall-clock drift.
  const realDateNow = Date.now;
  if (frozenNowMs !== undefined) {
    Date.now = () => frozenNowMs;
  }

  let result: string | null;
  try {
    result = consumeProbeCache(tmpDir);
  } finally {
    // Always restore the real clock, even if consumeProbeCache throws.
    Date.now = realDateNow;
  }

  // Restore console before writing so the JSON line reaches stdout cleanly.
  console.warn = _warn;
  console.log = _log;

  process.stdout.write(
    JSON.stringify({ constant: MAX_SENTINEL_AGE_HOURS, result }) + "\n",
  );
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
