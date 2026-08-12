/**
 * probe-cache-mtime-env-check.ts
 *
 * Subprocess helper for the tolerance-guard CI integration test in
 * probe-cache.test.ts.
 *
 * Run this script via tsx with MTIME_TRUNCATION_TOLERANCE_MS (and
 * MAX_SENTINEL_AGE_HOURS) set in the process environment.  It prints a single
 * JSON line to stdout containing:
 *   - `constant`:  the resolved MTIME_TRUNCATION_TOLERANCE_MS value (from
 *                  probe-cache's IIFE)
 *   - `result`:    the return value of consumeProbeCache() called against a
 *                  sentinel file backdated to MAX_SENTINEL_AGE_HOURS + 600 ms
 *                  ago
 *
 * Spawning a fresh process guarantees that the module-level IIFEs in
 * probe-cache run against the subprocess environment — Vitest module-level
 * caching or any prior vi.resetModules() state in the test runner cannot
 * interfere.
 *
 * Sentinel positioning (with MAX_SENTINEL_AGE_HOURS=1 as supplied by the
 * tests):
 *
 *   ageMs = maxAgeMs + 600 ms  (600 ms past the raw age limit)
 *
 *   tolerance < 600 ms  → ageMs > maxAgeMs + tolerance  → REJECTED
 *   tolerance ≥ 600 ms  → ageMs ≤ maxAgeMs + tolerance  → ACCEPTED
 *                          (as long as in-process timing noise is well below
 *                           the 400 ms gap between 600 ms and 1000 ms)
 *
 * With the production default (1 000 ms), the sentinel is accepted.
 * With tolerance=400 (test override), the sentinel is rejected.
 * With tolerance=2 000 (wide override), the sentinel is accepted.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MTIME_TRUNCATION_TOLERANCE_MS,
  MAX_SENTINEL_AGE_HOURS,
  consumeProbeCache,
  PROBE_CACHE_SENTINEL,
} from "./probe-cache";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Silence the stale-sentinel console.warn so subprocess stdout contains only
// the JSON output the test asserts on.
const _warn = console.warn;
console.warn = () => {};
// Also suppress the warm-start console.log for clean stdout.
const _log = console.log;
console.log = () => {};

const buildDir = ".next-probe-mtime-ci";
const tmpDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "probe-cache-mtime-ci-"),
);

try {
  // Create a real build directory so the existence check inside consumeProbeCache
  // passes regardless of which threshold the IIFE resolves to.
  fs.mkdirSync(path.join(tmpDir, buildDir));

  const sentinelPath = path.join(tmpDir, PROBE_CACHE_SENTINEL);
  fs.writeFileSync(sentinelPath, buildDir, "utf8");

  // Backdate the sentinel to (maxAgeMs + 600 ms) ago.
  //
  // The 600 ms overshoot is the deciding factor for MTIME_TRUNCATION_TOLERANCE_MS:
  //   • tolerance < 600 ms: ageMs > maxAgeMs + tolerance → guard fires → REJECTED
  //   • tolerance ≥ 600 ms: ageMs ≤ maxAgeMs + tolerance → guard silent → ACCEPTED
  //     (in-process timing noise is well below the 400 ms safety margin between
  //     the 600 ms overshoot and the 1 000 ms default tolerance)
  //
  // Tests pass MAX_SENTINEL_AGE_HOURS=1 so maxAgeMs = 3 600 000 ms (1 hour).
  const maxAgeMs = MAX_SENTINEL_AGE_HOURS * 60 * 60 * 1000;
  const overshootMs = 600;
  const backdatedMtime = new Date(Date.now() - (maxAgeMs + overshootMs));
  fs.utimesSync(sentinelPath, backdatedMtime, backdatedMtime);

  const result = consumeProbeCache(tmpDir);

  // Restore console before writing so the JSON line reaches stdout cleanly.
  console.warn = _warn;
  console.log = _log;

  process.stdout.write(
    JSON.stringify({ constant: MTIME_TRUNCATION_TOLERANCE_MS, result }) + "\n",
  );
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
