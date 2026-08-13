/**
 * probe-cache-meta-guard-check.ts
 *
 * Subprocess helper invoked by the second-order meta-test in
 * probe-cache.test.ts.  It runs the same mtime-truncation scenario as the
 * primary meta-test but reads MTIME_TRUNCATION_TOLERANCE_MS from the process
 * environment (without overriding it), so the outer test can inject a bypass
 * value and verify that the guard fails to reject the sentinel.
 *
 * Exit codes:
 *   0 — guard fired correctly  (result is null; sentinel was rejected)  → outer test: bypass NOT in effect
 *   1 — guard did not fire     (result is non-null; sentinel was accepted) → outer test: bypass IS in effect
 *   2 — unexpected setup error
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

void (async () => {
  // Dynamic import so we can vary MTIME_TRUNCATION_TOLERANCE_MS via env
  // without module-level caching issues.
  const { consumeProbeCache, PROBE_CACHE_SENTINEL, MTIME_TRUNCATION_TOLERANCE_MS } =
    (await import("./probe-cache")) as any;

  // ── Identical mtime scenario to the primary meta-test ──────────────────────
  //
  // fakeNow: millisecond component pinned to 500
  //   trueAge  = maxAgeMs − 300   (300 ms inside the raw age limit)
  //   trueMtime ms component       = 800  (derived below)
  //   truncationError              = 800 ms  (filesystem rounds mtime to second boundary)
  //   computedAge                  = maxAgeMs + 500  (500 ms net overshoot)
  //
  // With tolerance <  500 ms → guard fires → result is null  → exit 0
  // With tolerance >= 500 ms → guard is silent → result non-null → exit 1

  const maxAgeMs = 86_400_000; // 24 h — pinned constant, must match production default
  const fakeNow = Math.floor(Date.now() / 1000) * 1000 + 500;
  const trueAge = maxAgeMs - 300;
  const trueMtime = fakeNow - trueAge;
  const truncatedMtime = Math.floor(trueMtime / 1000) * 1000; // simulate 1-second fs truncation

  const truncationError = trueMtime - truncatedMtime;
  if (truncationError !== 800) {
    process.stderr.write(
      `[probe-cache-meta-guard-check] Unexpected truncation error: ${truncationError} ms ` +
        `(expected 800). fakeNow=${fakeNow} trueMtime=${trueMtime}.\n`,
    );
    process.exit(2);
  }

  // Log the loaded tolerance so the test's stdout shows what value was in use.
  process.stderr.write(
    `[probe-cache-meta-guard-check] MTIME_TRUNCATION_TOLERANCE_MS=${String(MTIME_TRUNCATION_TOLERANCE_MS)} ` +
      `fakeNow=${fakeNow} truncatedMtime=${truncatedMtime} ` +
      `overshoot=500ms\n`,
  );

  // ── Real filesystem temp dir ────────────────────────────────────────────────
  // consumeProbeCache reads a real sentinel file via fs.statSync/readFileSync.
  // We create a genuine file and use fs.utimesSync to pin its mtime to
  // truncatedMtime (already on a second boundary, so utimesSync stores it
  // without further truncation on any POSIX filesystem).

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-meta-guard-"));
  try {
    const buildDir = ".next-probe-meta-guard";
    fs.mkdirSync(path.join(tmpDir, buildDir));

    const sentinelPath = path.join(tmpDir, String(PROBE_CACHE_SENTINEL));
    fs.writeFileSync(sentinelPath, buildDir, "utf8");

    // Pin the sentinel mtime to the truncated value.
    fs.utimesSync(sentinelPath, new Date(truncatedMtime), new Date(truncatedMtime));

    // Verify utimesSync stored the expected mtime.
    const storedMtime = fs.statSync(sentinelPath).mtime.getTime();
    if (storedMtime !== truncatedMtime) {
      process.stderr.write(
        `[probe-cache-meta-guard-check] utimesSync mtime mismatch: ` +
          `stored=${storedMtime} expected=${truncatedMtime}. ` +
          `Filesystem may not support sub-second mtime.\n`,
      );
      process.exit(2);
    }

    // Patch Date.now globally so consumeProbeCache sees fakeNow.
    const realDateNow = Date.now.bind(Date);
    Date.now = (): number => fakeNow;

    let result: string | null;
    try {
      result = (consumeProbeCache as (dir: string) => string | null)(tmpDir);
    } finally {
      Date.now = realDateNow;
    }

    process.stderr.write(
      `[probe-cache-meta-guard-check] result=${result === null ? "null (rejected)" : `"${result}" (accepted)`}\n`,
    );

    if (result === null) {
      // Guard fired — tolerance was narrow enough to reject the 500 ms overshoot.
      process.exit(0);
    } else {
      // Guard did not fire — tolerance was too wide; sentinel was accepted.
      process.exit(1);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})();
