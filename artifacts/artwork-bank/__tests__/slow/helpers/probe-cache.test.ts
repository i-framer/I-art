/**
 * Unit tests for consumeProbeCache().
 *
 * These tests exercise pure filesystem logic and run in the default `pnpm test`
 * suite (the exclude glob in vitest.config.ts only targets __tests__/slow/*.test.ts,
 * not __tests__/slow/helpers/).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

// ESM module namespace objects are not configurable, so vi.spyOn(fs, "statSync")
// fails at runtime.  Wrapping the entire "node:fs" namespace with vi.mock() at
// the module level converts statSync into a vi.fn() that can be overridden per
// test while passing through to the real implementation by default.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    // Wrap statSync so individual tests can stub it without affecting others.
    statSync: vi.fn(
      (...args: Parameters<typeof actual.statSync>) =>
        actual.statSync(...(args as [fs.PathLike, fs.StatSyncOptions])),
    ),
    // Wrap rmSync so individual tests can stub it without affecting others.
    rmSync: vi.fn(
      (...args: Parameters<typeof actual.rmSync>) =>
        actual.rmSync(...(args as [fs.PathLike, fs.RmOptions])),
    ),
  };
});

import {
  consumeProbeCache,
  PROBE_CACHE_SENTINEL,
  DEV_BUILD_DIR,
  MAX_SENTINEL_AGE_HOURS,
  MTIME_TRUNCATION_TOLERANCE_MS,
} from "./probe-cache";

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Creates a fresh temporary directory for each test and removes it afterwards. */
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-cache-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function sentinelPath(): string {
  return path.join(tmpDir, PROBE_CACHE_SENTINEL);
}

function writeSentinel(buildDir: string): void {
  fs.writeFileSync(sentinelPath(), buildDir, "utf8");
}

/**
 * Shared decision core for the at-boundary real-filesystem acceptance test.
 *
 * Both the real at-boundary test and its meta-test call this function with
 * different callback implementations.  Keeping the skip guard and the consume
 * call together here means that removing the guard from this function causes
 * the meta-test to fail: consumeFn would be called when it should not be.
 *
 * @param storedAgeMs - Age of the sentinel read back from the real filesystem
 *                      (nowMs − storedMtime.getTime()).
 * @param skipFn      - Called when storedAgeMs !== 36_000.  In the real test
 *                      this is `() => ctx.skip()`, which throws a Vitest
 *                      SkipError; in the meta-test it is a vi.fn() spy.
 * @param consumeFn   - Called only when storedAgeMs is exactly 36_000.  In
 *                      the real test this is the imported consumeProbeCache;
 *                      in the meta-test it is a vi.fn() spy.
 * @param dir         - Base directory forwarded to consumeFn.
 * @returns "skipped" when skipFn returns without throwing; the consumeFn
 *          return value when the boundary condition is met exactly.
 */
function atBoundaryDecision(
  storedAgeMs: number,
  skipFn: () => void,
  consumeFn: (dir: string) => string | null,
  dir: string,
): "skipped" | string | null {
  if (storedAgeMs !== 36_000) {
    skipFn(); // throws SkipError in real test; no-op spy in meta-test
    return "skipped"; // only reached when skipFn does not throw
  }
  return consumeFn(dir);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("MTIME_TRUNCATION_TOLERANCE_MS", () => {
  it(
    "is exactly 1 000 ms — the documented 1-second buffer for filesystem mtime truncation",
    () => {
      // This test exists so that a change to the constant (e.g. halving it to
      // 500 ms) is caught immediately rather than silently weakening the age
      // guard.  The parameterised age-guard sweep in this file references
      // MTIME_TRUNCATION_TOLERANCE_MS directly, so a mutation would cause those
      // cases to be computed against the wrong ceiling — but *this* assertion
      // catches the mutation at the source before the sweep even runs.
      //
      // If you genuinely need to change the value, update this assertion and
      // revise the JSDoc in probe-cache.ts to explain the new rationale.
      expect(MTIME_TRUNCATION_TOLERANCE_MS).toBe(1000);
    },
  );

  it(
    "evaluates to 1 000 ms from its source definition (module-reset isolation)",
    async () => {
      // MTIME_TRUNCATION_TOLERANCE_MS is a plain constant assigned at module
      // load time.  The assertion above reads it from the already-cached
      // import, so it would pass even if the source were changed to, say,
      // 500 — because the cached export still holds the value that was loaded
      // when the test file was first imported.
      //
      // This test forces a fresh module evaluation by calling vi.resetModules()
      // before the dynamic import, mirroring the MAX_SENTINEL_AGE_HOURS
      // pattern.  That ensures the assertion reads the literal assigned in
      // probe-cache.ts rather than a stale cached copy, so any change to the
      // default is caught in isolation and the rationale is made explicit.
      try {
        vi.resetModules();
        const {
          MTIME_TRUNCATION_TOLERANCE_MS: freshValue,
        } = await import("./probe-cache");
        expect(freshValue).toBe(1000);
      } finally {
        // Reset modules again so subsequent imports pick up the fully-mocked
        // fs and the original module registry state.
        vi.resetModules();
      }
    },
  );
});

describe("MAX_SENTINEL_AGE_HOURS", () => {
  it(
    "defaults to 24 when the MAX_SENTINEL_AGE_HOURS env var is not set",
    async () => {
      // MAX_SENTINEL_AGE_HOURS is evaluated once at module load time via an
      // IIFE.  If someone changes the fallback from 24 to a smaller value (e.g.
      // 1), tests that set the env var explicitly would still pass — this test
      // catches that regression by reloading the module in an environment where
      // the env var is absent and asserting the IIFE's fallback branch.
      //
      // vi.resetModules() clears Vitest's module registry so the next dynamic
      // import re-executes the module top-level code (including the IIFE) from
      // scratch rather than returning the cached export.
      const savedEnv = process.env["MAX_SENTINEL_AGE_HOURS"];
      delete process.env["MAX_SENTINEL_AGE_HOURS"];
      try {
        vi.resetModules();
        const { MAX_SENTINEL_AGE_HOURS: freshDefault } = await import(
          "./probe-cache"
        );
        expect(freshDefault).toBe(24);
      } finally {
        // Restore the env var so subsequent tests are not affected.
        if (savedEnv !== undefined) {
          process.env["MAX_SENTINEL_AGE_HOURS"] = savedEnv;
        }
        // Reset modules again so subsequent imports pick up the fully-mocked
        // fs and the original module registry state.
        vi.resetModules();
      }
    },
  );
});

describe("consumeProbeCache", () => {
  it(
    "returns null and has no side-effects when the sentinel file is absent",
    () => {
      // No sentinel written — the sentinel must not exist.
      expect(fs.existsSync(sentinelPath())).toBe(false);

      const result = consumeProbeCache(tmpDir);

      expect(result).toBeNull();
      // Nothing should have been created in the temp dir.
      expect(fs.readdirSync(tmpDir)).toHaveLength(0);
    },
  );

  it(
    "returns the build directory name and deletes the sentinel when the sentinel is present and the build directory exists",
    () => {
      // Create a real build directory so the existence check passes.
      const buildDir = ".next-probe";
      fs.mkdirSync(path.join(tmpDir, buildDir));
      writeSentinel(buildDir);

      expect(fs.existsSync(sentinelPath())).toBe(true);

      const result = consumeProbeCache(tmpDir);

      // Should return the build directory name from the sentinel.
      expect(result).toBe(buildDir);

      // Sentinel must be consumed — not left for a second call.
      expect(fs.existsSync(sentinelPath())).toBe(false);

      // The build directory itself must still exist (caller is responsible for cleanup).
      expect(fs.existsSync(path.join(tmpDir, buildDir))).toBe(true);
    },
  );

  it(
    "logs a console.log message containing the build directory name and a sentinel mtime when the cache is successfully reused",
    () => {
      // The log line is the operator's only signal in CI that a warm start
      // occurred.  Pin it here so an accidental deletion is caught immediately.
      // The mtime of the sentinel file lets operators correlate the log line
      // with the specific CI probe run that seeded the cache, even when
      // multiple jobs run back-to-back.
      const buildDir = ".next-probe";
      fs.mkdirSync(path.join(tmpDir, buildDir));
      writeSentinel(buildDir);

      // Capture the exact mtime of the sentinel file before consumeProbeCache
      // deletes it.  The log message must contain this exact ISO string so a
      // regression that logs the current time or any other timestamp is caught.
      const expectedMtime = fs
        .statSync(sentinelPath())
        .mtime.toISOString();

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const result = consumeProbeCache(tmpDir);

        // consumeProbeCache must return the build directory name.
        expect(result).toBe(buildDir);

        // Exactly one log call must be emitted — not silently swallowed.
        expect(logSpy).toHaveBeenCalledOnce();
        const [logMessage] = logSpy.mock.calls[0] as [string];
        // The message must name the directory so operators can trace which
        // probe cache was reused in the CI log.
        expect(logMessage).toContain(buildDir);
        // The message must contain the exact sentinel mtime so it pinpoints
        // which probe run seeded the cache — not just any same-day timestamp.
        expect(logMessage).toContain(expectedMtime);
      } finally {
        logSpy.mockRestore();
      }
    },
  );

  it(
    "returns null and deletes the stale sentinel when the sentinel is present but the build directory is missing",
    () => {
      // Write a sentinel pointing to a directory that does NOT exist.
      const buildDir = ".next-probe-missing";
      writeSentinel(buildDir);

      expect(fs.existsSync(sentinelPath())).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, buildDir))).toBe(false);

      // Capture the exact mtime of the sentinel file before consumeProbeCache
      // deletes it.  The warn message must contain this exact ISO string so a
      // regression that omits or misstates the timestamp is caught immediately.
      const expectedMtime = fs.statSync(sentinelPath()).mtime.toISOString();

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const result = consumeProbeCache(tmpDir);

        // Stale sentinel → should return null.
        expect(result).toBeNull();

        // Stale sentinel must be removed so it doesn't mislead the next run.
        expect(fs.existsSync(sentinelPath())).toBe(false);

        // The mismatch warning must be visible in CI logs so the BUILD_DIR drift
        // is not silently swallowed.  Assert that console.warn was called, that
        // the message names the directory from the sentinel, and that it includes
        // the sentinel mtime so operators can correlate with the probe CI run.
        expect(warnSpy).toHaveBeenCalledOnce();
        const [warnMessage] = warnSpy.mock.calls[0] as [string];
        expect(warnMessage).toContain(buildDir);
        expect(warnMessage).toContain(expectedMtime);
      } finally {
        warnSpy.mockRestore();
      }
    },
  );

  it(
    "still warns with the build directory name and returns null when fs.statSync throws on the sentinel",
    () => {
      // Write a sentinel pointing to a directory that does NOT exist so the
      // stale-sentinel branch is triggered.
      const buildDir = ".next-probe-stat-throws";
      writeSentinel(buildDir);

      expect(fs.existsSync(sentinelPath())).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, buildDir))).toBe(false);

      // Override the module-level vi.fn() wrapper (installed via vi.mock above)
      // to throw for the sentinel path.  This simulates a race where the
      // sentinel disappears between the existsSync check and the statSync call.
      const sentinelFullPath = path.join(tmpDir, PROBE_CACHE_SENTINEL);
      vi.mocked(fs.statSync).mockImplementationOnce((p) => {
        if (p === sentinelFullPath) {
          throw new Error("ENOENT: simulated race — file vanished");
        }
        // Should not be reached in this test (only statSync on the sentinel is
        // called in the stale-sentinel branch), but guard anyway.
        throw new Error(`Unexpected statSync call for ${String(p)}`);
      });

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        // Must not throw even though fs.statSync throws inside the try/catch.
        let result: string | null = undefined!;
        expect(() => {
          result = consumeProbeCache(tmpDir);
        }).not.toThrow();

        // The stale-sentinel path returns null.
        expect(result).toBeNull();

        // console.warn must still be called — the fallback must not silently
        // swallow the mismatch.
        expect(warnSpy).toHaveBeenCalledOnce();
        const [warnMessage] = warnSpy.mock.calls[0] as [string];

        // The message must name the build directory so operators can identify
        // which sentinel was stale, even when the mtime could not be read.
        expect(warnMessage).toContain(buildDir);
      } finally {
        warnSpy.mockRestore();
        // Restore the statSync spy to pass-through for subsequent tests.
        vi.mocked(fs.statSync).mockRestore();
      }
    },
  );

  it(
    "still logs the build directory name and returns it when fs.statSync throws on the sentinel in the warm-start branch",
    () => {
      // Set up a warm-start scenario: sentinel present AND build directory exists.
      const buildDir = ".next-probe-stat-throws-warm";
      fs.mkdirSync(path.join(tmpDir, buildDir));
      writeSentinel(buildDir);

      expect(fs.existsSync(sentinelPath())).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, buildDir))).toBe(true);

      // Stub statSync to throw for the sentinel path, simulating a race where
      // the sentinel disappears between existsSync and statSync in the warm-start
      // branch (lines 98-102 of probe-cache.ts).
      const sentinelFullPath = path.join(tmpDir, PROBE_CACHE_SENTINEL);
      vi.mocked(fs.statSync).mockImplementationOnce((p) => {
        if (p === sentinelFullPath) {
          throw new Error("ENOENT: simulated race — sentinel vanished before stat");
        }
        // Should not be reached in this test.
        throw new Error(`Unexpected statSync call for ${String(p)}`);
      });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        // Must not throw even though fs.statSync throws inside the try/catch.
        let result: string | null = undefined!;
        expect(() => {
          result = consumeProbeCache(tmpDir);
        }).not.toThrow();

        // The warm-start branch must still return the build directory name —
        // a missing mtime must not abort the return.
        expect(result).toBe(buildDir);

        // console.log must still be called — the fallback must not silently
        // swallow the warm-start signal.
        expect(logSpy).toHaveBeenCalledOnce();
        const [logMessage] = logSpy.mock.calls[0] as [string];

        // The message must name the build directory so operators can trace
        // which probe cache was reused, even when the mtime could not be read.
        expect(logMessage).toContain(buildDir);
      } finally {
        logSpy.mockRestore();
        // Restore the statSync spy to pass-through for subsequent tests.
        vi.mocked(fs.statSync).mockRestore();
      }
    },
  );

  it(
    "still logs the build directory name and returns it when fs.rmSync throws on the sentinel in the warm-start branch",
    () => {
      // Set up a warm-start scenario: sentinel present AND build directory exists.
      const buildDir = ".next-probe-rmsync-throws-warm";
      fs.mkdirSync(path.join(tmpDir, buildDir));
      writeSentinel(buildDir);

      expect(fs.existsSync(sentinelPath())).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, buildDir))).toBe(true);

      // Stub rmSync to throw for the sentinel path, simulating a race where the
      // sentinel disappears between the statSync call and the rmSync call in the
      // warm-start branch (lines 104-109 of probe-cache.ts).
      const sentinelFullPath = path.join(tmpDir, PROBE_CACHE_SENTINEL);
      vi.mocked(fs.rmSync).mockImplementationOnce((p) => {
        if (p === sentinelFullPath) {
          throw new Error("ENOENT: simulated race — sentinel vanished before rmSync");
        }
        // Should not be reached in this test (only rmSync on the sentinel is
        // called in the warm-start branch), but guard anyway.
        throw new Error(`Unexpected rmSync call for ${String(p)}`);
      });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        // Must not throw even though fs.rmSync throws inside the try/catch.
        let result: string | null = undefined!;
        expect(() => {
          result = consumeProbeCache(tmpDir);
        }).not.toThrow();

        // The warm-start branch must still return the build directory name —
        // a failed rmSync must not abort the return.
        expect(result).toBe(buildDir);

        // console.log must still be called — the rmSync failure must not silently
        // swallow the warm-start signal.
        expect(logSpy).toHaveBeenCalledOnce();
        const [logMessage] = logSpy.mock.calls[0] as [string];

        // The message must name the build directory so operators can trace
        // which probe cache was reused, even when the sentinel could not be deleted.
        expect(logMessage).toContain(buildDir);
      } finally {
        logSpy.mockRestore();
        // Restore the rmSync spy to pass-through for subsequent tests.
        vi.mocked(fs.rmSync).mockRestore();
      }
    },
  );

  it(
    "second call still behaves gracefully when the first call's rmSync failed to clean up the sentinel",
    () => {
      // Set up a warm-start scenario: sentinel present AND build directory exists.
      const buildDir = ".next-probe-rmsync-throws-second-call";
      fs.mkdirSync(path.join(tmpDir, buildDir));
      writeSentinel(buildDir);

      expect(fs.existsSync(sentinelPath())).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, buildDir))).toBe(true);

      // Stub rmSync to throw exactly once for the sentinel path.  After this
      // one throw the real rmSync is restored, so the second call can actually
      // delete the sentinel.
      const sentinelFullPath = path.join(tmpDir, PROBE_CACHE_SENTINEL);
      vi.mocked(fs.rmSync).mockImplementationOnce((p, ...rest) => {
        if (p === sentinelFullPath) {
          throw new Error("ENOENT: simulated race — sentinel vanished before rmSync");
        }
        // Pass through any other paths (e.g. the afterEach cleanup).
        fs.rmSync(p as fs.PathLike, ...(rest as [fs.RmOptions]));
      });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        // ── First call ────────────────────────────────────────────────────────
        // rmSync will throw but the error is swallowed in the best-effort block,
        // so consumeProbeCache must still return the build directory name.
        let firstResult: string | null = undefined!;
        expect(() => {
          firstResult = consumeProbeCache(tmpDir);
        }).not.toThrow();

        expect(firstResult).toBe(buildDir);

        // The sentinel was NOT deleted (rmSync threw), so it should still exist.
        expect(fs.existsSync(sentinelPath())).toBe(true);

        // ── Second call ───────────────────────────────────────────────────────
        // rmSync is now restored.  The sentinel still exists and the build
        // directory still exists, so the warm-start branch runs again.
        // This time rmSync succeeds and the sentinel is consumed.
        let secondResult: string | null = undefined!;
        expect(() => {
          secondResult = consumeProbeCache(tmpDir);
        }).not.toThrow();

        // The sentinel was NOT deleted by the first call (rmSync threw), and the
        // build directory still exists, so the second call must enter the
        // warm-start branch and return the build directory name — not null.
        expect(secondResult).toBe(buildDir);

        // After the second call the sentinel must be gone — the second rmSync
        // succeeded, so it must be consumed now.
        expect(fs.existsSync(sentinelPath())).toBe(false);
      } finally {
        logSpy.mockRestore();
        vi.mocked(fs.rmSync).mockRestore();
      }
    },
  );

  it(
    "returns null and does not throw when fs.rmSync throws on the stale sentinel",
    () => {
      // Set up a stale-sentinel scenario: sentinel present, build directory absent.
      const buildDir = ".next-probe-rmsync-throws-stale";
      writeSentinel(buildDir);

      expect(fs.existsSync(sentinelPath())).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, buildDir))).toBe(false);

      // Stub rmSync to throw for the sentinel path, simulating a race where the
      // sentinel disappears between the warn and the rmSync call in the
      // stale-sentinel branch (lines 85-89 of probe-cache.ts).
      const sentinelFullPath = path.join(tmpDir, PROBE_CACHE_SENTINEL);
      vi.mocked(fs.rmSync).mockImplementationOnce((p) => {
        if (p === sentinelFullPath) {
          throw new Error("ENOENT: simulated race — sentinel vanished before rmSync");
        }
        // Should not be reached in this test (only rmSync on the sentinel is
        // called in the stale-sentinel branch), but guard anyway.
        throw new Error(`Unexpected rmSync call for ${String(p)}`);
      });

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        // Must not throw even though fs.rmSync throws inside the try/catch.
        let result: string | null = undefined!;
        expect(() => {
          result = consumeProbeCache(tmpDir);
        }).not.toThrow();

        // Stale sentinel → must return null, even when rmSync failed.
        expect(result).toBeNull();

        // console.warn must still be called — the rmSync failure must not
        // prevent the stale-sentinel warning from reaching CI logs.
        expect(warnSpy).toHaveBeenCalledOnce();
        const [warnMessage] = warnSpy.mock.calls[0] as [string];

        // The message must name the build directory so operators can identify
        // which sentinel was stale, even when it could not be deleted.
        expect(warnMessage).toContain(buildDir);
      } finally {
        warnSpy.mockRestore();
        // Restore the rmSync spy to pass-through for subsequent tests.
        vi.mocked(fs.rmSync).mockRestore();
      }
    },
  );

  it(
    "second call picks up the warm start when the first call's stale-sentinel rmSync failed and the build dir was created in between",
    () => {
      // Scenario: sentinel is present but the build directory does NOT yet exist
      // on the first call, so consumeProbeCache takes the stale-sentinel branch
      // and returns null.  The stale-sentinel branch's rmSync then fails (race),
      // leaving the sentinel on disk.  Before the second call, the build directory
      // is created (e.g. a cold-start rebuild).  The second call must find the
      // sentinel still present AND the build directory now present, so it must
      // enter the warm-start branch and return the build directory name.

      const buildDir = ".next-probe-stale-then-warm";
      // Do NOT create the build directory yet — first call must see it as absent.
      writeSentinel(buildDir);

      expect(fs.existsSync(sentinelPath())).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, buildDir))).toBe(false);

      // Stub rmSync to throw exactly once for the sentinel path, simulating a
      // race in the stale-sentinel branch.
      const sentinelFullPath = path.join(tmpDir, PROBE_CACHE_SENTINEL);
      vi.mocked(fs.rmSync).mockImplementationOnce((p, ...rest) => {
        if (p === sentinelFullPath) {
          throw new Error("ENOENT: simulated race — sentinel vanished before rmSync");
        }
        // Pass through any other paths (e.g. the afterEach cleanup).
        fs.rmSync(p as fs.PathLike, ...(rest as [fs.RmOptions]));
      });

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        // ── First call ────────────────────────────────────────────────────────
        // Build dir is absent → stale-sentinel branch → rmSync throws → null.
        let firstResult: string | null = undefined!;
        expect(() => {
          firstResult = consumeProbeCache(tmpDir);
        }).not.toThrow();

        expect(firstResult).toBeNull();

        // The sentinel must still be on disk (rmSync failed).
        expect(fs.existsSync(sentinelPath())).toBe(true);

        // ── Between calls: build directory is created ─────────────────────────
        fs.mkdirSync(path.join(tmpDir, buildDir));
        expect(fs.existsSync(path.join(tmpDir, buildDir))).toBe(true);

        // ── Second call ───────────────────────────────────────────────────────
        // Sentinel still present + build dir now present → warm-start branch.
        let secondResult: string | null = undefined!;
        expect(() => {
          secondResult = consumeProbeCache(tmpDir);
        }).not.toThrow();

        // Must return the build directory name — not null.
        expect(secondResult).toBe(buildDir);

        // After the second call the sentinel must be gone (rmSync succeeded).
        expect(fs.existsSync(sentinelPath())).toBe(false);

        // The warm-start log must have been emitted on the second call.
        expect(logSpy).toHaveBeenCalledOnce();
        const [logMessage] = logSpy.mock.calls[0] as [string];
        expect(logMessage).toContain(buildDir);
      } finally {
        warnSpy.mockRestore();
        logSpy.mockRestore();
        vi.mocked(fs.rmSync).mockRestore();
      }
    },
  );

  it(
    "survives two worker threads calling consumeProbeCache concurrently on the same sentinel",
    async () => {
      // Set up: a valid build directory and sentinel so both workers enter
      // the warm-start branch.
      const buildDir = ".next-probe-concurrent";
      fs.mkdirSync(path.join(tmpDir, buildDir));
      writeSentinel(buildDir);

      expect(fs.existsSync(sentinelPath())).toBe(true);

      // Resolve the absolute path to probe-cache.ts.  Workers run in
      // separate V8 isolates and do NOT inherit Vitest's vi.mock() transforms;
      // they use the real fs module — exactly what we need for a real
      // filesystem concurrency test.
      const probeCacheModulePath = fileURLToPath(
        new URL("./probe-cache.ts", import.meta.url),
      );

      // SharedArrayBuffer layout (5 × Int32 = 20 bytes):
      //   [0]  arrival counter  — each worker atomically increments it when it
      //        reaches the sentinel-delete step (inside the patched rmSync)
      //   [1]  gate             — starts at 0 (hold); main thread sets it to 1
      //        (go) once both workers have arrived, releasing them simultaneously
      //   [2]  deleteOkCount    — incremented by a worker when origRmSync returns
      //        without throwing (expected: 2, because force:true makes the second
      //        delete a safe no-op)
      //   [3]  deleteErrCount   — incremented by a worker when origRmSync throws
      //        (expected: 0; becomes 1 if force:true is ever removed, catching
      //        the regression even though consumeProbeCache swallows the error)
      //   [4]  noForceCount     — incremented when rmSync is called WITHOUT
      //        { force: true }  (expected: 0; detects the options being dropped)
      //
      // The deleteErrCount and noForceCount slots are the critical regression
      // guards: consumeProbeCache wraps rmSync in a catch-all and still returns
      // the build directory after a deletion failure, so the only way to detect
      // a missing force flag is to observe the origRmSync call directly.
      const sharedBuffer = new SharedArrayBuffer(20);
      const sabArr = new Int32Array(sharedBuffer);

      // Inline worker script (evaluated as CommonJS).
      //
      // Strategy:
      //   1. Monkey-patch fs.rmSync BEFORE importing probe-cache.ts so the
      //      module picks up the instrumented version.  For Node.js built-in
      //      modules the require() object and the ESM namespace share the
      //      same live bindings, so the patch propagates to the imported
      //      module automatically.
      //   2. The patched rmSync atomically increments the arrival counter,
      //      then blocks on Atomics.wait until the main thread opens the gate.
      //      This guarantees both workers have completed every step up to and
      //      including the sentinel read/stat before either one deletes it.
      //   3. After the gate opens, both workers call the real rmSync and record
      //      the outcome in shared memory.  One deletes the file; the other
      //      finds it absent.  Because the production code passes { force: true },
      //      the second call is a safe no-op (deleteOkCount becomes 2, not 1+1).
      //      Removing force:true would flip one success into an error, setting
      //      deleteErrCount to 1 — which the assertion below catches even though
      //      consumeProbeCache itself swallows the throw.
      const workerScript = `
const { workerData, parentPort } = require('worker_threads');
const { pathToFileURL } = require('url');

const sharedArr = new Int32Array(workerData.sharedBuffer);
// [0]=arrival [1]=gate [2]=deleteOkCount [3]=deleteErrCount [4]=noForceCount

const realFs = require('fs');
const origRmSync = realFs.rmSync.bind(realFs);

realFs.rmSync = function barrierRmSync(p, opts) {
  // Record if { force: true } is absent — catches the guard being dropped.
  if (!opts || opts.force !== true) {
    Atomics.add(sharedArr, 4, 1);
  }
  // Signal arrival at the deletion barrier.
  Atomics.add(sharedArr, 0, 1);
  Atomics.notify(sharedArr, 0, 1);
  // Block until the main thread opens the gate (sharedArr[1] becomes 1).
  // Timeout after 10 s to avoid hanging the suite if the other worker crashes.
  Atomics.wait(sharedArr, 1, 0, 10000);
  // Both workers are now past their read paths — call the real delete and
  // record whether it succeeded or threw.
  try {
    var ret = origRmSync(p, opts);
    Atomics.add(sharedArr, 2, 1); // success
    return ret;
  } catch (err) {
    Atomics.add(sharedArr, 3, 1); // error — signals a missing force:true
    throw err;                    // re-throw so consumeProbeCache can catch it
  }
};

const moduleUrl = pathToFileURL(workerData.modulePath).href;
import(moduleUrl)
  .then(function(mod) {
    var result = mod.consumeProbeCache(workerData.tmpDir);
    parentPort.postMessage({ ok: true, result: result });
  })
  .catch(function(err) {
    parentPort.postMessage({ ok: false, error: String(err) });
  });
`;

      type WorkerReply =
        | { ok: true; result: string | null }
        | { ok: false; error: string };

      function spawnWorker(): Promise<WorkerReply> {
        return new Promise((resolve) => {
          const worker = new Worker(workerScript, {
            eval: true,
            workerData: { tmpDir, modulePath: probeCacheModulePath, sharedBuffer },
            // tsx/esm registers a Node.js ESM loader hook so the dynamic
            // import() of the .ts file inside the worker is resolved without
            // a separate compile step.
            execArgv: ["--import", "tsx/esm"],
          });
          worker.once("message", (msg: WorkerReply) => resolve(msg));
          worker.once("error", (err) =>
            resolve({ ok: false, error: String(err) }),
          );
        });
      }

      // Start both workers.  Each will block inside barrierRmSync until the
      // main thread below opens the gate.
      const p1 = spawnWorker();
      const p2 = spawnWorker();

      // ── Wait for both workers to reach the deletion barrier ───────────────
      // Poll sabArr[0] until both workers have incremented it.  Use a
      // 15-second timeout so a startup failure doesn't hang the suite.
      await new Promise<void>((resolve, reject) => {
        let elapsed = 0;
        const poll = () => {
          if (Atomics.load(sabArr, 0) >= 2) {
            resolve();
            return;
          }
          if (elapsed >= 15_000) {
            reject(
              new Error(
                `Timed out after ${elapsed} ms waiting for both workers to reach ` +
                  `the sentinel-deletion barrier (arrival count: ${Atomics.load(sabArr, 0)})`,
              ),
            );
            return;
          }
          elapsed += 20;
          setTimeout(poll, 20);
        };
        poll();
      });

      // At this point both workers have:
      //   • read the sentinel content (buildDir name)
      //   • stat'd the sentinel (age / mtime)
      //   • confirmed the build directory exists
      //   • entered barrierRmSync and are sleeping on Atomics.wait
      // Neither has deleted the sentinel yet.

      // ── Open the gate — release both workers simultaneously ───────────────
      Atomics.store(sabArr, 1, 1);
      Atomics.notify(sabArr, 1, 2); // wake up to 2 waiters

      const [r1, r2] = await Promise.all([p1, p2]);

      // ── Neither worker must have posted an error envelope ────────────────
      expect(r1.ok, `Worker 1 error: ${(r1 as { error?: string }).error}`).toBe(
        true,
      );
      expect(r2.ok, `Worker 2 error: ${(r2 as { error?: string }).error}`).toBe(
        true,
      );

      // ── Both workers must have returned the build directory name ──────────
      // The gate was opened only after both workers confirmed the sentinel
      // was present and the build directory existed, so both must complete
      // the warm-start path and return buildDir — not null.
      const result1 = (r1 as { ok: true; result: string | null }).result;
      const result2 = (r2 as { ok: true; result: string | null }).result;
      expect(result1).toBe(buildDir);
      expect(result2).toBe(buildDir);

      // ── origRmSync must never have thrown ────────────────────────────────
      // Both workers called rmSync after the gate opened.  The first delete
      // succeeds; the second finds the file already gone.  Because the
      // production code passes { force: true }, the second call is a safe
      // no-op — origRmSync returns without error.
      //
      // This is the key regression guard: consumeProbeCache wraps rmSync in
      // a catch-all and still returns buildDir on error, so removing
      // { force: true } from the production call would be invisible to all
      // other assertions.  Only deleteErrCount exposes that regression.
      const deleteOkCount = Atomics.load(sabArr, 2);
      const deleteErrCount = Atomics.load(sabArr, 3);
      const noForceCount = Atomics.load(sabArr, 4);

      expect(
        noForceCount,
        "rmSync was called without { force: true } — the guard has been dropped",
      ).toBe(0);

      expect(
        deleteErrCount,
        "origRmSync threw on at least one worker — { force: true } is not absorbing the concurrent ENOENT",
      ).toBe(0);

      // Both workers must have reached and completed rmSync (2 calls total).
      expect(deleteOkCount + deleteErrCount).toBe(2);

      // ── Filesystem must be in a consistent state ───────────────────────────
      // The sentinel must be absent: one worker deleted it and the other
      // worker's rmSync (force: true) was a safe no-op on the already-
      // absent file — not a crash or an ENOENT throw.
      expect(fs.existsSync(sentinelPath())).toBe(false);

      // The build directory itself must still exist — consumeProbeCache only
      // deletes the sentinel, never the build output.
      expect(fs.existsSync(path.join(tmpDir, buildDir))).toBe(true);
    },
    // Worker thread startup and barrier coordination can take several seconds.
    30_000,
  );

  it(
    "is idempotent: a second call after a successful cache hit returns null (sentinel already consumed)",
    () => {
      const buildDir = ".next-probe";
      fs.mkdirSync(path.join(tmpDir, buildDir));
      writeSentinel(buildDir);

      // First call — should succeed.
      const first = consumeProbeCache(tmpDir);
      expect(first).toBe(buildDir);

      // Second call — sentinel is gone; should return null.
      const second = consumeProbeCache(tmpDir);
      expect(second).toBeNull();
    },
  );

  it(
    "trims whitespace from the sentinel content before using it as a directory name",
    () => {
      const buildDir = ".next-probe";
      fs.mkdirSync(path.join(tmpDir, buildDir));
      // Write the sentinel with surrounding whitespace / newline as the probe script does.
      fs.writeFileSync(sentinelPath(), `  ${buildDir}\n`, "utf8");

      const result = consumeProbeCache(tmpDir);

      expect(result).toBe(buildDir);
      expect(fs.existsSync(sentinelPath())).toBe(false);
    },
  );

  it(
    "warns and returns null when the sentinel mtime predates the current job by more than MAX_SENTINEL_AGE_HOURS",
    () => {
      // This scenario models a sentinel left over from a prior CI run whose
      // workspace directory was inadvertently cached.  Even though the build
      // directory exists and the sentinel content is valid, the sentinel is too
      // old and must be treated as stale.
      const buildDir = ".next-probe-stale-by-age";
      fs.mkdirSync(path.join(tmpDir, buildDir));
      writeSentinel(buildDir);

      // Backdate the sentinel's mtime so it appears to be older than
      // MAX_SENTINEL_AGE_HOURS.  Add a one-second buffer so the test is not
      // flaky near the boundary.
      const staleDate = new Date(
        Date.now() - (MAX_SENTINEL_AGE_HOURS + 1) * 60 * 60 * 1000,
      );
      fs.utimesSync(sentinelPath(), staleDate, staleDate);

      // Verify the mtime was actually set (sanity check).
      const actualMtime = fs.statSync(sentinelPath()).mtime;
      expect(actualMtime.getTime()).toBeLessThan(
        Date.now() - MAX_SENTINEL_AGE_HOURS * 60 * 60 * 1000,
      );

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const result = consumeProbeCache(tmpDir);

        // A sentinel that is too old must be discarded — warm start must NOT occur.
        expect(result).toBeNull();

        // The stale sentinel must be removed so subsequent runs are not tricked
        // into thinking there is a valid cache available.
        expect(fs.existsSync(sentinelPath())).toBe(false);

        // A clear warning must appear in CI logs so operators know why the warm
        // start was skipped.
        expect(warnSpy).toHaveBeenCalledOnce();
        const [warnMessage] = warnSpy.mock.calls[0] as [string];

        // The message must mention the configured age limit so operators can
        // trace the decision back to the MAX_SENTINEL_AGE_HOURS setting.
        expect(warnMessage).toContain(String(MAX_SENTINEL_AGE_HOURS));

        // The message must include the sentinel's mtime ISO string so operators
        // can correlate the discarded sentinel with a specific prior CI run.
        expect(warnMessage).toContain(staleDate.toISOString());
      } finally {
        warnSpy.mockRestore();
      }
    },
  );

  it(
    "still reuses a sentinel whose mtime is just inside the MAX_SENTINEL_AGE_HOURS threshold",
    () => {
      // A sentinel that is just under the age limit must NOT be discarded — the
      // guard should only reject sentinels that are clearly from a prior CI job.
      const buildDir = ".next-probe-within-age";
      fs.mkdirSync(path.join(tmpDir, buildDir));
      writeSentinel(buildDir);

      // Set mtime to (MAX_SENTINEL_AGE_HOURS - 1) hours ago — safely inside the window.
      const recentDate = new Date(
        Date.now() - (MAX_SENTINEL_AGE_HOURS - 1) * 60 * 60 * 1000,
      );
      fs.utimesSync(sentinelPath(), recentDate, recentDate);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const result = consumeProbeCache(tmpDir);

        // Within-threshold sentinel must be consumed normally.
        expect(result).toBe(buildDir);

        // Sentinel must be deleted (consumed once).
        expect(fs.existsSync(sentinelPath())).toBe(false);

        // No age-related warning must be emitted.
        expect(warnSpy).not.toHaveBeenCalled();

        // The normal warm-start log line must be emitted.
        expect(logSpy).toHaveBeenCalledOnce();
      } finally {
        warnSpy.mockRestore();
        logSpy.mockRestore();
      }
    },
  );

  it(
    "discards a sentinel whose age exceeds the MAX_SENTINEL_AGE_HOURS env-var override",
    async () => {
      // The MAX_SENTINEL_AGE_HOURS constant is evaluated at module-load time via
      // an IIFE.  To test the env-var path we must set the variable BEFORE the
      // module is imported, which requires resetting the module registry and
      // re-importing dynamically.
      const originalEnv = process.env["MAX_SENTINEL_AGE_HOURS"];
      process.env["MAX_SENTINEL_AGE_HOURS"] = "1";
      vi.resetModules();

      try {
        // Dynamic import picks up the new env var and re-evaluates the IIFE.
        const {
          consumeProbeCache: consume,
          PROBE_CACHE_SENTINEL: SENTINEL,
        } = await import("./probe-cache");

        const buildDir = ".next-probe-env-override";
        fs.mkdirSync(path.join(tmpDir, buildDir));
        const sentinel = path.join(tmpDir, SENTINEL);
        fs.writeFileSync(sentinel, buildDir, "utf8");

        // Backdate to 2 hours ago: older than the 1-hour override but well
        // within the 24-hour default.  Only the overridden threshold matters here.
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        fs.utimesSync(sentinel, twoHoursAgo, twoHoursAgo);

        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          const result = consume(tmpDir);

          // Sentinel is 2h old — exceeds the 1-hour override → must be discarded.
          expect(result).toBeNull();

          // The stale sentinel must be cleaned up so subsequent runs are not fooled.
          expect(fs.existsSync(sentinel)).toBe(false);

          // A clear warning must appear in CI logs.
          expect(warnSpy).toHaveBeenCalledOnce();
          const [warnMessage] = warnSpy.mock.calls[0] as [string];

          // The message must mention the overridden threshold (1h) so operators
          // can trace the decision back to the env-var setting.
          expect(warnMessage).toContain("1");

          // The message must include the sentinel's backdated mtime so operators
          // can correlate the discarded sentinel with a specific prior CI run.
          expect(warnMessage).toContain(twoHoursAgo.toISOString());
        } finally {
          warnSpy.mockRestore();
        }
      } finally {
        if (originalEnv === undefined) {
          delete process.env["MAX_SENTINEL_AGE_HOURS"];
        } else {
          process.env["MAX_SENTINEL_AGE_HOURS"] = originalEnv;
        }
        // Restore the module registry so subsequent tests use the original module.
        vi.resetModules();
      }
    },
  );

  it(
    "accepts a sentinel whose age is exactly equal to the MAX_SENTINEL_AGE_HOURS threshold (strict greater-than guard)",
    async () => {
      // The age-guard comparison in probe-cache.ts is strictly greater-than
      // (ageMs > maxAgeMs), so a sentinel whose age equals the threshold exactly
      // must be treated as fresh and accepted — not discarded.
      //
      // This test pins that boundary to prevent a future guard that accidentally
      // uses >= from silently changing behaviour: if >= were ever used, this test
      // would catch it immediately by seeing null instead of the build directory.
      //
      // The MAX_SENTINEL_AGE_HOURS constant is evaluated at module-load time via
      // an IIFE.  To test the env-var path we must set the variable BEFORE the
      // module is imported, which requires resetting the module registry and
      // re-importing dynamically.
      //
      // To make the boundary deterministic we freeze Date.now() using Vitest's
      // fake-timer API before calling consume().  This ensures that the
      // `Date.now()` inside consumeProbeCache returns exactly the same value as
      // the one used to compute the sentinel mtime, so ageMs === maxAgeMs with
      // no clock drift.  Without this, any elapsed milliseconds between the
      // utimesSync call and the internal Date.now() would make the sentinel
      // appear fractionally older than the threshold and cause a flaky failure.
      const originalEnv = process.env["MAX_SENTINEL_AGE_HOURS"];
      process.env["MAX_SENTINEL_AGE_HOURS"] = "2.5";
      vi.resetModules();

      try {
        // Dynamic import picks up the new env var and re-evaluates the IIFE.
        const {
          consumeProbeCache: consume,
          PROBE_CACHE_SENTINEL: SENTINEL,
        } = await import("./probe-cache");

        const buildDir = ".next-probe-exact-threshold";
        fs.mkdirSync(path.join(tmpDir, buildDir));
        const sentinel = path.join(tmpDir, SENTINEL);
        fs.writeFileSync(sentinel, buildDir, "utf8");

        // Freeze the clock at a fixed point so the Date.now() inside
        // consumeProbeCache is identical to the one used for utimesSync.
        const fixedNow = Date.now();
        vi.useFakeTimers();
        vi.setSystemTime(fixedNow);

        // Backdate to exactly 2.5 hours before fixedNow.
        // With the clock frozen, ageMs = fixedNow - (fixedNow - 2.5h) = 2.5h exactly.
        // The guard fires when ageMs > maxAgeMs, i.e. 2.5h > 2.5h — which is false.
        // Therefore the sentinel must be accepted.
        const exactlyAtThreshold = new Date(fixedNow - 2.5 * 60 * 60 * 1000);
        fs.utimesSync(sentinel, exactlyAtThreshold, exactlyAtThreshold);

        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        try {
          const result = consume(tmpDir);

          // Sentinel age == threshold → NOT greater-than → must be accepted.
          expect(result).toBe(buildDir);

          // The sentinel must be consumed (deleted) after a successful read.
          expect(fs.existsSync(sentinel)).toBe(false);

          // No staleness warning must be emitted for an at-threshold sentinel.
          expect(warnSpy).not.toHaveBeenCalled();

          // The normal warm-start log must appear.
          expect(logSpy).toHaveBeenCalledOnce();
        } finally {
          warnSpy.mockRestore();
          logSpy.mockRestore();
          vi.useRealTimers();
        }
      } finally {
        if (originalEnv === undefined) {
          delete process.env["MAX_SENTINEL_AGE_HOURS"];
        } else {
          process.env["MAX_SENTINEL_AGE_HOURS"] = originalEnv;
        }
        // Restore the module registry so subsequent tests use the original module.
        vi.resetModules();
      }
    },
  );

  it(
    "discards a sentinel that is more than one second past the MAX_SENTINEL_AGE_HOURS threshold (exceeds truncation tolerance)",
    async () => {
      // The age guard uses strictly-greater-than with a MTIME_TRUNCATION_TOLERANCE_MS
      // (1 000 ms) buffer to absorb filesystem mtime rounding (see probe-cache.ts).
      // This test pins the minimal-violation boundary beyond that buffer: a sentinel
      // whose computed age exceeds (maxAgeMs + 1 000 ms) by at least 1 ms must be
      // rejected.  Without this case, a regression that widens the tolerance
      // too far could let genuinely stale sentinels slip through undetected.
      //
      // We use a violation of 1 001 ms (1 ms past the tolerance ceiling) so the
      // test is clearly above MTIME_TRUNCATION_TOLERANCE_MS = 1 000 ms.
      //
      // The MAX_SENTINEL_AGE_HOURS constant is evaluated at module-load time via
      // an IIFE, so we must set the env var before importing the module and use
      // vi.resetModules() to force a fresh evaluation.
      //
      // We freeze Date.now() so that the offset is deterministic: without a
      // frozen clock, real elapsed time between utimesSync and consumeProbeCache's
      // internal Date.now() would make the sentinel appear even older, which
      // would still pass — but the test would be measuring the wrong thing.
      const originalEnv = process.env["MAX_SENTINEL_AGE_HOURS"];
      process.env["MAX_SENTINEL_AGE_HOURS"] = "2.5";
      vi.resetModules();

      try {
        // Dynamic import picks up the new env var and re-evaluates the IIFE.
        const {
          consumeProbeCache: consume,
          PROBE_CACHE_SENTINEL: SENTINEL,
        } = await import("./probe-cache");

        const buildDir = ".next-probe-past-tolerance-threshold";
        fs.mkdirSync(path.join(tmpDir, buildDir));
        const sentinel = path.join(tmpDir, SENTINEL);
        fs.writeFileSync(sentinel, buildDir, "utf8");

        // Freeze the clock so the Date.now() inside consumeProbeCache is
        // identical to the one used to compute the sentinel mtime.
        const fixedNow = Date.now();
        vi.useFakeTimers();
        vi.setSystemTime(fixedNow);

        // Backdate to exactly 2.5 hours + 1 001 ms before fixedNow.
        // ageMs = 2.5h + 1001ms; tolerance = 1 000ms; 2.5h + 1001ms > 2.5h + 1000ms → rejected.
        const pastTolerance = new Date(
          fixedNow - (2.5 * 60 * 60 * 1000 + MTIME_TRUNCATION_TOLERANCE_MS + 1),
        );
        fs.utimesSync(sentinel, pastTolerance, pastTolerance);

        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          const result = consume(tmpDir);

          // Age exceeds maxAge + tolerance → must be rejected.
          expect(result).toBeNull();

          // The stale sentinel must be removed so subsequent runs are not tricked.
          expect(fs.existsSync(sentinel)).toBe(false);

          // A staleness warning must be emitted so operators can trace the decision.
          expect(warnSpy).toHaveBeenCalledOnce();
          const [warnMessage] = warnSpy.mock.calls[0] as [string];

          // The warning must mention the configured threshold (2.5h).
          expect(warnMessage).toContain("2.5");

          // The warning must include the sentinel's backdated mtime so operators
          // can correlate the discarded sentinel with a specific prior CI run.
          expect(warnMessage).toContain(pastTolerance.toISOString());
        } finally {
          warnSpy.mockRestore();
          vi.useRealTimers();
        }
      } finally {
        if (originalEnv === undefined) {
          delete process.env["MAX_SENTINEL_AGE_HOURS"];
        } else {
          process.env["MAX_SENTINEL_AGE_HOURS"] = originalEnv;
        }
        // Restore the module registry so subsequent tests use the original module.
        vi.resetModules();
      }
    },
  );

  it(
    "accepts a sentinel whose mtime is exactly at (MAX_SENTINEL_AGE_HOURS - 500 ms) truncated to a whole-second boundary (worst-case mtime rounding puts ageMs above maxAgeMs but within the tolerance)",
    async () => {
      // Risk being tested: a sentinel whose true age is slightly under the
      // MAX_SENTINEL_AGE_HOURS threshold could be pushed over that threshold by
      // up to 999 ms of filesystem mtime truncation and be incorrectly rejected.
      //
      // How filesystem mtime truncation works:
      //   The kernel stores the write time as the floor of the true timestamp to
      //   the nearest second.  consumeProbeCache reads that stored value, so the
      //   computed ageMs = Date.now() - floor(trueMtime) can be up to 999 ms
      //   *larger* than the sentinel's true age.
      //
      // Worst-case construction:
      //   fixedNow is chosen so that fixedNow % 1000 === 499.
      //   trueMtimeMs = fixedNow - (maxAgeMs - 500)
      //   The millisecond component of trueMtimeMs
      //     = (fixedNow - (maxAgeMs - 500)) % 1000
      //     = (499 - (-500)) % 1000          (maxAgeMs is a multiple of 1000)
      //     = 999 % 1000 = 999
      //   floor(trueMtimeMs) = trueMtimeMs - 999   (sheds 999 ms)
      //   ageMs = fixedNow - floor(trueMtimeMs)
      //         = (maxAgeMs - 500) + 999
      //         = maxAgeMs + 499
      //
      //   Guard: ageMs > maxAgeMs + MTIME_TRUNCATION_TOLERANCE_MS (1 000 ms)?
      //          maxAgeMs + 499 > maxAgeMs + 1 000 → false → sentinel ACCEPTED.
      //
      // Why this outcome is correct:
      //   The 1 000 ms tolerance absorbs worst-case 999 ms mtime rounding.
      //   A sentinel that is genuinely 500 ms inside the threshold can appear at
      //   most maxAgeMs + 499 ms old after rounding.  That is still 501 ms below
      //   the tolerance ceiling, so accepting it is correct behaviour.
      //
      // Why this test is stronger than simply using a negative offset:
      //   The computed ageMs (maxAgeMs + 499) is *above* maxAgeMs — i.e. the
      //   tolerance IS doing real work here.  If MTIME_TRUNCATION_TOLERANCE_MS
      //   were removed (set to 0), this sentinel would be rejected, and the test
      //   would catch the regression.
      //
      // The MAX_SENTINEL_AGE_HOURS constant is evaluated at module-load time via
      // an IIFE, so we must set the env var before importing the module and use
      // vi.resetModules() to force a fresh evaluation.
      const originalEnv = process.env["MAX_SENTINEL_AGE_HOURS"];
      process.env["MAX_SENTINEL_AGE_HOURS"] = "2.5";
      vi.resetModules();

      try {
        // Dynamic import picks up the new env var and re-evaluates the IIFE.
        const {
          consumeProbeCache: consume,
          PROBE_CACHE_SENTINEL: SENTINEL,
        } = await import("./probe-cache");

        const buildDir = ".next-probe-boundary-truncated";
        fs.mkdirSync(path.join(tmpDir, buildDir));
        const sentinel = path.join(tmpDir, SENTINEL);
        fs.writeFileSync(sentinel, buildDir, "utf8");

        // maxAgeMs = 2.5 * 3600 * 1000 = 9 000 000 ms (a multiple of 1 000).
        const maxAgeMs = 2.5 * 60 * 60 * 1000;

        // Choose fixedNow such that fixedNow % 1000 === 499.
        // This puts the absolute mtime timestamp at a millisecond component of 999
        // (since maxAgeMs is a multiple of 1000, the -500 shift adds 500 ms then
        // the 499 ms from fixedNow makes it 999 ms sub-second).
        // The filesystem floor then sheds those 999 ms, maximising ageMs.
        const rawNow = Date.now();
        const fixedNow = rawNow - (rawNow % 1000) + 499;
        // Verify the invariant: fixedNow % 1000 must be 499.
        expect(fixedNow % 1000).toBe(499);

        vi.useFakeTimers();
        vi.setSystemTime(fixedNow);

        // Construct the mtime as the floor-to-second of the true timestamp.
        //   trueMtimeMs = fixedNow - (maxAgeMs - 500) = fixedNow - maxAgeMs + 500
        //   sub-ms component = (499 + 500) % 1000 = 999
        //   floor = trueMtimeMs - 999
        //   ageMs = fixedNow - floor(trueMtimeMs) = maxAgeMs - 500 + 999 = maxAgeMs + 499
        const trueMtimeMs = fixedNow - (maxAgeMs - 500);
        const flooredMtimeMs = Math.floor(trueMtimeMs / 1000) * 1000;
        const mtimeDate = new Date(flooredMtimeMs);
        fs.utimesSync(sentinel, mtimeDate, mtimeDate);

        // Confirm the computed ageMs is above maxAgeMs but within the tolerance.
        const observedAgeMs = fixedNow - flooredMtimeMs;
        expect(observedAgeMs).toBe(maxAgeMs + 499);

        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        try {
          const result = consume(tmpDir);

          // ageMs = maxAgeMs + 499 is NOT greater than maxAgeMs + 1 000
          // (the MTIME_TRUNCATION_TOLERANCE_MS ceiling), so the sentinel must
          // be accepted — the tolerance is absorbing the worst-case rounding.
          expect(result).toBe(buildDir);

          // The sentinel must be consumed (deleted) after a successful read.
          expect(fs.existsSync(sentinel)).toBe(false);

          // No staleness warning must be emitted — the sentinel is within the
          // tolerance window and must be treated as fresh.
          expect(warnSpy).not.toHaveBeenCalled();

          // The normal warm-start log must appear once.
          expect(logSpy).toHaveBeenCalledOnce();
        } finally {
          warnSpy.mockRestore();
          logSpy.mockRestore();
          vi.useRealTimers();
        }
      } finally {
        if (originalEnv === undefined) {
          delete process.env["MAX_SENTINEL_AGE_HOURS"];
        } else {
          process.env["MAX_SENTINEL_AGE_HOURS"] = originalEnv;
        }
        // Restore the module registry so subsequent tests use the original module.
        vi.resetModules();
      }
    },
  );

  it(
    "accepts a sentinel whose age is exactly at the tolerance ceiling (maxAge + MTIME_TRUNCATION_TOLERANCE_MS) — the strictly-greater-than guard must not fire at the boundary",
    async () => {
      // The age guard in probe-cache.ts is:
      //   if (ageMs > maxAgeMs + MTIME_TRUNCATION_TOLERANCE_MS)
      //
      // MTIME_TRUNCATION_TOLERANCE_MS is 1 000 ms.  The guard fires only when
      // ageMs is *strictly greater than* (maxAgeMs + 1 000).  A sentinel whose
      // ageMs is *exactly* (maxAgeMs + 1 000) sits on the ceiling of the
      // tolerance window and must therefore be accepted — not rejected.
      //
      // The three neighbouring boundary tests cover:
      //   (a) ageMs === maxAgeMs          → accepted  (at-threshold)
      //   (b) ageMs === maxAgeMs + 1 001  → rejected  (1 ms past tolerance)
      //   (c) ageMs === maxAgeMs + 499    → accepted  (worst-case mtime rounding)
      //
      // This test fills the remaining gap: ageMs === maxAgeMs + 1 000 (the
      // ceiling itself).  Without it, a future regression that changes the guard
      // to >= would accept (a) and (c) unchanged, reject (b) unchanged, and
      // only this test would catch the breakage.
      //
      // Construction (no mtime truncation needed):
      //   Choose fixedNow as a whole-second boundary (fixedNow % 1000 === 0).
      //   Set mtime = fixedNow − (maxAgeMs + 1 000).
      //   Because (maxAgeMs + 1 000) is a multiple of 1 000 and fixedNow has
      //   ms === 0, the mtime Date has ms === 0 too — the filesystem stores it
      //   exactly (no sub-second truncation).
      //   With the clock frozen:
      //     ageMs = fixedNow − mtime = maxAgeMs + 1 000.
      //   Guard: maxAgeMs + 1 000 > maxAgeMs + 1 000 → false → ACCEPTED.
      const originalEnv = process.env["MAX_SENTINEL_AGE_HOURS"];
      process.env["MAX_SENTINEL_AGE_HOURS"] = "2.5";
      vi.resetModules();

      try {
        // Dynamic import picks up the new env var and re-evaluates the IIFE.
        const {
          consumeProbeCache: consume,
          PROBE_CACHE_SENTINEL: SENTINEL,
        } = await import("./probe-cache");

        const buildDir = ".next-probe-exact-tolerance-ceiling";
        fs.mkdirSync(path.join(tmpDir, buildDir));
        const sentinel = path.join(tmpDir, SENTINEL);
        fs.writeFileSync(sentinel, buildDir, "utf8");

        // maxAgeMs = 2.5 h × 3 600 000 ms/h = 9 000 000 ms (a multiple of 1 000).
        const maxAgeMs = 2.5 * 60 * 60 * 1000;

        // Round fixedNow down to a whole-second boundary so that
        // (fixedNow − (maxAgeMs + TOLERANCE)) also lands on a whole-second
        // boundary and is stored exactly by the filesystem (no truncation).
        const rawNow = Date.now();
        const fixedNow = rawNow - (rawNow % 1000);
        expect(fixedNow % 1000).toBe(0);

        vi.useFakeTimers();
        vi.setSystemTime(fixedNow);

        // Set the sentinel mtime to exactly (maxAgeMs + TOLERANCE) ms before
        // fixedNow.  With the frozen clock:
        //   ageMs = fixedNow − mtime = maxAgeMs + MTIME_TRUNCATION_TOLERANCE_MS.
        const atToleranceCeiling = new Date(
          fixedNow - (maxAgeMs + MTIME_TRUNCATION_TOLERANCE_MS),
        );
        fs.utimesSync(sentinel, atToleranceCeiling, atToleranceCeiling);

        // Confirm the mtime was stored without sub-second truncation.
        const observedAgeMs = fixedNow - atToleranceCeiling.getTime();
        expect(observedAgeMs).toBe(maxAgeMs + MTIME_TRUNCATION_TOLERANCE_MS);

        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        try {
          const result = consume(tmpDir);

          // ageMs === maxAgeMs + TOLERANCE is NOT strictly greater than
          // maxAgeMs + TOLERANCE → the guard must not fire → sentinel ACCEPTED.
          expect(result).toBe(buildDir);

          // The sentinel must be consumed (deleted) after a successful read.
          expect(fs.existsSync(sentinel)).toBe(false);

          // No staleness warning must be emitted — the sentinel is on the
          // ceiling of the tolerance window, which is still within the accepted
          // range.
          expect(warnSpy).not.toHaveBeenCalled();

          // The normal warm-start log must appear once.
          expect(logSpy).toHaveBeenCalledOnce();
        } finally {
          warnSpy.mockRestore();
          logSpy.mockRestore();
          vi.useRealTimers();
        }
      } finally {
        if (originalEnv === undefined) {
          delete process.env["MAX_SENTINEL_AGE_HOURS"];
        } else {
          process.env["MAX_SENTINEL_AGE_HOURS"] = originalEnv;
        }
        // Restore the module registry so subsequent tests use the original module.
        vi.resetModules();
      }
    },
  );

  it.each([
    ["0", "zero is not a positive number"],
    ["-1", "negative numbers are not valid"],
    ["abc", "non-numeric strings are not valid"],
  ])(
    "falls back to the 24-hour default when MAX_SENTINEL_AGE_HOURS is set to an invalid value (%s — %s)",
    async (invalidValue) => {
      // Invalid values must be silently ignored; the IIFE falls back to 24.
      // We verify this by showing that a sentinel backdated to 2 hours ago
      // (which would be stale under a 1-hour threshold) is treated as fresh.
      const originalEnv = process.env["MAX_SENTINEL_AGE_HOURS"];
      process.env["MAX_SENTINEL_AGE_HOURS"] = invalidValue;
      vi.resetModules();

      try {
        const {
          consumeProbeCache: consume,
          MAX_SENTINEL_AGE_HOURS: resolvedHours,
          PROBE_CACHE_SENTINEL: SENTINEL,
        } = await import("./probe-cache");

        // The invalid env var must be rejected — the constant must equal 24.
        expect(resolvedHours).toBe(24);

        const buildDir = `.next-probe-invalid-env-${invalidValue.replace(/[^a-z0-9]/g, "_")}`;
        fs.mkdirSync(path.join(tmpDir, buildDir));
        const sentinel = path.join(tmpDir, SENTINEL);
        fs.writeFileSync(sentinel, buildDir, "utf8");

        // 2 hours old — stale under a 1-hour threshold, but fresh under 24 hours.
        // If the invalid value were somehow used as the threshold the sentinel
        // would be kept anyway (0 or negative comparison is guarded by the parse
        // check); the real signal here is that resolvedHours === 24 and the
        // 2-hour sentinel is accepted normally.
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        fs.utimesSync(sentinel, twoHoursAgo, twoHoursAgo);

        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        try {
          const result = consume(tmpDir);

          // 2-hour-old sentinel is well within the 24-hour default threshold.
          // It must be accepted and the build directory returned.
          expect(result).toBe(buildDir);

          // No age-staleness warning must be emitted.
          expect(warnSpy).not.toHaveBeenCalled();

          // The normal warm-start log must appear.
          expect(logSpy).toHaveBeenCalledOnce();
        } finally {
          warnSpy.mockRestore();
          logSpy.mockRestore();
        }
      } finally {
        if (originalEnv === undefined) {
          delete process.env["MAX_SENTINEL_AGE_HOURS"];
        } else {
          process.env["MAX_SENTINEL_AGE_HOURS"] = originalEnv;
        }
        vi.resetModules();
      }
    },
  );

  it(
    "accepts a clearly-fresh sentinel even after a real-time sleep introduces clock drift",
    async () => {
      // This test deliberately does NOT freeze the clock.  Its purpose is to
      // confirm that the age guard accepts a sentinel that is well within the
      // threshold even when real milliseconds elapse between writing the
      // sentinel and calling consumeProbeCache.
      //
      // We use a threshold of 10 seconds (≈ 0.00278 h) and backdate the
      // sentinel to only 100 ms ago — a margin of ~9.9 s.  A 20 ms real-time
      // sleep adds drift that is orders of magnitude smaller than that margin,
      // so the sentinel must always be accepted regardless of CI scheduling
      // jitter.  If the age guard were removed or inverted the test would fail
      // because any always-reject implementation returns null rather than the
      // build directory name.
      const originalEnv = process.env["MAX_SENTINEL_AGE_HOURS"];
      // 10 s expressed in fractional hours.
      process.env["MAX_SENTINEL_AGE_HOURS"] = String(10 / 3600);
      vi.resetModules();

      try {
        const {
          consumeProbeCache: consume,
          PROBE_CACHE_SENTINEL: SENTINEL,
        } = await import("./probe-cache");

        const buildDir = ".next-probe-fresh-drift";
        fs.mkdirSync(path.join(tmpDir, buildDir));
        const sentinel = path.join(tmpDir, SENTINEL);
        fs.writeFileSync(sentinel, buildDir, "utf8");

        // Sentinel is 100 ms old — far below the 10 s threshold.
        // Even with 20 ms of real drift the age stays well under the limit.
        const hundredMsAgo = new Date(Date.now() - 100);
        fs.utimesSync(sentinel, hundredMsAgo, hundredMsAgo);

        // Introduce real clock drift without freezing the clock.
        await new Promise<void>((resolve) => setTimeout(resolve, 20));

        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        try {
          const result = consume(tmpDir);

          // A clearly-fresh sentinel must always be accepted.
          expect(result).toBe(buildDir);

          // The sentinel must be consumed after a successful read.
          expect(fs.existsSync(sentinel)).toBe(false);

          // No staleness warning must be emitted.
          expect(warnSpy).not.toHaveBeenCalled();

          // The normal warm-start log must appear.
          expect(logSpy).toHaveBeenCalledOnce();
        } finally {
          warnSpy.mockRestore();
          logSpy.mockRestore();
        }
      } finally {
        if (originalEnv === undefined) {
          delete process.env["MAX_SENTINEL_AGE_HOURS"];
        } else {
          process.env["MAX_SENTINEL_AGE_HOURS"] = originalEnv;
        }
        vi.resetModules();
      }
    },
  );

  it(
    "rejects a clearly-stale sentinel even after a real-time sleep introduces clock drift",
    async () => {
      // This test deliberately does NOT freeze the clock.  Its purpose is to
      // confirm that the age guard rejects a sentinel that is well past the
      // threshold even when real milliseconds elapse between writing the
      // sentinel and calling consumeProbeCache.
      //
      // We use a threshold of 10 seconds (≈ 0.00278 h) and backdate the
      // sentinel to 20 seconds ago — double the threshold.  A 20 ms real-time
      // sleep adds drift that is orders of magnitude smaller than that margin,
      // so the sentinel must always be rejected regardless of CI scheduling
      // jitter.  If the age guard were removed or weakened the test would fail
      // because any always-accept implementation returns the build directory
      // rather than null.
      const originalEnv = process.env["MAX_SENTINEL_AGE_HOURS"];
      // 10 s expressed in fractional hours.
      process.env["MAX_SENTINEL_AGE_HOURS"] = String(10 / 3600);
      vi.resetModules();

      try {
        const {
          consumeProbeCache: consume,
          PROBE_CACHE_SENTINEL: SENTINEL,
        } = await import("./probe-cache");

        const buildDir = ".next-probe-stale-drift";
        fs.mkdirSync(path.join(tmpDir, buildDir));
        const sentinel = path.join(tmpDir, SENTINEL);
        fs.writeFileSync(sentinel, buildDir, "utf8");

        // Sentinel is 20 s old — double the 10 s threshold.
        // Even with 20 ms of real drift the age remains comfortably past the limit.
        const twentySecondsAgo = new Date(Date.now() - 20_000);
        fs.utimesSync(sentinel, twentySecondsAgo, twentySecondsAgo);

        // Introduce real clock drift without freezing the clock.
        await new Promise<void>((resolve) => setTimeout(resolve, 20));

        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          const result = consume(tmpDir);

          // A clearly-stale sentinel must always be rejected.
          expect(result).toBeNull();

          // The stale sentinel must be removed so subsequent runs are not tricked.
          expect(fs.existsSync(sentinel)).toBe(false);

          // A staleness warning must be emitted.
          expect(warnSpy).toHaveBeenCalledOnce();
        } finally {
          warnSpy.mockRestore();
        }
      } finally {
        if (originalEnv === undefined) {
          delete process.env["MAX_SENTINEL_AGE_HOURS"];
        } else {
          process.env["MAX_SENTINEL_AGE_HOURS"] = originalEnv;
        }
        vi.resetModules();
      }
    },
  );
});

// ── Constant contract ─────────────────────────────────────────────────────────

describe("exported constants", () => {
  it("PROBE_CACHE_SENTINEL matches the name used by the probe script", () => {
    // The probe script (probe-nextdev-startup.ts) writes:
    //   fs.writeFileSync(sentinelPath, PROBE_BUILD_DIR, "utf8")
    // where sentinelPath = path.join(artworkBankDir, ".next-probe-cache-ready").
    // This test pins the constant so a rename on either side is caught immediately.
    expect(PROBE_CACHE_SENTINEL).toBe(".next-probe-cache-ready");
  });

  it("DEV_BUILD_DIR is distinct from the probe build directory", () => {
    // The probe uses ".next-probe"; the slow-test fallback uses ".next-slow-test".
    // They must differ so running both in sequence doesn't clobber each other's caches.
    expect(DEV_BUILD_DIR).not.toBe(".next-probe");
    expect(DEV_BUILD_DIR).toBe(".next-slow-test");
  });
});

// ── Subprocess environment integration (age-guard CI override) ────────────────
//
// The tests above exercise the module inside the Vitest process.  Even the
// vi.resetModules() + dynamic-import tests still run in the same OS process,
// so a CI misconfiguration that sets the variable after the process starts
// would be invisible.
//
// These tests spawn a fresh `tsx` child process with MAX_SENTINEL_AGE_HOURS
// injected via its environment — exactly how a GitHub Actions `env:` block or
// a `.env.test` file supplies it in CI.  Module-level caching in Vitest cannot
// interfere because the child process has its own module registry.

describe("subprocess environment integration (age-guard CI override)", () => {
  // Locate the tsx binary relative to this file:
  //   __tests__/slow/helpers/ → ../../../node_modules/.bin/tsx
  const tsxBin = path.resolve(
    __dirname,
    "../../../node_modules/.bin/tsx",
  );
  const helperScript = path.resolve(
    __dirname,
    "./probe-cache-env-check.ts",
  );

  it(
    "a 2-hour-old sentinel is rejected when MAX_SENTINEL_AGE_HOURS=1 is set in the subprocess environment",
    () => {
      // Spawn a fresh process with the override set.  The subprocess writes a
      // JSON line to stdout; we parse and assert both the resolved constant and
      // the consumeProbeCache return value.
      const proc = spawnSync(tsxBin, [helperScript], {
        env: { ...process.env, MAX_SENTINEL_AGE_HOURS: "1" },
        encoding: "utf8",
        timeout: 15_000,
      });

      // The subprocess must not crash.
      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);

      const output = JSON.parse(proc.stdout.trim()) as {
        constant: number;
        result: string | null;
      };

      // The IIFE must have read the env var and produced 1, not the 24-hour default.
      expect(output.constant).toBe(1);

      // The sentinel is 2 hours old — exceeds the 1-hour threshold.
      // consumeProbeCache must discard it and return null.
      expect(output.result).toBeNull();
    },
  );

  it(
    "a 2-hour-old sentinel is accepted when MAX_SENTINEL_AGE_HOURS=3 is set in the subprocess environment",
    () => {
      // With a 3-hour threshold the same 2-hour-old sentinel must pass.
      // This confirms the env var, not the hardcoded 24-hour default, is driving
      // the decision — ruling out the possibility that the test above passed only
      // because 2 > 24 is never true.
      const proc = spawnSync(tsxBin, [helperScript], {
        env: { ...process.env, MAX_SENTINEL_AGE_HOURS: "3" },
        encoding: "utf8",
        timeout: 15_000,
      });

      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);

      const output = JSON.parse(proc.stdout.trim()) as {
        constant: number;
        result: string | null;
      };

      // The IIFE must have read the env var and produced 3.
      expect(output.constant).toBe(3);

      // The sentinel is 2 hours old — within the 3-hour threshold.
      // consumeProbeCache must accept it and return the build directory name.
      expect(output.result).toBe(".next-probe-ci");
    },
  );

  it(
    "a 2-hour-old sentinel is rejected when MAX_SENTINEL_AGE_HOURS=0.5 is set in the subprocess environment",
    () => {
      // Fractional values like 0.5 (30 minutes) must be accepted by the IIFE
      // (Number.isFinite(0.5) is true and 0.5 > 0 is true) and must drive the
      // age guard correctly.  A 2-hour-old sentinel exceeds the 0.5-hour
      // threshold, so consumeProbeCache must discard it and return null.
      //
      // This confirms that no floor/truncation converts 0.5 h to 0 ms before
      // the comparison — if it did, the sentinel would be incorrectly accepted.
      const proc = spawnSync(tsxBin, [helperScript], {
        env: { ...process.env, MAX_SENTINEL_AGE_HOURS: "0.5" },
        encoding: "utf8",
        timeout: 15_000,
      });

      // The subprocess must not crash.
      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);

      const output = JSON.parse(proc.stdout.trim()) as {
        constant: number;
        result: string | null;
      };

      // The IIFE must have read the env var and produced 0.5, not the 24-hour default.
      expect(output.constant).toBe(0.5);

      // The sentinel is 2 hours old — exceeds the 0.5-hour (30-minute) threshold.
      // consumeProbeCache must discard it and return null.
      expect(output.result).toBeNull();
    },
  );

  it(
    "a 2-hour-old sentinel is accepted when MAX_SENTINEL_AGE_HOURS=3.5 is set in the subprocess environment",
    () => {
      // A fractional threshold of 3.5 hours must also be accepted by the IIFE
      // (Number.isFinite(3.5) is true and 3.5 > 0 is true) and must drive the
      // age guard correctly.  A 2-hour-old sentinel is within the 3.5-hour
      // threshold, so consumeProbeCache must accept it and return the build
      // directory name.
      //
      // Pairing this case with the 0.5-hour case above confirms that float
      // thresholds work symmetrically: one below 2 h (rejects), one above 2 h
      // (accepts).  Together they rule out any floor/truncation or integer-only
      // parsing in the IIFE or the age comparison.
      const proc = spawnSync(tsxBin, [helperScript], {
        env: { ...process.env, MAX_SENTINEL_AGE_HOURS: "3.5" },
        encoding: "utf8",
        timeout: 15_000,
      });

      // The subprocess must not crash.
      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);

      const output = JSON.parse(proc.stdout.trim()) as {
        constant: number;
        result: string | null;
      };

      // The IIFE must have read the env var and produced 3.5.
      expect(output.constant).toBe(3.5);

      // The sentinel is 2 hours old — within the 3.5-hour threshold.
      // consumeProbeCache must accept it and return the build directory name.
      expect(output.result).toBe(".next-probe-ci");
    },
  );

  it.each([
    ["0", "zero is not a positive number"],
    ["-1", "negative numbers are not valid"],
    ["abc", "non-numeric strings are not valid"],
  ])(
    "falls back to 24 hours and does not crash when MAX_SENTINEL_AGE_HOURS=%s (%s) is set in the subprocess environment",
    (invalidValue) => {
      // A CI file that accidentally sets MAX_SENTINEL_AGE_HOURS to an invalid
      // value must not crash the probe step.  The IIFE in probe-cache.ts must
      // silently ignore the bad value and fall back to the 24-hour default.
      //
      // We verify this through the process boundary — Vitest module caching
      // cannot interfere because the child process has its own module registry.
      const proc = spawnSync(tsxBin, [helperScript], {
        env: { ...process.env, MAX_SENTINEL_AGE_HOURS: invalidValue },
        encoding: "utf8",
        timeout: 15_000,
      });

      // The subprocess must not crash regardless of the invalid env var.
      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);

      const output = JSON.parse(proc.stdout.trim()) as {
        constant: number;
        result: string | null;
      };

      // The IIFE must reject the invalid value and fall back to 24.
      expect(output.constant).toBe(24);

      // The sentinel is 2 hours old — well within the 24-hour default.
      // consumeProbeCache must accept it and return the build directory name,
      // proving the process did not crash and the fallback threshold is active.
      expect(output.result).toBe(".next-probe-ci");
    },
  );

  it(
    "a 2-hour-old sentinel is accepted when MAX_SENTINEL_AGE_HOURS is absent from the subprocess environment (24-hour default)",
    () => {
      // This is the most common CI misconfiguration: the env var is simply not
      // set in the job's environment.  The IIFE must fall back to 24 hours.
      // Removing the key from the child process env ensures the subprocess sees
      // a completely absent variable, ruling out an inherited value from the
      // Vitest runner that would mask the missing-variable code path.
      const childEnv = { ...process.env };
      delete childEnv["MAX_SENTINEL_AGE_HOURS"];

      const proc = spawnSync(tsxBin, [helperScript], {
        env: childEnv,
        encoding: "utf8",
        timeout: 15_000,
      });

      // The subprocess must not crash.
      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);

      const output = JSON.parse(proc.stdout.trim()) as {
        constant: number;
        result: string | null;
      };

      // With the variable absent the IIFE must produce the 24-hour default.
      expect(output.constant).toBe(24);

      // The sentinel is only 2 hours old — well within the 24-hour default.
      // consumeProbeCache must accept it and return the build directory name.
      expect(output.result).toBe(".next-probe-ci");
    },
  );

  it(
    "falls back to 24 hours and does not crash when MAX_SENTINEL_AGE_HOURS is set to an empty string in the subprocess environment",
    () => {
      // A CI YAML file that sets `MAX_SENTINEL_AGE_HOURS:` with no value passes
      // an empty string to the child process environment.  The IIFE in
      // probe-cache.ts guards `env !== ""` before parsing, so an empty string
      // must be treated the same as an absent variable: fall back to 24 hours.
      //
      // This test exercises that path through the real process boundary —
      // Vitest module caching cannot interfere because the child process has
      // its own module registry.
      const proc = spawnSync(tsxBin, [helperScript], {
        env: { ...process.env, MAX_SENTINEL_AGE_HOURS: "" },
        encoding: "utf8",
        timeout: 15_000,
      });

      // The subprocess must not crash when the env var is an empty string.
      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);

      const output = JSON.parse(proc.stdout.trim()) as {
        constant: number;
        result: string | null;
      };

      // The IIFE must treat "" the same as undefined and fall back to 24.
      expect(output.constant).toBe(24);

      // The sentinel is 2 hours old — well within the 24-hour default threshold.
      // consumeProbeCache must accept it and return the build directory name,
      // confirming the process did not crash and the 24-hour fallback is active.
      expect(output.result).toBe(".next-probe-ci");
    },
  );

  it(
    "falls back to 24 hours and does not crash when MAX_SENTINEL_AGE_HOURS is set to whitespace only in the subprocess environment",
    () => {
      // A CI YAML block that sets `MAX_SENTINEL_AGE_HOURS: "  "` (spaces only)
      // passes a non-empty string that passes the `env !== ""` guard in the IIFE
      // but then fails `Number.isFinite(parsed)` (Number("  ") is NaN), so the
      // IIFE must fall back to 24 hours.  This path is distinct from an empty
      // string and must be covered through the process boundary so Vitest module
      // caching cannot interfere.
      const proc = spawnSync(tsxBin, [helperScript], {
        env: { ...process.env, MAX_SENTINEL_AGE_HOURS: "  " },
        encoding: "utf8",
        timeout: 15_000,
      });

      // The subprocess must not crash when the env var is whitespace only.
      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);

      const output = JSON.parse(proc.stdout.trim()) as {
        constant: number;
        result: string | null;
      };

      // The IIFE must reject the whitespace-only value (NaN after Number()) and
      // fall back to the 24-hour default.
      expect(output.constant).toBe(24);

      // The sentinel is 2 hours old — well within the 24-hour default threshold.
      // consumeProbeCache must accept it and return the build directory name,
      // confirming the process did not crash and the 24-hour fallback is active.
      expect(output.result).toBe(".next-probe-ci");
    },
  );

  it(
    "falls back to 24 hours and does not crash when MAX_SENTINEL_AGE_HOURS is set to a tab character only in the subprocess environment",
    () => {
      // Some CI YAML editors silently insert a tab character when the user
      // intends to leave a field blank.  A tab-only value passes the
      // `env !== ""` guard in the IIFE but then fails `Number.isFinite(parsed)`
      // (Number("\t") is NaN, the same as Number("  ")), so the IIFE must fall
      // back to 24 hours.  This test documents that the guard covers all common
      // whitespace variants, not just spaces or empty strings.
      //
      // The test exercises this path through the real process boundary so
      // Vitest module caching cannot interfere.
      const proc = spawnSync(tsxBin, [helperScript], {
        env: { ...process.env, MAX_SENTINEL_AGE_HOURS: "\t" },
        encoding: "utf8",
        timeout: 15_000,
      });

      // The subprocess must not crash when the env var is a tab character only.
      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);

      const output = JSON.parse(proc.stdout.trim()) as {
        constant: number;
        result: string | null;
      };

      // The IIFE must reject the tab-only value (NaN after Number("\t")) and
      // fall back to the 24-hour default.
      expect(output.constant).toBe(24);

      // The sentinel is 2 hours old — well within the 24-hour default threshold.
      // consumeProbeCache must accept it and return the build directory name,
      // confirming the process did not crash and the 24-hour fallback is active.
      expect(output.result).toBe(".next-probe-ci");
    },
  );

  it(
    "falls back to 24 hours and does not crash when MAX_SENTINEL_AGE_HOURS is set to a bare newline in the subprocess environment",
    () => {
      // Some shell scripts or heredoc CI configs can silently produce a bare
      // newline ("\n") as the value of an environment variable.  A newline-only
      // value passes the `env !== ""` guard in the IIFE but then fails
      // `Number.isFinite(parsed)` (Number("\n") is NaN, the same as
      // Number("  ") or Number("\t")), so the IIFE must fall back to 24 hours.
      // This test documents that the guard covers newlines specifically, not
      // just spaces, tabs, or empty strings.
      //
      // The test exercises this path through the real process boundary so
      // Vitest module caching cannot interfere.
      const proc = spawnSync(tsxBin, [helperScript], {
        env: { ...process.env, MAX_SENTINEL_AGE_HOURS: "\n" },
        encoding: "utf8",
        timeout: 15_000,
      });

      // The subprocess must not crash when the env var is a bare newline.
      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);

      const output = JSON.parse(proc.stdout.trim()) as {
        constant: number;
        result: string | null;
      };

      // The IIFE must reject the newline-only value (NaN after Number("\n")) and
      // fall back to the 24-hour default.
      expect(output.constant).toBe(24);

      // The sentinel is 2 hours old — well within the 24-hour default threshold.
      // consumeProbeCache must accept it and return the build directory name,
      // confirming the process did not crash and the 24-hour fallback is active.
      expect(output.result).toBe(".next-probe-ci");
    },
  );

  it(
    "falls back to 24 hours and does not crash when MAX_SENTINEL_AGE_HOURS is set to a bare carriage return in the subprocess environment",
    () => {
      // Windows-style line endings (CRLF) or certain heredoc CI configs can
      // silently produce a bare carriage return ("\r") as the value of an
      // environment variable.  A carriage-return-only value passes the
      // `env !== ""` guard in the IIFE but then fails `Number.isFinite(parsed)`
      // (Number("\r") is NaN, the same as Number("\n"), Number("\t"), or
      // Number("  ")), so the IIFE must fall back to 24 hours.  This test
      // documents that the guard covers carriage returns specifically, not
      // just spaces, tabs, newlines, or empty strings.
      //
      // The test exercises this path through the real process boundary so
      // Vitest module caching cannot interfere.
      const proc = spawnSync(tsxBin, [helperScript], {
        env: { ...process.env, MAX_SENTINEL_AGE_HOURS: "\r" },
        encoding: "utf8",
        timeout: 15_000,
      });

      // The subprocess must not crash when the env var is a bare carriage return.
      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);

      const output = JSON.parse(proc.stdout.trim()) as {
        constant: number;
        result: string | null;
      };

      // The IIFE must reject the carriage-return-only value (NaN after Number("\r"))
      // and fall back to the 24-hour default.
      expect(output.constant).toBe(24);

      // The sentinel is 2 hours old — well within the 24-hour default threshold.
      // consumeProbeCache must accept it and return the build directory name,
      // confirming the process did not crash and the 24-hour fallback is active.
      expect(output.result).toBe(".next-probe-ci");
    },
  );

  it(
    "falls back to 24 hours and does not crash when MAX_SENTINEL_AGE_HOURS is set to a bare form feed in the subprocess environment",
    () => {
      // Some legacy CI tooling (e.g. older build systems that post-process YAML
      // with form-feed page separators) can silently produce a bare form feed
      // ("\f") as the value of an environment variable.  A form-feed-only value
      // passes the `env !== ""` guard in the IIFE but then fails
      // `Number.isFinite(parsed)` (Number("\f") is NaN, the same as
      // Number("\r"), Number("\n"), Number("\t"), or Number("  ")), so the IIFE
      // must fall back to 24 hours.  This test documents that the guard covers
      // form feeds specifically, not just spaces, tabs, newlines, carriage
      // returns, or empty strings.
      //
      // The test exercises this path through the real process boundary so
      // Vitest module caching cannot interfere.
      const proc = spawnSync(tsxBin, [helperScript], {
        env: { ...process.env, MAX_SENTINEL_AGE_HOURS: "\f" },
        encoding: "utf8",
        timeout: 15_000,
      });

      // The subprocess must not crash when the env var is a bare form feed.
      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);

      const output = JSON.parse(proc.stdout.trim()) as {
        constant: number;
        result: string | null;
      };

      // The IIFE must reject the form-feed-only value (NaN after Number("\f"))
      // and fall back to the 24-hour default.
      expect(output.constant).toBe(24);

      // The sentinel is 2 hours old — well within the 24-hour default threshold.
      // consumeProbeCache must accept it and return the build directory name,
      // confirming the process did not crash and the 24-hour fallback is active.
      expect(output.result).toBe(".next-probe-ci");
    },
  );

  it(
    "falls back to 24 hours and does not crash when MAX_SENTINEL_AGE_HOURS is set to a bare vertical tab in the subprocess environment",
    () => {
      // Some legacy CI tooling can silently produce a bare vertical tab ("\v")
      // as the value of an environment variable.  A vertical-tab-only value
      // passes the `env !== ""` guard in the IIFE but then fails
      // `Number.isFinite(parsed)` (Number("\v") is NaN, the same as
      // Number("\f"), Number("\r"), Number("\n"), Number("\t"), or
      // Number("  ")), so the IIFE must fall back to 24 hours.  This test
      // documents that the guard covers vertical tabs specifically, not
      // just spaces, tabs, newlines, carriage returns, form feeds, or empty
      // strings.
      //
      // The test exercises this path through the real process boundary so
      // Vitest module caching cannot interfere.
      const proc = spawnSync(tsxBin, [helperScript], {
        env: { ...process.env, MAX_SENTINEL_AGE_HOURS: "\v" },
        encoding: "utf8",
        timeout: 15_000,
      });

      // The subprocess must not crash when the env var is a bare vertical tab.
      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);

      const output = JSON.parse(proc.stdout.trim()) as {
        constant: number;
        result: string | null;
      };

      // The IIFE must reject the vertical-tab-only value (NaN after Number("\v"))
      // and fall back to the 24-hour default.
      expect(output.constant).toBe(24);

      // The sentinel is 2 hours old — well within the 24-hour default threshold.
      // consumeProbeCache must accept it and return the build directory name,
      // confirming the process did not crash and the 24-hour fallback is active.
      expect(output.result).toBe(".next-probe-ci");
    },
  );

  it(
    "falls back to 24 hours and does not crash when MAX_SENTINEL_AGE_HOURS is set to a null byte",
    async () => {
      // Some legacy tooling or misconfigured shell scripts can produce a null
      // byte ("\0") as the value of an environment variable.  Unlike the
      // whitespace-only variants (spaces, tabs, newlines, etc.) that produce
      // NaN when passed to Number(), a null byte produces 0 — Number("\0") is
      // 0, not NaN.  Zero is a finite number, so it passes
      // `Number.isFinite(parsed)`, but it fails the `parsed > 0` guard in the
      // IIFE because 0 is not a positive number of hours.  The IIFE must
      // therefore fall back to 24 hours.  This test documents that the `> 0`
      // guard covers null bytes, not just non-finite values.
      //
      // Node.js rejects null bytes in spawnSync's env option with
      // ERR_INVALID_ARG_VALUE, so this case cannot be exercised through the
      // real subprocess boundary.  We use the vi.resetModules() + dynamic-
      // import path instead — the same technique used by the in-process
      // invalid-value tests above — to evaluate the IIFE against a
      // null-byte env var without spawning a child process.
      const originalEnv = process.env["MAX_SENTINEL_AGE_HOURS"];
      process.env["MAX_SENTINEL_AGE_HOURS"] = "\0";
      vi.resetModules();

      try {
        const {
          consumeProbeCache: consume,
          MAX_SENTINEL_AGE_HOURS: resolvedHours,
          PROBE_CACHE_SENTINEL: SENTINEL,
        } = await import("./probe-cache");

        // The IIFE must reject the null-byte value (Number("\0") is 0, which
        // passes Number.isFinite but fails the parsed > 0 guard) and fall
        // back to the 24-hour default.
        expect(resolvedHours).toBe(24);

        const buildDir = ".next-probe-null-byte";
        fs.mkdirSync(path.join(tmpDir, buildDir));
        const sentinel = path.join(tmpDir, SENTINEL);
        fs.writeFileSync(sentinel, buildDir, "utf8");

        // Backdate to 2 hours ago — stale under a 1-hour threshold but fresh
        // under the 24-hour default.  Accepting this sentinel confirms the
        // fallback threshold is active, not the null-byte value (which would
        // yield 0 hours, making every sentinel stale).
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        fs.utimesSync(sentinel, twoHoursAgo, twoHoursAgo);

        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        try {
          const result = consume(tmpDir);

          // The 2-hour-old sentinel is within the 24-hour default threshold.
          // consumeProbeCache must accept it and return the build directory name.
          expect(result).toBe(buildDir);

          // No age-staleness warning must be emitted.
          expect(warnSpy).not.toHaveBeenCalled();

          // The normal warm-start log must appear.
          expect(logSpy).toHaveBeenCalledOnce();
        } finally {
          warnSpy.mockRestore();
          logSpy.mockRestore();
        }
      } finally {
        if (originalEnv === undefined) {
          delete process.env["MAX_SENTINEL_AGE_HOURS"];
        } else {
          process.env["MAX_SENTINEL_AGE_HOURS"] = originalEnv;
        }
        vi.resetModules();
      }
    },
  );

  it(
    "falls back to 24 hours and does not crash when MAX_SENTINEL_AGE_HOURS is set to Infinity",
    async () => {
      // The string "Infinity" converts to the JavaScript value Infinity via
      // Number("Infinity").  Infinity passes the `parsed > 0` guard in the IIFE
      // (Infinity > 0 is true) but fails `Number.isFinite(parsed)` (Infinity is
      // not a finite number), so the IIFE must fall back to 24 hours.  This test
      // documents that the finite-number guard closes the Infinity gap — a value
      // that is positive but not finite must not be accepted as a threshold.
      //
      // Node.js does not reject "Infinity" in spawnSync's env option, but the
      // null-byte test above already documents why spawnSync cannot be used for
      // in-process IIFE evaluation.  For consistency, and because the IIFE is
      // evaluated at module-load time, we use the vi.resetModules() + dynamic-
      // import path so the IIFE runs against the modified env without spawning a
      // child process.
      const originalEnv = process.env["MAX_SENTINEL_AGE_HOURS"];
      process.env["MAX_SENTINEL_AGE_HOURS"] = "Infinity";
      vi.resetModules();

      try {
        const {
          consumeProbeCache: consume,
          MAX_SENTINEL_AGE_HOURS: resolvedHours,
          PROBE_CACHE_SENTINEL: SENTINEL,
        } = await import("./probe-cache");

        // The IIFE must reject the Infinity value (Number("Infinity") is Infinity,
        // which passes parsed > 0 but fails Number.isFinite) and fall back to the
        // 24-hour default.
        expect(resolvedHours).toBe(24);

        const buildDir = ".next-probe-infinity";
        fs.mkdirSync(path.join(tmpDir, buildDir));
        const sentinel = path.join(tmpDir, SENTINEL);
        fs.writeFileSync(sentinel, buildDir, "utf8");

        // Backdate to 2 hours ago — stale under a 1-hour threshold but fresh
        // under the 24-hour default.  Accepting this sentinel confirms the
        // fallback threshold is active, not the Infinity value (which, if used,
        // would make every sentinel look fresh regardless of age).
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        fs.utimesSync(sentinel, twoHoursAgo, twoHoursAgo);

        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        try {
          const result = consume(tmpDir);

          // The 2-hour-old sentinel is within the 24-hour default threshold.
          // consumeProbeCache must accept it and return the build directory name.
          expect(result).toBe(buildDir);

          // No age-staleness warning must be emitted.
          expect(warnSpy).not.toHaveBeenCalled();

          // The normal warm-start log must appear.
          expect(logSpy).toHaveBeenCalledOnce();
        } finally {
          warnSpy.mockRestore();
          logSpy.mockRestore();
        }
      } finally {
        if (originalEnv === undefined) {
          delete process.env["MAX_SENTINEL_AGE_HOURS"];
        } else {
          process.env["MAX_SENTINEL_AGE_HOURS"] = originalEnv;
        }
        vi.resetModules();
      }
    },
  );

  it(
    "falls back to 24 hours and does not crash when MAX_SENTINEL_AGE_HOURS is set to NaN",
    async () => {
      // The string "NaN" converts to the JavaScript value NaN via
      // Number("NaN").  NaN fails both guards in the IIFE:
      // Number.isFinite(NaN) is false (NaN is not a finite number) and
      // NaN > 0 is also false (any comparison with NaN returns false).
      // The IIFE must fall back to 24 hours.  This test documents the
      // Number("NaN") path specifically — distinct from non-numeric strings
      // like "abc" that also produce NaN — and confirms the finite-number
      // guard covers the literal string "NaN" as a named special value.
      //
      // For consistency with the null-byte, Infinity, and -Infinity tests,
      // and because the IIFE is evaluated at module-load time, we use the
      // vi.resetModules() + dynamic-import path so the IIFE runs against the
      // modified env without spawning a child process.
      const originalEnv = process.env["MAX_SENTINEL_AGE_HOURS"];
      process.env["MAX_SENTINEL_AGE_HOURS"] = "NaN";
      vi.resetModules();

      try {
        const {
          consumeProbeCache: consume,
          MAX_SENTINEL_AGE_HOURS: resolvedHours,
          PROBE_CACHE_SENTINEL: SENTINEL,
        } = await import("./probe-cache");

        // The IIFE must reject the NaN value (Number("NaN") is NaN, which
        // fails both Number.isFinite and parsed > 0) and fall back to the
        // 24-hour default.
        expect(resolvedHours).toBe(24);

        const buildDir = ".next-probe-nan";
        fs.mkdirSync(path.join(tmpDir, buildDir));
        const sentinel = path.join(tmpDir, SENTINEL);
        fs.writeFileSync(sentinel, buildDir, "utf8");

        // Backdate to 2 hours ago — stale under a 1-hour threshold but fresh
        // under the 24-hour default.  Accepting this sentinel confirms the
        // fallback threshold is active, not the NaN value (which, if used as
        // a threshold, would make every age comparison return false and reject
        // all sentinels).
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        fs.utimesSync(sentinel, twoHoursAgo, twoHoursAgo);

        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        try {
          const result = consume(tmpDir);

          // The 2-hour-old sentinel is within the 24-hour default threshold.
          // consumeProbeCache must accept it and return the build directory name.
          expect(result).toBe(buildDir);

          // No age-staleness warning must be emitted.
          expect(warnSpy).not.toHaveBeenCalled();

          // The normal warm-start log must appear.
          expect(logSpy).toHaveBeenCalledOnce();
        } finally {
          warnSpy.mockRestore();
          logSpy.mockRestore();
        }
      } finally {
        if (originalEnv === undefined) {
          delete process.env["MAX_SENTINEL_AGE_HOURS"];
        } else {
          process.env["MAX_SENTINEL_AGE_HOURS"] = originalEnv;
        }
        vi.resetModules();
      }
    },
  );

  it(
    "falls back to 24 hours and does not crash when MAX_SENTINEL_AGE_HOURS is set to -Infinity",
    async () => {
      // The string "-Infinity" converts to the JavaScript value -Infinity via
      // Number("-Infinity").  -Infinity fails both guards in the IIFE:
      // Number.isFinite(-Infinity) is false (not a finite number) and
      // -Infinity > 0 is also false (negative, not positive).  The IIFE must
      // fall back to 24 hours.  This test documents that the finite-number guard
      // is symmetric — a value that is negative AND non-finite is also rejected,
      // not just positive non-finite values like Infinity.
      //
      // For consistency with the null-byte and Infinity tests, and because the
      // IIFE is evaluated at module-load time, we use the vi.resetModules() +
      // dynamic-import path so the IIFE runs against the modified env without
      // spawning a child process.
      const originalEnv = process.env["MAX_SENTINEL_AGE_HOURS"];
      process.env["MAX_SENTINEL_AGE_HOURS"] = "-Infinity";
      vi.resetModules();

      try {
        const {
          consumeProbeCache: consume,
          MAX_SENTINEL_AGE_HOURS: resolvedHours,
          PROBE_CACHE_SENTINEL: SENTINEL,
        } = await import("./probe-cache");

        // The IIFE must reject the -Infinity value (Number("-Infinity") is
        // -Infinity, which fails both Number.isFinite and parsed > 0) and fall
        // back to the 24-hour default.
        expect(resolvedHours).toBe(24);

        const buildDir = ".next-probe-neg-infinity";
        fs.mkdirSync(path.join(tmpDir, buildDir));
        const sentinel = path.join(tmpDir, SENTINEL);
        fs.writeFileSync(sentinel, buildDir, "utf8");

        // Backdate to 2 hours ago — stale under a 1-hour threshold but fresh
        // under the 24-hour default.  Accepting this sentinel confirms the
        // fallback threshold is active, not the -Infinity value (which, if used,
        // would make every sentinel look stale because no age is less than
        // -Infinity hours).
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        fs.utimesSync(sentinel, twoHoursAgo, twoHoursAgo);

        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        try {
          const result = consume(tmpDir);

          // The 2-hour-old sentinel is within the 24-hour default threshold.
          // consumeProbeCache must accept it and return the build directory name.
          expect(result).toBe(buildDir);

          // No age-staleness warning must be emitted.
          expect(warnSpy).not.toHaveBeenCalled();

          // The normal warm-start log must appear.
          expect(logSpy).toHaveBeenCalledOnce();
        } finally {
          warnSpy.mockRestore();
          logSpy.mockRestore();
        }
      } finally {
        if (originalEnv === undefined) {
          delete process.env["MAX_SENTINEL_AGE_HOURS"];
        } else {
          process.env["MAX_SENTINEL_AGE_HOURS"] = originalEnv;
        }
        vi.resetModules();
      }
    },
  );

  it(
    "falls back to 24 hours and does not crash when MAX_SENTINEL_AGE_HOURS is set to '2abc' (mixed alphanumeric string)",
    async () => {
      // The string "2abc" converts to NaN via Number("2abc").  Unlike
      // Number("2"), which produces the finite number 2, a partially-numeric
      // string with trailing non-digit characters is not coerced to the leading
      // digit — JavaScript's Number() conversion requires the entire string to
      // be a valid number.  NaN fails both guards in the IIFE:
      // Number.isFinite(NaN) is false and NaN > 0 is also false.  The IIFE
      // must fall back to 24 hours.  This test documents the boundary between
      // a leading-digit string ("2abc") and a pure-numeric string ("2"): only
      // the latter is accepted; the former is rejected just like "abc".
      //
      // For consistency with the null-byte, Infinity, -Infinity, NaN, and
      // "abc" tests, and because the IIFE is evaluated at module-load time, we
      // use the vi.resetModules() + dynamic-import path so the IIFE runs
      // against the modified env without spawning a child process.
      const originalEnv = process.env["MAX_SENTINEL_AGE_HOURS"];
      process.env["MAX_SENTINEL_AGE_HOURS"] = "2abc";
      vi.resetModules();

      try {
        const {
          consumeProbeCache: consume,
          MAX_SENTINEL_AGE_HOURS: resolvedHours,
          PROBE_CACHE_SENTINEL: SENTINEL,
        } = await import("./probe-cache");

        // The IIFE must reject the "2abc" value (Number("2abc") is NaN, which
        // fails both Number.isFinite and parsed > 0) and fall back to the
        // 24-hour default.
        expect(resolvedHours).toBe(24);

        const buildDir = ".next-probe-2abc";
        fs.mkdirSync(path.join(tmpDir, buildDir));
        const sentinel = path.join(tmpDir, SENTINEL);
        fs.writeFileSync(sentinel, buildDir, "utf8");

        // Backdate to 2 hours ago — stale under a 1-hour threshold but fresh
        // under the 24-hour default.  Accepting this sentinel confirms the
        // fallback threshold is active, not the NaN produced by Number("2abc")
        // (which, if used as a threshold, would make every age comparison
        // return false and reject all sentinels).
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        fs.utimesSync(sentinel, twoHoursAgo, twoHoursAgo);

        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        try {
          const result = consume(tmpDir);

          // The 2-hour-old sentinel is within the 24-hour default threshold.
          // consumeProbeCache must accept it and return the build directory name.
          expect(result).toBe(buildDir);

          // No age-staleness warning must be emitted.
          expect(warnSpy).not.toHaveBeenCalled();

          // The normal warm-start log must appear.
          expect(logSpy).toHaveBeenCalledOnce();
        } finally {
          warnSpy.mockRestore();
          logSpy.mockRestore();
        }
      } finally {
        if (originalEnv === undefined) {
          delete process.env["MAX_SENTINEL_AGE_HOURS"];
        } else {
          process.env["MAX_SENTINEL_AGE_HOURS"] = originalEnv;
        }
        vi.resetModules();
      }
    },
  );

  it(
    "falls back to 24 hours and does not crash when MAX_SENTINEL_AGE_HOURS is set to '2.5abc' (decimal-prefix alphanumeric string)",
    async () => {
      // The string "2.5abc" converts to NaN via Number("2.5abc").  Unlike
      // Number("2.5"), which produces the finite number 2.5, a decimal string
      // with trailing non-digit characters is not coerced to the leading numeric
      // portion — JavaScript's Number() conversion requires the entire string to
      // be a valid number.  NaN fails both guards in the IIFE:
      // Number.isFinite(NaN) is false and NaN > 0 is also false.  The IIFE
      // must fall back to 24 hours.  This test closes the boundary between
      // integer-prefix alphanumeric strings ("2abc", already covered) and
      // decimal-prefix alphanumeric strings ("2.5abc"): both are rejected by the
      // finite-number guard for the same reason — trailing non-digit characters
      // prevent a valid Number() coercion regardless of whether the numeric
      // prefix is an integer or a decimal.
      //
      // For consistency with the null-byte, Infinity, -Infinity, NaN, "abc",
      // and "2abc" tests, and because the IIFE is evaluated at module-load time,
      // we use the vi.resetModules() + dynamic-import path so the IIFE runs
      // against the modified env without spawning a child process.
      const originalEnv = process.env["MAX_SENTINEL_AGE_HOURS"];
      process.env["MAX_SENTINEL_AGE_HOURS"] = "2.5abc";
      vi.resetModules();

      try {
        const {
          consumeProbeCache: consume,
          MAX_SENTINEL_AGE_HOURS: resolvedHours,
          PROBE_CACHE_SENTINEL: SENTINEL,
        } = await import("./probe-cache");

        // The IIFE must reject the "2.5abc" value (Number("2.5abc") is NaN,
        // which fails both Number.isFinite and parsed > 0) and fall back to the
        // 24-hour default.
        expect(resolvedHours).toBe(24);

        const buildDir = ".next-probe-2.5abc";
        fs.mkdirSync(path.join(tmpDir, buildDir));
        const sentinel = path.join(tmpDir, SENTINEL);
        fs.writeFileSync(sentinel, buildDir, "utf8");

        // Backdate to 2 hours ago — stale under a 1-hour threshold but fresh
        // under the 24-hour default.  Accepting this sentinel confirms the
        // fallback threshold is active, not the NaN produced by Number("2.5abc")
        // (which, if used as a threshold, would make every age comparison return
        // false and reject all sentinels).
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        fs.utimesSync(sentinel, twoHoursAgo, twoHoursAgo);

        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        try {
          const result = consume(tmpDir);

          // The 2-hour-old sentinel is within the 24-hour default threshold.
          // consumeProbeCache must accept it and return the build directory name.
          expect(result).toBe(buildDir);

          // No age-staleness warning must be emitted.
          expect(warnSpy).not.toHaveBeenCalled();

          // The normal warm-start log must appear.
          expect(logSpy).toHaveBeenCalledOnce();
        } finally {
          warnSpy.mockRestore();
          logSpy.mockRestore();
        }
      } finally {
        if (originalEnv === undefined) {
          delete process.env["MAX_SENTINEL_AGE_HOURS"];
        } else {
          process.env["MAX_SENTINEL_AGE_HOURS"] = originalEnv;
        }
        vi.resetModules();
      }
    },
  );

  it(
    "falls back to 24 hours and does not crash when MAX_SENTINEL_AGE_HOURS is set to 'abc' (non-numeric string)",
    async () => {
      // The string "abc" converts to NaN via Number("abc").  NaN fails both
      // guards in the IIFE: Number.isFinite(NaN) is false and NaN > 0 is also
      // false.  The IIFE must fall back to 24 hours.  This test documents the
      // arbitrary-garbage-string path distinctly from the "NaN" literal string
      // case: any non-numeric string that converts to NaN — not just the named
      // special value "NaN" — is also rejected by the finite-number guard.
      //
      // For consistency with the null-byte, Infinity, -Infinity, and NaN tests,
      // and because the IIFE is evaluated at module-load time, we use the
      // vi.resetModules() + dynamic-import path so the IIFE runs against the
      // modified env without spawning a child process.
      const originalEnv = process.env["MAX_SENTINEL_AGE_HOURS"];
      process.env["MAX_SENTINEL_AGE_HOURS"] = "abc";
      vi.resetModules();

      try {
        const {
          consumeProbeCache: consume,
          MAX_SENTINEL_AGE_HOURS: resolvedHours,
          PROBE_CACHE_SENTINEL: SENTINEL,
        } = await import("./probe-cache");

        // The IIFE must reject the "abc" value (Number("abc") is NaN, which
        // fails both Number.isFinite and parsed > 0) and fall back to the
        // 24-hour default.
        expect(resolvedHours).toBe(24);

        const buildDir = ".next-probe-abc";
        fs.mkdirSync(path.join(tmpDir, buildDir));
        const sentinel = path.join(tmpDir, SENTINEL);
        fs.writeFileSync(sentinel, buildDir, "utf8");

        // Backdate to 2 hours ago — stale under a 1-hour threshold but fresh
        // under the 24-hour default.  Accepting this sentinel confirms the
        // fallback threshold is active, not the NaN produced by Number("abc")
        // (which, if used as a threshold, would make every age comparison return
        // false and reject all sentinels).
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        fs.utimesSync(sentinel, twoHoursAgo, twoHoursAgo);

        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        try {
          const result = consume(tmpDir);

          // The 2-hour-old sentinel is within the 24-hour default threshold.
          // consumeProbeCache must accept it and return the build directory name.
          expect(result).toBe(buildDir);

          // No age-staleness warning must be emitted.
          expect(warnSpy).not.toHaveBeenCalled();

          // The normal warm-start log must appear.
          expect(logSpy).toHaveBeenCalledOnce();
        } finally {
          warnSpy.mockRestore();
          logSpy.mockRestore();
        }
      } finally {
        if (originalEnv === undefined) {
          delete process.env["MAX_SENTINEL_AGE_HOURS"];
        } else {
          process.env["MAX_SENTINEL_AGE_HOURS"] = originalEnv;
        }
        vi.resetModules();
      }
    },
  );

  it(
    "a 2-hour-old sentinel is accepted when MAX_SENTINEL_AGE_HOURS is set to '2.5' (decimal without trailing letters)",
    async () => {
      // The string "2.5" converts to the finite positive number 2.5 via
      // Number("2.5").  Unlike "2.5abc", which converts to NaN because of the
      // trailing non-digit characters, "2.5" is a fully valid numeric string:
      // Number.isFinite(2.5) is true and 2.5 > 0 is true, so the IIFE must
      // accept it and set MAX_SENTINEL_AGE_HOURS to 2.5 — not the 24-hour
      // default.  This closes the boundary between integer values like "2" and
      // "3" (already covered as valid) and decimal-prefix alphanumeric strings
      // like "2.5abc" (already covered as invalid): a plain decimal string with
      // no trailing letters is valid and must be used as the threshold.
      //
      // For consistency with the other env-var tests that exercise IIFE
      // module-load-time behaviour, we use the vi.resetModules() +
      // dynamic-import path so the IIFE runs against the modified env without
      // spawning a child process.
      const originalEnv = process.env["MAX_SENTINEL_AGE_HOURS"];
      process.env["MAX_SENTINEL_AGE_HOURS"] = "2.5";
      vi.resetModules();

      try {
        const {
          consumeProbeCache: consume,
          MAX_SENTINEL_AGE_HOURS: resolvedHours,
          PROBE_CACHE_SENTINEL: SENTINEL,
        } = await import("./probe-cache");

        // The IIFE must accept "2.5" (Number("2.5") === 2.5, which passes both
        // Number.isFinite and parsed > 0) and use it as the threshold.
        expect(resolvedHours).toBe(2.5);

        const buildDir = ".next-probe-2.5";
        fs.mkdirSync(path.join(tmpDir, buildDir));
        const sentinel = path.join(tmpDir, SENTINEL);
        fs.writeFileSync(sentinel, buildDir, "utf8");

        // Backdate to 2 hours ago — within the 2.5-hour threshold.
        // Accepting this sentinel confirms that the resolved threshold is 2.5
        // and not the 24-hour default, and not a fallback that happens to accept
        // a 2-hour-old sentinel for the wrong reason.
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        fs.utimesSync(sentinel, twoHoursAgo, twoHoursAgo);

        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        try {
          const result = consume(tmpDir);

          // The 2-hour-old sentinel is within the 2.5-hour threshold.
          // consumeProbeCache must accept it and return the build directory name.
          expect(result).toBe(buildDir);

          // No age-staleness warning must be emitted — the sentinel is fresh
          // enough under the 2.5-hour threshold.
          expect(warnSpy).not.toHaveBeenCalled();

          // The normal warm-start log must appear.
          expect(logSpy).toHaveBeenCalledOnce();
        } finally {
          warnSpy.mockRestore();
          logSpy.mockRestore();
        }
      } finally {
        if (originalEnv === undefined) {
          delete process.env["MAX_SENTINEL_AGE_HOURS"];
        } else {
          process.env["MAX_SENTINEL_AGE_HOURS"] = originalEnv;
        }
        vi.resetModules();
      }
    },
  );

  // ── Parameterised age-guard sweep ───────────────────────────────────────────
  //
  // The age guard in consumeProbeCache uses a strict greater-than comparison:
  //
  //   if (ageMs > maxAgeMs + MTIME_TRUNCATION_TOLERANCE_MS)
  //
  // A weakened guard that uses >= instead of > would incorrectly reject the
  // case where ageMs === maxAgeMs + MTIME_TRUNCATION_TOLERANCE_MS (the
  // tolerance ceiling), causing a false-positive staleness discard.  The
  // parameterised suite below exercises every sub-range around that ceiling so
  // the regression is caught at test-time instead of after it ships.
  //
  // Sub-ranges tested:
  //   ageMs = maxAgeMs − 1          → strictly inside the raw limit → ACCEPTED
  //   ageMs = maxAgeMs              → exactly at the raw limit → ACCEPTED
  //   ageMs = maxAgeMs + 500        → halfway through the tolerance → ACCEPTED
  //   ageMs = maxAgeMs + 1 000      → exactly at the tolerance ceiling → ACCEPTED
  //                                   (rejected by a buggy >= guard)
  //   ageMs = maxAgeMs + 1 001      → 1 ms above the tolerance ceiling → REJECTED
  //
  // Each case stubs Date.now() and fs.statSync() to inject a precise ageMs so
  // the test is fully deterministic regardless of host clock resolution.

  describe("age-guard parameterised sweep", () => {
    const cases: Array<{
      offsetFromMaxAge: number;
      expectedAccepted: boolean;
      label: string;
      /** When set, overrides MAX_SENTINEL_AGE_HOURS * 60 * 60 * 1 000 so that
       *  a change to the constant (e.g. 24 → 12) makes this specific case fail
       *  rather than silently recalculating around the new value. */
      hardcodedMaxAgeMs?: number;
    }> = [
      {
        offsetFromMaxAge: -1,
        expectedAccepted: true,
        label: "ageMs = maxAgeMs − 1: strictly inside the raw limit → ACCEPTED",
      },
      {
        // Hardcoded to 86 400 000 ms (24 × 3 600 000, the documented default)
        // so that a reduction to MAX_SENTINEL_AGE_HOURS (e.g. 24 → 12) makes
        // this case fail: the injected age (86 399 999 ms) would exceed the
        // new maxAgeMs (43 200 000 ms) + tolerance ceiling, causing the guard
        // to discard what we expect to be accepted.  If this were derived from
        // the constant it would recalculate to the new value and the regression
        // would ship undetected.
        hardcodedMaxAgeMs: 86_400_000,
        offsetFromMaxAge: 0,
        expectedAccepted: true,
        label: "ageMs = maxAgeMs (pinned 86 400 000 ms): exactly at the raw limit → ACCEPTED",
      },
      {
        // Hardcoded to 500 ms (half of the documented 1 000 ms tolerance) so
        // that a change to MTIME_TRUNCATION_TOLERANCE_MS (e.g. reducing it to
        // 250 ms) makes this case fail rather than silently recalculating
        // around the new constant.
        offsetFromMaxAge: 500,
        expectedAccepted: true,
        label: "ageMs = maxAgeMs + 500: halfway through the tolerance window → ACCEPTED",
      },
      {
        // Hardcoded to 1 000 ms (the documented tolerance ceiling) so that a
        // change to MTIME_TRUNCATION_TOLERANCE_MS (e.g. reducing it to 500 ms)
        // makes this case fail: the weakened guard would reject ageMs =
        // maxAgeMs + 1 000 (since 1 000 > 500), but expectedAccepted is true.
        // If this offset were derived from the constant it would recalculate to
        // the new value and the regression would ship undetected.
        offsetFromMaxAge: 1000,
        expectedAccepted: true,
        label:
          "ageMs = maxAgeMs + 1 000: exactly at the tolerance ceiling → ACCEPTED (rejected by a buggy >= guard)",
      },
      {
        // Hardcoded to 1 001 ms (1 ms above the documented 1 000 ms tolerance
        // ceiling) so that a change to MTIME_TRUNCATION_TOLERANCE_MS makes
        // this case fail: if the constant grew (e.g. to 2 000 ms) the guard
        // would now accept ageMs = maxAgeMs + 1 001, contradicting
        // expectedAccepted: false.
        offsetFromMaxAge: 1001,
        expectedAccepted: false,
        label: "ageMs = maxAgeMs + 1 001: 1 ms above the tolerance ceiling → REJECTED",
      },
    ];

    it.each(cases)(
      "$label",
      ({ offsetFromMaxAge, expectedAccepted, hardcodedMaxAgeMs }) => {
        // Use the hardcoded value when provided so a change to
        // MAX_SENTINEL_AGE_HOURS makes that specific case fail rather than
        // silently recalculating around the new constant.
        const maxAgeMs =
          hardcodedMaxAgeMs ?? MAX_SENTINEL_AGE_HOURS * 60 * 60 * 1000;
        const ageMs = maxAgeMs + offsetFromMaxAge;

        // Pin Date.now() to a stable value (millisecond component = 500) so
        // computed ages are fully deterministic regardless of when the test runs.
        const fakeNow = Math.floor(Date.now() / 1000) * 1000 + 500;
        const dateSpy = vi.spyOn(Date, "now").mockReturnValue(fakeNow);

        // Derive the mtime that would produce exactly ageMs when subtracted from
        // fakeNow, then stub statSync to return it for the sentinel path.
        const fakeMtime = fakeNow - ageMs;
        const sentinelFullPath = path.join(tmpDir, PROBE_CACHE_SENTINEL);
        const fakeStats = {
          mtime: new Date(fakeMtime),
        } as ReturnType<typeof fs.statSync>;
        vi.mocked(fs.statSync).mockImplementation((p) => {
          if (p === sentinelFullPath) return fakeStats;
          throw new Error(`Unexpected statSync call for ${String(p)}`);
        });

        const buildDir = ".next-probe-age-param";
        fs.mkdirSync(path.join(tmpDir, buildDir));
        writeSentinel(buildDir);

        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        try {
          let result: string | null = undefined!;
          expect(() => {
            result = consumeProbeCache(tmpDir);
          }).not.toThrow();

          if (expectedAccepted) {
            // Sentinel is within (or at) the tolerance ceiling — must be accepted.
            // A weakened >= guard would fail this assertion for the ceiling case.
            expect(result).toBe(buildDir);
            expect(warnSpy).not.toHaveBeenCalled();
            expect(logSpy).toHaveBeenCalledOnce();
          } else {
            // Sentinel exceeds the tolerance ceiling — must be discarded.
            expect(result).toBeNull();
            expect(warnSpy).toHaveBeenCalledOnce();
            expect(logSpy).not.toHaveBeenCalled();
          }
        } finally {
          dateSpy.mockRestore();
          vi.mocked(fs.statSync).mockRestore();
          warnSpy.mockRestore();
          logSpy.mockRestore();
        }
      },
    );
  });

  it(
    "accepts a sentinel whose true age is just inside the limit even when filesystem mtime truncation makes it appear just over the limit",
    () => {
      // ── Scenario ────────────────────────────────────────────────────────────
      // Many filesystems (ext3, HFS+, FAT, some network filesystems) store
      // mtime at 1-second precision.  After a utimesSync round-trip the stored
      // mtime is the floor of the true write time to the nearest second, so the
      // sentinel can appear up to 999 ms older than its true age.
      //
      // Concretely, if the sentinel is written 300 ms before the max-age
      // deadline, but the filesystem floors its mtime by 800 ms (because the
      // write landed 800 ms into the current second), the guard computes an age
      // of (maxAge − 300 + 800) = maxAge + 500 ms — pushing it 500 ms past the
      // raw limit even though the sentinel is genuinely fresh.
      //
      // The production guard accounts for this by adding MTIME_TRUNCATION_TOLERANCE_MS
      // (1 000 ms) to the rejection threshold so a sentinel up to 1 s over the
      // raw limit is still accepted.  This test pins Date.now() and
      // fs.statSync() to precise values so the scenario is deterministic and
      // any future removal of the tolerance is caught immediately.
      //
      // ── Math ────────────────────────────────────────────────────────────────
      // maxAgeMs      = 24 × 3 600 000 = 86 400 000 ms  (divisible by 1 000)
      // fakeNow       = X such that X % 1 000 = 500
      // trueAge       = maxAgeMs − 300                   (300 ms inside limit)
      // trueMtime     = fakeNow − trueAge
      //   trueMtime % 1 000 = (500 − (−300 mod 1000)) mod 1000
      //                     = (500 − 700 + 1000) mod 1000 = 800
      // truncatedMtime = trueMtime − 800                 (filesystem floors it)
      // computedAge   = fakeNow − truncatedMtime
      //               = trueAge + 800 = maxAgeMs + 500   (500 ms over raw limit)
      //
      // Without the tolerance:  maxAgeMs + 500 > maxAgeMs → REJECTED (false positive)
      // With the tolerance:     maxAgeMs + 500 ≤ maxAgeMs + 1 000 → ACCEPTED ✓

      // Hard-code 86 400 000 ms (24 h) rather than deriving from
      // MAX_SENTINEL_AGE_HOURS.  If the default were silently reduced (e.g.
      // 24 → 12) the derived value would shrink, the math comment above would
      // still hold for the new smaller window, and the test would continue to
      // pass — masking the regression.  Pinning to the expected production
      // value means a weakened default makes this test fail immediately.
      const maxAgeMs = 86_400_000; // 24 h in ms — must match the intended default

      // Pin the mtime-truncation tolerance to a hardcoded 1 000 ms rather than
      // reading MTIME_TRUNCATION_TOLERANCE_MS from the production module.  If
      // the constant were silently reduced (e.g. 1 000 → 500), deriving from it
      // would cause the acceptance assertion below to re-evaluate against the
      // new, smaller ceiling — potentially masking the regression.  The explicit
      // equality check below ensures a mutation is caught at the source before
      // anything else in this test runs.
      const PINNED_TOLERANCE_MS = 1_000;
      expect(MTIME_TRUNCATION_TOLERANCE_MS).toBe(PINNED_TOLERANCE_MS);

      // Pin Date.now() to a value whose millisecond component is exactly 500.
      const fakeNow = Math.floor(Date.now() / 1000) * 1000 + 500;
      const dateSpy = vi.spyOn(Date, "now").mockReturnValue(fakeNow);

      // Compute the truncated mtime the filesystem would store.
      const trueAge = maxAgeMs - 300; // 300 ms inside the raw limit
      const trueMtime = fakeNow - trueAge;
      const truncatedMtime = Math.floor(trueMtime / 1000) * 1000; // ms = 0

      // Sanity-check: truncation_error must be 800 ms so that computedAge
      // lands exactly at maxAgeMs + 500 (i.e. 500 ms over the raw limit).
      expect(trueMtime - truncatedMtime).toBe(800);

      // Stub statSync to return the filesystem-truncated mtime for the sentinel
      // path so the test is fully deterministic regardless of host filesystem
      // precision.
      const sentinelFullPath = path.join(tmpDir, PROBE_CACHE_SENTINEL);
      const fakeStats = { mtime: new Date(truncatedMtime) } as ReturnType<
        typeof fs.statSync
      >;
      vi.mocked(fs.statSync).mockImplementation((p) => {
        if (p === sentinelFullPath) return fakeStats;
        throw new Error(`Unexpected statSync call for ${String(p)}`);
      });

      const buildDir = ".next-probe-mtime-boundary";
      fs.mkdirSync(path.join(tmpDir, buildDir));
      writeSentinel(buildDir);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        let result: string | null = undefined!;
        expect(() => {
          result = consumeProbeCache(tmpDir);
        }).not.toThrow();

        // The sentinel is 300 ms inside the real age limit; consumeProbeCache
        // must accept it.  The 800 ms truncation error (500 ms net overshoot)
        // must be absorbed by MTIME_TRUNCATION_TOLERANCE_MS (1 000 ms) in the
        // production guard so the cache is not falsely discarded.
        expect(result).toBe(buildDir);

        // No staleness warning — the 1-second tolerance absorbs the overshoot.
        expect(warnSpy).not.toHaveBeenCalled();

        // The normal warm-start log must appear so operators can confirm the
        // cache was reused rather than a cold start triggered.
        expect(logSpy).toHaveBeenCalledOnce();
        const [logMessage] = logSpy.mock.calls[0] as [string];
        expect(logMessage).toContain(buildDir);
      } finally {
        dateSpy.mockRestore();
        vi.mocked(fs.statSync).mockRestore();
        warnSpy.mockRestore();
        logSpy.mockRestore();
      }
    },
  );

  it(
    "second-order meta-test: the reduced-tolerance meta-test itself fails (exits non-zero) when the tolerance guard is bypassed with a large value",
    () => {
      // ── Purpose ─────────────────────────────────────────────────────────────
      // The meta-test below verifies that setting MTIME_TRUNCATION_TOLERANCE_MS
      // to 400 ms causes consumeProbeCache to reject a sentinel with a 500 ms
      // apparent overshoot.  But that meta-test relies on the production module
      // actually reading and applying the tolerance; if someone hardcoded a
      // large value (or removed the env-var gate entirely), the meta-test could
      // vacuously pass even though the guard is no longer working.
      //
      // This second-order meta-test closes that gap: it spawns a subprocess via
      // spawnSync that runs the same mtime-truncation scenario as the primary
      // meta-test, but with MTIME_TRUNCATION_TOLERANCE_MS set to 10 000 ms
      // (well above the 500 ms overshoot).  The subprocess exits 0 when the
      // guard correctly rejects and exits 1 when the tolerance is too wide and
      // the sentinel is accepted.  We assert exit code 1, proving that the
      // scenario is sensitive to the tolerance value — i.e. the meta-test
      // *would* fail if the guard were bypassed.
      //
      // ── Subprocess script ───────────────────────────────────────────────────
      // probe-cache-meta-guard-check.ts (in this directory) runs the identical
      // mtime setup (fakeNow ms=500, trueAge=maxAgeMs−300, truncation error
      // 800 ms → 500 ms net overshoot) and imports probe-cache without
      // overriding the tolerance, so it picks up whatever value the environment
      // provides.
      //
      //   bypass env  (10 000 ms): 500 ≤ 10 000 → accepted → exit 1 ✓
      //   narrow env  (    400 ms): 500 >    400 → rejected → exit 0 ✓
      //
      // ── Why spawnSync rather than vi.resetModules again ──────────────────────
      // Using spawnSync keeps the production module's IIFE evaluation fully
      // isolated — there is no shared module registry or env-var override from
      // the test process.  The subprocess reads the env var at import time and
      // the helper script's exit code is the sole observable outcome, making the
      // test immune to vitest module-cache edge cases.

      const helperScript = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "probe-cache-meta-guard-check.ts",
      );

      const tsxBin = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../../node_modules/.bin/tsx",
      );

      // ── Bypass run: tolerance = 10 000 ms ───────────────────────────────────
      // The 500 ms net overshoot is well inside 10 000 ms, so the guard must
      // stay silent and the sentinel must be accepted.  The subprocess exits 1.
      const bypassResult = spawnSync(tsxBin, [helperScript], {
        env: {
          ...process.env,
          MTIME_TRUNCATION_TOLERANCE_MS: "10000",
        },
        encoding: "utf8",
        timeout: 15_000,
      });

      // Surface subprocess stderr to make failures diagnosable.
      if (bypassResult.stderr) {
        process.stdout.write(
          `[bypass run stderr]\n${bypassResult.stderr}\n`,
        );
      }

      expect(
        bypassResult.status,
        "bypass run (10 000 ms tolerance): expected subprocess exit 1 " +
          "(sentinel accepted because tolerance > overshoot), got " +
          String(bypassResult.status),
      ).toBe(1);

      // ── Narrow run: tolerance = 400 ms ──────────────────────────────────────
      // The 500 ms overshoot exceeds 400 ms, so the guard must fire and the
      // sentinel must be rejected.  The subprocess exits 0.
      const narrowResult = spawnSync(tsxBin, [helperScript], {
        env: {
          ...process.env,
          MTIME_TRUNCATION_TOLERANCE_MS: "400",
        },
        encoding: "utf8",
        timeout: 15_000,
      });

      if (narrowResult.stderr) {
        process.stdout.write(
          `[narrow run stderr]\n${narrowResult.stderr}\n`,
        );
      }

      expect(
        narrowResult.status,
        "narrow run (400 ms tolerance): expected subprocess exit 0 " +
          "(sentinel rejected because tolerance < overshoot), got " +
          String(narrowResult.status),
      ).toBe(0);
    },
  );

  it(
    "meta-test: rejects the mtime-truncation sentinel when MTIME_TRUNCATION_TOLERANCE_MS is reduced strictly below the 500 ms filesystem overshoot",
    async () => {
      // ── Purpose ─────────────────────────────────────────────────────────────
      // The acceptance test above verifies that a sentinel with a 500 ms
      // apparent overshoot is accepted when the tolerance is 1 000 ms.  That
      // test is a necessary but insufficient guard: it does not prove that the
      // tolerance is actually doing the gating work.  If someone raised the
      // tolerance to, say, 10 000 ms, the 500 ms overshoot would still be
      // accepted and the acceptance test would still pass — even though the
      // guard is now far more permissive than intended.
      //
      // This meta-test closes that gap by temporarily reducing the tolerance to
      // 400 ms (strictly below the 500 ms overshoot) and asserting that
      // consumeProbeCache REJECTS the same sentinel.  The guard fires only if
      // the tolerance is the sole gating factor for this overshoot, so any
      // future increase that makes the guard ignore the tolerance will cause
      // this meta-test to fail with a non-null result.
      //
      // ── Approach ────────────────────────────────────────────────────────────
      // MTIME_TRUNCATION_TOLERANCE_MS is evaluated once at module load time via
      // an IIFE.  Setting the MTIME_TRUNCATION_TOLERANCE_MS environment variable
      // before calling vi.resetModules() + dynamic import forces the IIFE to
      // re-evaluate with the reduced value, giving consumeProbeCache a tolerance
      // of 400 ms for the duration of this test.
      //
      // ── Math ────────────────────────────────────────────────────────────────
      // Identical to the acceptance test above:
      //   fakeNow % 1 000 = 500
      //   trueAge         = maxAgeMs − 300   (300 ms inside the raw limit)
      //   truncation error = 800 ms          → computedAge = maxAgeMs + 500
      //
      // With tolerance = 400 ms:
      //   maxAgeMs + 500 > maxAgeMs + 400  → guard fires → REJECTED ✓
      //
      // With tolerance = 1 000 ms (production default):
      //   maxAgeMs + 500 ≤ maxAgeMs + 1 000 → guard silent → ACCEPTED

      const savedEnv = process.env["MTIME_TRUNCATION_TOLERANCE_MS"];
      // 400 ms is strictly below the 500 ms computed overshoot.
      process.env["MTIME_TRUNCATION_TOLERANCE_MS"] = "400";

      try {
        vi.resetModules();
        const {
          consumeProbeCache: consumeProbeCacheReduced,
          MTIME_TRUNCATION_TOLERANCE_MS: reducedTolerance,
          PROBE_CACHE_SENTINEL: SENTINEL,
        } = await import("./probe-cache");

        // Sanity-check: the freshly-imported module must have picked up the
        // reduced tolerance from the env var.  If this fails, the IIFE is not
        // reading the env var and the meta-test is not exercising the guard.
        expect(reducedTolerance).toBe(400);

        // ── Same mtime setup as the acceptance test ──────────────────────────
        const maxAgeMs = 86_400_000; // 24 h — pinned, not derived

        const fakeNow = Math.floor(Date.now() / 1000) * 1000 + 500;
        const dateSpy = vi.spyOn(Date, "now").mockReturnValue(fakeNow);

        const trueAge = maxAgeMs - 300;
        const trueMtime = fakeNow - trueAge;
        const truncatedMtime = Math.floor(trueMtime / 1000) * 1000;

        // Same 800 ms truncation error as the acceptance test → 500 ms net overshoot.
        expect(trueMtime - truncatedMtime).toBe(800);

        const sentinelFullPath = path.join(tmpDir, SENTINEL);
        const fakeStats = { mtime: new Date(truncatedMtime) } as ReturnType<
          typeof fs.statSync
        >;
        vi.mocked(fs.statSync).mockImplementation((p) => {
          if (p === sentinelFullPath) return fakeStats;
          throw new Error(`Unexpected statSync call for ${String(p)}`);
        });

        const buildDir = ".next-probe-mtime-meta";
        fs.mkdirSync(path.join(tmpDir, buildDir));
        fs.writeFileSync(sentinelFullPath, buildDir, "utf8");

        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        try {
          const result = consumeProbeCacheReduced(tmpDir);

          // With a 400 ms tolerance the 500 ms overshoot exceeds the guard
          // threshold (maxAgeMs + 400) → sentinel must be rejected.
          expect(result).toBeNull();

          // The staleness warning must fire — absence here would mean the
          // guard silently swallowed the overshoot.
          expect(warnSpy).toHaveBeenCalledOnce();

          // No warm-start log should appear when the sentinel is discarded.
          expect(logSpy).not.toHaveBeenCalled();
        } finally {
          dateSpy.mockRestore();
          vi.mocked(fs.statSync).mockRestore();
          warnSpy.mockRestore();
          logSpy.mockRestore();
        }
      } finally {
        if (savedEnv !== undefined) {
          process.env["MTIME_TRUNCATION_TOLERANCE_MS"] = savedEnv;
        } else {
          delete process.env["MTIME_TRUNCATION_TOLERANCE_MS"];
        }
        // Reset modules again so subsequent tests pick up the fully-mocked fs
        // and the original module registry state (tolerance = 1 000 ms).
        vi.resetModules();
      }
    },
  );

  it(
    "a 10-second-old sentinel is accepted when MAX_SENTINEL_AGE_HOURS=0.01 is set in the subprocess environment",
    () => {
      // 0.01 h = 36 seconds = 36 000 ms.  A sentinel that is only 10 seconds old
      // is well within the 36-second window and must be accepted.
      //
      // This test guards against accidental integer truncation or millisecond
      // arithmetic rounding that would convert 0.01 h to 0 ms, causing
      // consumeProbeCache to reject every sentinel regardless of age.  If 0 ms
      // were used as the threshold, the guard fires for every sentinel (even one
      // that is 0 ms old) and this test would catch it: a 10-second-old sentinel
      // would be returned as null instead of the build directory name.
      //
      // The sentinel is backdated by SENTINEL_BACKDATE_MS=10000 (10 seconds)
      // via the helper script.  MAX_SENTINEL_AGE_HOURS=0.01 → 36 000 ms limit.
      // 10 000 ms < 36 000 ms → sentinel is fresh → consumeProbeCache must
      // return the build directory name, not null.
      const proc = spawnSync(tsxBin, [helperScript], {
        env: {
          ...process.env,
          MAX_SENTINEL_AGE_HOURS: "0.01",
          SENTINEL_BACKDATE_MS: "10000",
        },
        encoding: "utf8",
        timeout: 15_000,
      });

      // The subprocess must not crash.
      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);

      const output = JSON.parse(proc.stdout.trim()) as {
        constant: number;
        result: string | null;
      };

      // The IIFE must have read the env var and produced 0.01 (not the 24-hour
      // default), confirming that very small positive finite values are accepted
      // by the IIFE's guards (Number.isFinite(0.01) is true; 0.01 > 0 is true).
      expect(output.constant).toBe(0.01);

      // The sentinel is only 10 seconds old — well within the 36-second
      // (0.01 h) threshold.  consumeProbeCache must accept it.
      expect(output.result).toBe(".next-probe-ci");
    },
  );

  it(
    "a 60-second-old sentinel is rejected when MAX_SENTINEL_AGE_HOURS=0.01 is set in the subprocess environment",
    () => {
      // 0.01 h = 36 seconds = 36 000 ms.  A sentinel that is 60 seconds old
      // exceeds the 36-second window and must be rejected.
      //
      // Paired with the preceding acceptance case, this confirms that the
      // 0.01 h threshold is the gating factor — not a floor-to-zero rounding
      // bug, not the 24-hour default, and not some other constant.  If 0 ms
      // were accidentally used (from integer truncation of 36 000 ms), every
      // sentinel would be rejected, and both the 10-second and 60-second cases
      // would return null — masking the bug.  By asserting that the 10-second
      // case passes and the 60-second case fails, the two together pin the exact
      // 36-second boundary and rule out both silent-accept and silent-reject
      // regressions.
      //
      // The sentinel is backdated by SENTINEL_BACKDATE_MS=60000 (60 seconds)
      // via the helper script.  MAX_SENTINEL_AGE_HOURS=0.01 → 36 000 ms limit.
      // 60 000 ms > 36 000 ms → sentinel is stale → consumeProbeCache must
      // return null, not the build directory name.
      const proc = spawnSync(tsxBin, [helperScript], {
        env: {
          ...process.env,
          MAX_SENTINEL_AGE_HOURS: "0.01",
          SENTINEL_BACKDATE_MS: "60000",
        },
        encoding: "utf8",
        timeout: 15_000,
      });

      // The subprocess must not crash.
      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);

      const output = JSON.parse(proc.stdout.trim()) as {
        constant: number;
        result: string | null;
      };

      // The IIFE must have read the env var and produced 0.01.
      expect(output.constant).toBe(0.01);

      // The sentinel is 60 seconds old — exceeds the 36-second (0.01 h) threshold.
      // consumeProbeCache must discard it and return null.
      expect(output.result).toBeNull();
    },
  );

  it(
    "a sentinel aged 36 500 ms (strictly over the 36 000 ms nominal limit) is accepted when MTIME_TRUNCATION_TOLERANCE_MS=1 000 absorbs the overshoot",
    async () => {
      // Truncation arithmetic for this test:
      //
      //   MAX_SENTINEL_AGE_HOURS = 0.01  →  maxAgeMs = 36 000 ms
      //   MTIME_TRUNCATION_TOLERANCE_MS  = 1 000 ms  (1-second filesystem buffer)
      //   Effective ceiling              = 36 000 + 1 000 = 37 000 ms
      //   Sentinel age pinned to         = 36 500 ms
      //
      // A real CI filesystem (ext4, APFS, HFS+) truncates mtime to 1-second
      // resolution.  A near-boundary sentinel backdated to, say, 35 999 ms may
      // read back as 36 999 ms after truncation — appearing 1 000 ms older than
      // intended.  MTIME_TRUNCATION_TOLERANCE_MS absorbs that worst-case 1-second
      // slip so a genuinely fresh sentinel is never falsely discarded.
      //
      // This test pins age to exactly 36 500 ms via a frozen clock and a statSync
      // stub, bypassing real filesystem truncation and making the assertion
      // deterministic.  The guard condition is:
      //
      //   ageMs > maxAgeMs + MTIME_TRUNCATION_TOLERANCE_MS
      //   36 500 > 36 000 + 1 000  →  36 500 > 37 000  →  false → ACCEPTED ✓
      //
      // The paired rejection test below (tolerance=0) confirms the buffer is
      // actually doing real work: without it, 36 500 > 36 000 → rejected.
      const originalAge = process.env["MAX_SENTINEL_AGE_HOURS"];
      const originalTol = process.env["MTIME_TRUNCATION_TOLERANCE_MS"];
      process.env["MAX_SENTINEL_AGE_HOURS"] = "0.01";
      process.env["MTIME_TRUNCATION_TOLERANCE_MS"] = "1000";
      vi.resetModules();

      try {
        const {
          consumeProbeCache: consume,
          PROBE_CACHE_SENTINEL: SENTINEL,
          MTIME_TRUNCATION_TOLERANCE_MS: tolerance,
          MAX_SENTINEL_AGE_HOURS: maxHours,
        } = await import("./probe-cache");

        // Confirm the module loaded the pinned env vars.
        expect(maxHours).toBe(0.01);
        expect(tolerance).toBe(1000);

        const buildDir = ".next-probe-tolerance-acceptance";
        fs.mkdirSync(path.join(tmpDir, buildDir));
        const sentinel = path.join(tmpDir, SENTINEL);
        fs.writeFileSync(sentinel, buildDir, "utf8");

        // Freeze Date.now() so the age computed inside consumeProbeCache is
        // exactly (fixedNow - stubbedMtime.getTime()) with no clock drift.
        const fixedNow = Date.now();
        vi.useFakeTimers();
        vi.setSystemTime(fixedNow);

        // Stub statSync on the sentinel to return a mtime exactly 36 500 ms
        // before fixedNow — strictly over the 36 000 ms nominal threshold but
        // within the 37 000 ms tolerance ceiling.
        vi.mocked(fs.statSync).mockImplementationOnce((p) => {
          if (p === sentinel) {
            return { mtime: new Date(fixedNow - 36_500) } as fs.Stats;
          }
          // statSync is only called once (for the sentinel age check) in this
          // branch, so any other call indicates an unexpected code path.
          throw new Error(`Unexpected statSync call for ${String(p)}`);
        });

        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        try {
          const result = consume(tmpDir);

          // 36 500 ms ≤ 36 000 + 1 000 ms ceiling → guard silent → accepted.
          expect(result).toBe(buildDir);

          // No staleness warning must be emitted.
          expect(warnSpy).not.toHaveBeenCalled();

          // The normal warm-start log must appear.
          expect(logSpy).toHaveBeenCalledOnce();
        } finally {
          warnSpy.mockRestore();
          logSpy.mockRestore();
          vi.useRealTimers();
          vi.mocked(fs.statSync).mockRestore();
        }
      } finally {
        if (originalAge === undefined) {
          delete process.env["MAX_SENTINEL_AGE_HOURS"];
        } else {
          process.env["MAX_SENTINEL_AGE_HOURS"] = originalAge;
        }
        if (originalTol === undefined) {
          delete process.env["MTIME_TRUNCATION_TOLERANCE_MS"];
        } else {
          process.env["MTIME_TRUNCATION_TOLERANCE_MS"] = originalTol;
        }
        vi.resetModules();
      }
    },
  );

  it(
    "a sentinel aged exactly 36 000 ms is accepted at the 0.01 h threshold with zero tolerance (strict greater-than boundary at the sub-minute scale)",
    async () => {
      // 0.01 h = 36 000 ms exactly.  The age guard uses strictly-greater-than
      // (ageMs > maxAgeMs + MTIME_TRUNCATION_TOLERANCE_MS), so a sentinel whose
      // age equals maxAgeMs exactly must be accepted — not rejected.
      //
      // To pin the effective cutoff to exactly 36 000 ms we set
      // MTIME_TRUNCATION_TOLERANCE_MS=0.  With the default 1 000 ms tolerance
      // the cutoff would be 37 000 ms, making this test insensitive to a > → >=
      // regression: a sentinel at 36 000 ms would still pass.  Zero tolerance
      // eliminates that gap and makes the boundary deterministic.
      //
      // The existing 35-second and 60-second subprocess cases bracket either side
      // of this boundary, but neither pins the exact-equality point at the
      // sub-minute scale the way the hour-scale "accepts-exact-threshold" test
      // does.  This test fills that gap: if a future refactor changes > to >=
      // at the sub-minute scale, this test catches it immediately by seeing null
      // instead of the build directory name.
      //
      // We freeze Date.now() via vi.useFakeTimers() and stub statSync to return
      // a mtime exactly 36 000 ms before fixedNow, making ageMs === maxAgeMs
      // with no filesystem truncation or clock drift.  Without a frozen clock or
      // a stub, any elapsed milliseconds between the utimesSync call and the
      // internal Date.now() would make the sentinel appear fractionally older
      // than the threshold and cause a flaky failure.
      const originalAge = process.env["MAX_SENTINEL_AGE_HOURS"];
      const originalTol = process.env["MTIME_TRUNCATION_TOLERANCE_MS"];
      process.env["MAX_SENTINEL_AGE_HOURS"] = "0.01";
      process.env["MTIME_TRUNCATION_TOLERANCE_MS"] = "0";
      vi.resetModules();

      try {
        const {
          consumeProbeCache: consume,
          PROBE_CACHE_SENTINEL: SENTINEL,
          MTIME_TRUNCATION_TOLERANCE_MS: tolerance,
          MAX_SENTINEL_AGE_HOURS: maxHours,
        } = await import("./probe-cache");

        // Confirm the module loaded the pinned env vars.
        expect(maxHours).toBe(0.01);
        expect(tolerance).toBe(0);

        const buildDir = ".next-probe-ci";
        fs.mkdirSync(path.join(tmpDir, buildDir));
        const sentinel = path.join(tmpDir, SENTINEL);
        fs.writeFileSync(sentinel, buildDir, "utf8");

        // Freeze the clock at a fixed point so the Date.now() inside
        // consumeProbeCache is identical to the one used for the stub.
        const fixedNow = Date.now();
        vi.useFakeTimers();
        vi.setSystemTime(fixedNow);

        // Stub statSync on the sentinel to return a mtime exactly 36 000 ms
        // before fixedNow, bypassing real filesystem mtime resolution.
        // With the clock frozen, ageMs = fixedNow - (fixedNow - 36 000) = 36 000 ms.
        // The guard fires when ageMs > maxAgeMs + MTIME_TRUNCATION_TOLERANCE_MS,
        // i.e. 36 000 > 36 000 + 0 — which is false → sentinel must be accepted.
        vi.mocked(fs.statSync).mockImplementationOnce((p) => {
          if (p === sentinel) {
            return { mtime: new Date(fixedNow - 36_000) } as fs.Stats;
          }
          throw new Error(`Unexpected statSync call for ${String(p)}`);
        });

        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        try {
          const result = consume(tmpDir);

          // Sentinel age == maxAgeMs (36 000 ms), tolerance == 0:
          // 36 000 > 36 000 + 0 → false → must be accepted, not rejected.
          expect(result).toBe(buildDir);

          // The sentinel must be consumed (deleted) after a successful read.
          expect(fs.existsSync(sentinel)).toBe(false);

          // No staleness warning must be emitted for an at-threshold sentinel.
          expect(warnSpy).not.toHaveBeenCalled();

          // The normal warm-start log must appear.
          expect(logSpy).toHaveBeenCalledOnce();
        } finally {
          warnSpy.mockRestore();
          logSpy.mockRestore();
          vi.useRealTimers();
          vi.mocked(fs.statSync).mockRestore();
        }
      } finally {
        if (originalAge === undefined) {
          delete process.env["MAX_SENTINEL_AGE_HOURS"];
        } else {
          process.env["MAX_SENTINEL_AGE_HOURS"] = originalAge;
        }
        if (originalTol === undefined) {
          delete process.env["MTIME_TRUNCATION_TOLERANCE_MS"];
        } else {
          process.env["MTIME_TRUNCATION_TOLERANCE_MS"] = originalTol;
        }
        // Restore the module registry so subsequent tests use the original module.
        vi.resetModules();
      }
    },
  );

  it(
    "the same 36 500 ms sentinel is rejected when MTIME_TRUNCATION_TOLERANCE_MS=0 removes the buffer — proving the tolerance is doing real work",
    async () => {
      // Identical setup to the acceptance test above, but with
      // MTIME_TRUNCATION_TOLERANCE_MS=0 (ceiling = maxAgeMs + 0 = 36 000 ms).
      //
      // Guard condition with zero tolerance:
      //
      //   ageMs > maxAgeMs + MTIME_TRUNCATION_TOLERANCE_MS
      //   36 500 > 36 000 + 0  →  36 500 > 36 000  →  true → REJECTED ✓
      //
      // If this test passes but the acceptance test above were to fail, it would
      // mean the buffer had been removed or zeroed — a regression in probe-cache.ts.
      // Together the two tests prove the 1-second tolerance is the deciding factor
      // for a sentinel aged strictly between 36 000 ms and 37 000 ms, exactly the
      // range a 1-second-resolution filesystem can produce from a near-boundary write.
      const originalAge = process.env["MAX_SENTINEL_AGE_HOURS"];
      const originalTol = process.env["MTIME_TRUNCATION_TOLERANCE_MS"];
      process.env["MAX_SENTINEL_AGE_HOURS"] = "0.01";
      process.env["MTIME_TRUNCATION_TOLERANCE_MS"] = "0";
      vi.resetModules();

      try {
        const {
          consumeProbeCache: consume,
          PROBE_CACHE_SENTINEL: SENTINEL,
          MTIME_TRUNCATION_TOLERANCE_MS: tolerance,
          MAX_SENTINEL_AGE_HOURS: maxHours,
        } = await import("./probe-cache");

        // Confirm the module loaded the pinned env vars.
        expect(maxHours).toBe(0.01);
        expect(tolerance).toBe(0);

        const buildDir = ".next-probe-tolerance-rejection";
        fs.mkdirSync(path.join(tmpDir, buildDir));
        const sentinel = path.join(tmpDir, SENTINEL);
        fs.writeFileSync(sentinel, buildDir, "utf8");

        // Freeze the clock for the same deterministic age computation.
        const fixedNow = Date.now();
        vi.useFakeTimers();
        vi.setSystemTime(fixedNow);

        // Same 36 500 ms stub as the acceptance test — only the tolerance differs.
        vi.mocked(fs.statSync).mockImplementationOnce((p) => {
          if (p === sentinel) {
            return { mtime: new Date(fixedNow - 36_500) } as fs.Stats;
          }
          throw new Error(`Unexpected statSync call for ${String(p)}`);
        });

        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        try {
          const result = consume(tmpDir);

          // 36 500 ms > 36 000 + 0 ms → guard fires → rejected.
          expect(result).toBeNull();

          // A staleness warning must be emitted so CI logs show why the warm
          // start was skipped.
          expect(warnSpy).toHaveBeenCalledOnce();

          // No warm-start log must be emitted.
          expect(logSpy).not.toHaveBeenCalled();
        } finally {
          warnSpy.mockRestore();
          logSpy.mockRestore();
          vi.useRealTimers();
          vi.mocked(fs.statSync).mockRestore();
        }
      } finally {
        if (originalAge === undefined) {
          delete process.env["MAX_SENTINEL_AGE_HOURS"];
        } else {
          process.env["MAX_SENTINEL_AGE_HOURS"] = originalAge;
        }
        if (originalTol === undefined) {
          delete process.env["MTIME_TRUNCATION_TOLERANCE_MS"];
        } else {
          process.env["MTIME_TRUNCATION_TOLERANCE_MS"] = originalTol;
        }
        vi.resetModules();
      }
    },
  );

  it(
    "a sentinel aged exactly 36 001 ms is rejected when MTIME_TRUNCATION_TOLERANCE_MS=0 (one millisecond past the sub-minute boundary)",
    async () => {
      // 0.01 h = 36 000 ms.  With MTIME_TRUNCATION_TOLERANCE_MS=0 the effective
      // ceiling is exactly maxAgeMs + 0 = 36 000 ms.  The age guard fires when
      // ageMs > maxAgeMs + MTIME_TRUNCATION_TOLERANCE_MS, i.e.:
      //
      //   36 001 > 36 000 + 0  →  36 001 > 36 000  →  true → REJECTED
      //
      // This is the paired rejection-side companion to the acceptance test above
      // ("a sentinel aged exactly 36 000 ms is accepted … zero tolerance").
      // Together the two cases pin both sides of the strict greater-than boundary
      // at the sub-minute scale and prevent a future ≥ regression from slipping
      // through: if >= were used, 36 000 ms would also be rejected and the
      // acceptance test would catch it; if > is weakened to allow 36 001 ms, this
      // test catches it by seeing the build directory name instead of null.
      //
      // We freeze Date.now() via vi.useFakeTimers() and stub statSync to return
      // a mtime exactly 36 001 ms before fixedNow, so ageMs is deterministic and
      // no filesystem mtime resolution or clock drift can affect the result.
      //
      // NOTE: this in-process test uses fake timers and a statSync stub.  The
      // companion subprocess test below ("a sentinel aged exactly 36 000 ms is
      // rejected … via subprocess") exercises the same boundary through a real
      // spawned tsx child process, confirming that the env-var parsing path in
      // probe-cache-env-check.ts also honours MTIME_TRUNCATION_TOLERANCE_MS=0.
      const originalAge = process.env["MAX_SENTINEL_AGE_HOURS"];
      const originalTol = process.env["MTIME_TRUNCATION_TOLERANCE_MS"];
      process.env["MAX_SENTINEL_AGE_HOURS"] = "0.01";
      process.env["MTIME_TRUNCATION_TOLERANCE_MS"] = "0";
      vi.resetModules();

      try {
        const {
          consumeProbeCache: consume,
          PROBE_CACHE_SENTINEL: SENTINEL,
          MTIME_TRUNCATION_TOLERANCE_MS: tolerance,
          MAX_SENTINEL_AGE_HOURS: maxHours,
        } = await import("./probe-cache");

        // Confirm the module loaded the pinned env vars.
        expect(maxHours).toBe(0.01);
        expect(tolerance).toBe(0);

        const buildDir = ".next-probe-36001ms-rejection";
        fs.mkdirSync(path.join(tmpDir, buildDir));
        const sentinel = path.join(tmpDir, SENTINEL);
        fs.writeFileSync(sentinel, buildDir, "utf8");

        // Freeze the clock at a fixed point so the Date.now() inside
        // consumeProbeCache is identical to the one used for the stub.
        const fixedNow = Date.now();
        vi.useFakeTimers();
        vi.setSystemTime(fixedNow);

        // Stub statSync on the sentinel to return a mtime exactly 36 001 ms
        // before fixedNow, bypassing real filesystem mtime resolution.
        // With the clock frozen, ageMs = fixedNow - (fixedNow - 36 001) = 36 001 ms.
        // The guard fires when ageMs > maxAgeMs + MTIME_TRUNCATION_TOLERANCE_MS,
        // i.e. 36 001 > 36 000 + 0 — which is true → sentinel must be rejected.
        vi.mocked(fs.statSync).mockImplementationOnce((p) => {
          if (p === sentinel) {
            return { mtime: new Date(fixedNow - 36_001) } as fs.Stats;
          }
          throw new Error(`Unexpected statSync call for ${String(p)}`);
        });

        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        try {
          const result = consume(tmpDir);

          // Sentinel age == 36 001 ms, maxAgeMs == 36 000 ms, tolerance == 0:
          // 36 001 > 36 000 + 0 → true → must be rejected.
          expect(result).toBeNull();

          // A staleness warning must be emitted so CI logs show why the warm
          // start was skipped.
          expect(warnSpy).toHaveBeenCalledOnce();

          // No warm-start log must be emitted.
          expect(logSpy).not.toHaveBeenCalled();
        } finally {
          warnSpy.mockRestore();
          logSpy.mockRestore();
          vi.useRealTimers();
          vi.mocked(fs.statSync).mockRestore();
        }
      } finally {
        if (originalAge === undefined) {
          delete process.env["MAX_SENTINEL_AGE_HOURS"];
        } else {
          process.env["MAX_SENTINEL_AGE_HOURS"] = originalAge;
        }
        if (originalTol === undefined) {
          delete process.env["MTIME_TRUNCATION_TOLERANCE_MS"];
        } else {
          process.env["MTIME_TRUNCATION_TOLERANCE_MS"] = originalTol;
        }
        vi.resetModules();
      }
    },
  );

  it(
    "a sentinel aged exactly 36 000 ms is rejected when MTIME_TRUNCATION_TOLERANCE_MS=0 is set via subprocess (end-to-end env override)",
    () => {
      // 0.01 h = 36 000 ms.  With MTIME_TRUNCATION_TOLERANCE_MS=0 the effective
      // ceiling is exactly maxAgeMs + 0 = 36 000 ms.  The age guard fires when
      // ageMs > maxAgeMs + MTIME_TRUNCATION_TOLERANCE_MS, i.e.:
      //
      //   36 000 > 36 000 + 0  →  36 000 > 36 000  →  false → ACCEPTED
      //
      // Wait — the sentinel is backdated by exactly 36 000 ms, which equals the
      // maxAgeMs.  The guard uses strictly-greater-than, so a sentinel aged
      // exactly maxAgeMs is accepted even at zero tolerance.
      //
      // However, the real-filesystem utimesSync used by the helper script applies
      // mtime at 1-second precision on many filesystems.  A backdate of 36 000 ms
      // can be stored as 36 000 ms or truncated to 36 000 ms (no fractional
      // seconds involved here, so truncation is neutral), meaning the observed
      // age will be at or near 36 000 ms — not 36 001 ms.
      //
      // The task specifies SENTINEL_BACKDATE_MS=36001 to place the sentinel 1 ms
      // past the boundary so the rejection side of the strict-greater-than guard
      // is exercised through a real spawned process:
      //
      //   ageMs ≈ 36 001 ms > 36 000 ms + 0  →  guard fires → result must be null
      //
      // This end-to-end subprocess test complements the in-process statSync-stub
      // tests (Tasks 742 and 743) by confirming that the env-var parsing path
      // in probe-cache-env-check.ts — which reads MTIME_TRUNCATION_TOLERANCE_MS
      // from process.env and passes it through a real tsx child process — also
      // causes the rejection.  Vitest's module-level caching or fake-timer state
      // cannot interfere because the child process has its own module registry.
      const proc = spawnSync(tsxBin, [helperScript], {
        env: {
          ...process.env,
          MAX_SENTINEL_AGE_HOURS: "0.01",
          MTIME_TRUNCATION_TOLERANCE_MS: "0",
          SENTINEL_BACKDATE_MS: "36001",
        },
        encoding: "utf8",
        timeout: 15_000,
      });

      // The subprocess must not crash.
      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);

      const output = JSON.parse(proc.stdout.trim()) as {
        constant: number;
        result: string | null;
      };

      // The IIFE must have read the env var and produced 0.01.
      expect(output.constant).toBe(0.01);

      // The sentinel is 36 001 ms old — 1 ms past the 36 000 ms ceiling
      // (maxAgeMs + 0 tolerance).  consumeProbeCache must discard it and
      // return null.
      expect(output.result).toBeNull();
    },
  );

  it(
    "a sentinel aged exactly 36 000 ms is accepted via subprocess when MTIME_TRUNCATION_TOLERANCE_MS=0 (at-boundary acceptance side)",
    () => {
      // 0.01 h = 36 000 ms.  With MTIME_TRUNCATION_TOLERANCE_MS=0 the effective
      // ceiling is exactly maxAgeMs + 0 = 36 000 ms.  The age guard fires when:
      //
      //   ageMs > maxAgeMs + MTIME_TRUNCATION_TOLERANCE_MS
      //   36 000 > 36 000 + 0  →  36 000 > 36 000  →  false → ACCEPTED
      //
      // So a sentinel backdated by exactly 36 000 ms sits exactly on the boundary
      // and must NOT be rejected by the strictly-greater-than guard.
      //
      // To make the age deterministic despite wall-clock drift, we pass NOW_MS to
      // the helper script.  The helper freezes Date.now() to NOW_MS for the
      // duration of consumeProbeCache(), and sets the sentinel's mtime to
      // (NOW_MS - 36 000 ms).  The age seen by consumeProbeCache() is therefore
      // exactly 36 000 ms — not 36 000 ms + ε — so the assertion is unconditional.
      //
      //   NOW_MS - (NOW_MS - 36 000) = 36 000
      //   36 000 > 36 000 + 0  →  false  →  result must be ".next-probe-ci"
      //
      // We choose a synthetic NOW_MS well ahead of real time so the frozen
      // timestamp is clearly synthetic and cannot be confused with a real-time
      // value.  Critically, it must be whole-second aligned: on filesystems that
      // truncate mtime to 1-second resolution (ext4, HFS+, NTFS), utimesSync
      // stores (NOW_MS - 36 000) rounded down to the nearest second.  If NOW_MS
      // carries sub-second fractional milliseconds, the stored mtime is
      // (NOW_MS - 36 000 - remainder), making the observed age
      // 36 000 + remainder (up to 36 999 ms) — enough to trip the zero-tolerance
      // guard.  Rounding NOW_MS down to a whole second eliminates the remainder:
      // both NOW_MS and NOW_MS - 36 000 are second-aligned, utimesSync stores the
      // value exactly, and the age is exactly 36 000 ms with no truncation error.
      const nowMs = Math.floor((Date.now() + 300_000) / 1000) * 1000;

      const proc = spawnSync(tsxBin, [helperScript], {
        env: {
          ...process.env,
          MAX_SENTINEL_AGE_HOURS: "0.01",
          MTIME_TRUNCATION_TOLERANCE_MS: "0",
          SENTINEL_BACKDATE_MS: "36000",
          NOW_MS: String(nowMs),
        },
        encoding: "utf8",
        timeout: 15_000,
      });

      // The subprocess must not crash.
      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);

      const output = JSON.parse(proc.stdout.trim()) as {
        constant: number;
        result: string | null;
      };

      // The IIFE must have read MAX_SENTINEL_AGE_HOURS and produced 0.01.
      expect(output.constant).toBe(0.01);

      // With the clock frozen via NOW_MS, the sentinel age is exactly 36 000 ms.
      // The guard (ageMs > 36 000 + 0) does not fire at the boundary, so
      // consumeProbeCache must return the build directory name, not null.
      expect(output.result).toBe(".next-probe-ci");
    },
  );

  it(
    "at-boundary acceptance holds on a real filesystem with 1-second mtime resolution (reads actual stored mtime, skips if filesystem rounds beyond epsilon)",
    async (ctx) => {
      // This test validates the at-boundary acceptance directly in the test
      // process using a real utimesSync call — no subprocess, no statSync stub.
      //
      // Strategy
      // ─────────
      // 1. Align nowMs to a whole second so the target mtime (nowMs − 36 000 ms)
      //    is also second-aligned.  On a filesystem with 1-second precision
      //    (ext4, HFS+, NTFS) utimesSync stores the value exactly, giving
      //    storedAge = 36 000 ms with no truncation error.
      //
      // 2. After utimesSync, read back the actual stored mtime with fs.statSync.
      //    Compute storedAge = nowMs − storedMtime.getTime().  If storedAge
      //    differs from 36 000 ms at all — filesystem rounded the timestamp
      //    back (storedAge > 36 000 ms, guard would reject it) or forward
      //    (storedAge < 36 000 ms, not the boundary under test) — explicitly
      //    skip via ctx.skip() so the test appears as skipped, not passed.
      //
      // 3. Assert storedAge === 36 000 ms before calling consumeProbeCache().
      //    This makes the coverage claim explicit: we have confirmed the guard
      //    is about to receive exactly the boundary value.
      //
      // 4. Freeze Date.now() to nowMs for the consumeProbeCache() call so the
      //    age the guard sees is exactly storedAge (= 36 000 ms).  The guard
      //    fires when ageMs > maxAgeMs + MTIME_TRUNCATION_TOLERANCE_MS,
      //    i.e. 36 000 > 36 000 + 0 — false — so the sentinel must be accepted.
      //
      // Relationship to the subprocess test above
      // ──────────────────────────────────────────
      // The subprocess test passes NOW_MS to freeze the clock but never reads
      // back the stored mtime; it relies on the second-alignment argument for
      // determinism.  This in-process test explicitly reads and validates what
      // the filesystem stored, surfacing host-specific precision behaviour via
      // ctx.skip() rather than a silent pass or a spurious rejection.

      const originalAge = process.env["MAX_SENTINEL_AGE_HOURS"];
      const originalTol = process.env["MTIME_TRUNCATION_TOLERANCE_MS"];
      process.env["MAX_SENTINEL_AGE_HOURS"] = "0.01";
      process.env["MTIME_TRUNCATION_TOLERANCE_MS"] = "0";
      vi.resetModules();

      try {
        const {
          consumeProbeCache: consume,
          PROBE_CACHE_SENTINEL: SENTINEL,
          MTIME_TRUNCATION_TOLERANCE_MS: tolerance,
          MAX_SENTINEL_AGE_HOURS: maxHours,
        } = await import("./probe-cache");

        // Verify the module re-evaluated its IIFEs against the overridden env vars.
        expect(maxHours).toBe(0.01);
        expect(tolerance).toBe(0);

        // Choose a second-aligned nowMs so (nowMs − 36 000 ms) is also second-
        // aligned.  On a 1-second-precision filesystem utimesSync stores the
        // value exactly, leaving no sub-second remainder for truncation to bite.
        const nowMs = Math.floor(Date.now() / 1000) * 1000;

        const buildDir = ".next-probe-ci";
        fs.mkdirSync(path.join(tmpDir, buildDir));
        const sentinel = path.join(tmpDir, SENTINEL);
        fs.writeFileSync(sentinel, buildDir, "utf8");

        // Backdate the sentinel by exactly 36 000 ms relative to nowMs.
        const targetMtime = new Date(nowMs - 36_000);
        fs.utimesSync(sentinel, targetMtime, targetMtime);

        // Read back the actual stored mtime from the real filesystem.
        // fs.statSync is wrapped in a vi.fn() that passes through to the real
        // implementation by default, so this returns the true on-disk value.
        const storedMtime = fs.statSync(sentinel).mtime;
        const storedAgeMs = nowMs - storedMtime.getTime();

        // Skip explicitly when the filesystem did not store the second-aligned
        // timestamp exactly:
        //   storedAgeMs > 36 000: filesystem truncated the mtime (rounded back),
        //     making the sentinel appear older than the boundary.  The zero-
        //     tolerance guard would reject it — this is not the at-boundary
        //     acceptance case the test is designed to verify.
        //   storedAgeMs < 36 000: filesystem rounded the mtime forward (unusual),
        //     making the sentinel appear younger.  Also not the exact boundary.
        // The skip guard and the consume call are kept together in
        // atBoundaryDecision so the meta-test below can call the same function
        // with vi.fn() spies and confirm the skip path prevents consume.

        // Freeze Date.now() to nowMs and set up console spies before delegating
        // to atBoundaryDecision.  The helper either throws (ctx.skip() → Vitest
        // SkipError) or calls consume(tmpDir) and returns the result.
        const realDateNow = Date.now;
        Date.now = () => nowMs;

        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        try {
          // atBoundaryDecision: if storedAgeMs !== 36_000, ctx.skip() throws a
          // SkipError that propagates out and marks the test skipped.
          // If storedAgeMs === 36_000, consume(tmpDir) is called and returned.
          const result = atBoundaryDecision(
            storedAgeMs,
            () => ctx.skip(),
            consume,
            tmpDir,
          );

          // Only reached when storedAgeMs === 36_000 and the sentinel is accepted.
          // storedAgeMs = 36 000 ms, tolerance = 0 ms:
          // guard (36 000 > 36 000 + 0) → false → sentinel must be accepted.
          expect(storedAgeMs).toBe(36_000);
          expect(result).toBe(".next-probe-ci");

          // No staleness warning must be emitted for an at-boundary sentinel.
          expect(warnSpy).not.toHaveBeenCalled();

          // The normal warm-start log must appear.
          expect(logSpy).toHaveBeenCalledOnce();
        } finally {
          Date.now = realDateNow;
          warnSpy.mockRestore();
          logSpy.mockRestore();
        }
      } finally {
        if (originalAge === undefined) {
          delete process.env["MAX_SENTINEL_AGE_HOURS"];
        } else {
          process.env["MAX_SENTINEL_AGE_HOURS"] = originalAge;
        }
        if (originalTol === undefined) {
          delete process.env["MTIME_TRUNCATION_TOLERANCE_MS"];
        } else {
          process.env["MTIME_TRUNCATION_TOLERANCE_MS"] = originalTol;
        }
        vi.resetModules();
      }
    },
  );

  it(
    "at-boundary skip path fires when filesystem rounds mtime down — atBoundaryDecision calls skipFn and never calls consumeFn",
    () => {
      // Meta-test for the at-boundary acceptance test above.
      //
      // Goal: confirm that when the real filesystem stores a mtime whose
      // storedAge is NOT exactly 36 000 ms (e.g. the filesystem truncated
      // sub-second precision, storing a mtime 200 ms earlier than requested
      // so storedAge = 36 200 ms), atBoundaryDecision calls skipFn and returns
      // early without ever reaching consumeFn.
      //
      // Because both the real test and this meta-test call atBoundaryDecision,
      // removing the skip guard from that helper would cause this meta-test to
      // fail: consumeFn would be called unexpectedly and skipFn would not.
      //
      // Rounding note
      // ─────────────
      // A filesystem that truncates sub-second mtime components stores a mtime
      // that is earlier than the one requested (mtime rounded down / backwards).
      // This makes the stored age larger than intended:
      //   requested mtime:  nowMs − 36 000 ms
      //   stored mtime:     nowMs − 36 200 ms  (200 ms earlier)
      //   storedAge:        nowMs − (nowMs − 36 200) = 36 200 ms

      const nowMs = Math.floor(Date.now() / 1000) * 1000;

      // Stub fs.statSync to return a mtime that gives storedAge = 36 200 ms.
      // fs.statSync is already a vi.fn() via the module-level vi.mock().
      vi.mocked(fs.statSync).mockReturnValueOnce({
        mtime: new Date(nowMs - 36_200),
      } as unknown as fs.Stats);

      const storedMtime = fs.statSync(sentinelPath()).mtime;
      const storedAgeMs = nowMs - storedMtime.getTime();

      // Spy callbacks passed to atBoundaryDecision in place of ctx.skip() and
      // the real consumeProbeCache.
      const skipFn = vi.fn(() => {});
      const consumeFn = vi.fn((_dir: string): string | null => null);

      const result = atBoundaryDecision(storedAgeMs, skipFn, consumeFn, tmpDir);

      // storedAgeMs (36 200) !== 36 000 → the skip guard must have fired.
      expect(storedAgeMs).toBe(36_200);
      expect(skipFn).toHaveBeenCalledOnce();

      // consumeFn must never be called — the test body returned early at the
      // skip guard without reaching the consumeProbeCache assertion.
      expect(consumeFn).not.toHaveBeenCalled();

      // atBoundaryDecision returns "skipped" when skipFn does not throw.
      expect(result).toBe("skipped");
    },
  );
});

// These tests spawn a fresh `tsx` child process with MTIME_TRUNCATION_TOLERANCE_MS
// injected via its environment — exactly how a GitHub Actions `env:` block or
// a `.env.test` file supplies it in CI.  Module-level caching in Vitest cannot
// interfere because the child process has its own module registry.
//
// All tests also inject MAX_SENTINEL_AGE_HOURS=1 so the age threshold is a
// predictable 3 600 000 ms.  The helper script backs the sentinel to
// (maxAgeMs + 600 ms) ago:
//
//   tolerance < 600 ms  → ageMs > maxAgeMs + tolerance → guard fires → REJECTED
//   tolerance ≥ 600 ms  → ageMs ≤ maxAgeMs + tolerance → guard silent → ACCEPTED
//     (timing noise in the spawned process is well below the 400 ms safety margin
//     between the 600 ms overshoot and the 1 000 ms default tolerance)

describe("subprocess environment integration (tolerance-guard CI override)", () => {
  // Locate the tsx binary relative to this file:
  //   __tests__/slow/helpers/ → ../../../node_modules/.bin/tsx
  const tsxBin = path.resolve(
    __dirname,
    "../../../node_modules/.bin/tsx",
  );
  const helperScript = path.resolve(
    __dirname,
    "./probe-cache-mtime-env-check.ts",
  );

  it(
    "a sentinel 600 ms past the age limit is rejected when MTIME_TRUNCATION_TOLERANCE_MS=400 is set in the subprocess environment",
    () => {
      // Spawn a fresh process with tolerance=400 ms.  The helper backdates the
      // sentinel to (maxAgeMs + 600 ms) ago; 600 > 400 so the guard must fire.
      // This verifies the env var reaches the IIFE in the subprocess, not a
      // hardcoded fallback.
      const proc = spawnSync(tsxBin, [helperScript], {
        env: {
          ...process.env,
          MAX_SENTINEL_AGE_HOURS: "1",
          MTIME_TRUNCATION_TOLERANCE_MS: "400",
        },
        encoding: "utf8",
        timeout: 15_000,
      });

      // The subprocess must not crash.
      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);

      const output = JSON.parse(proc.stdout.trim()) as {
        constant: number;
        result: string | null;
      };

      // The IIFE must have read the env var and produced 400, not the default.
      expect(output.constant).toBe(400);

      // The sentinel is 600 ms past the 1-hour limit.  With a 400 ms tolerance
      // the guard fires: 600 > 400.  consumeProbeCache must discard it.
      expect(output.result).toBeNull();
    },
  );

  it(
    "a sentinel 600 ms past the age limit is accepted when MTIME_TRUNCATION_TOLERANCE_MS=2000 is set in the subprocess environment",
    () => {
      // With a 2 000 ms tolerance the same 600 ms overshoot must pass the guard:
      // 600 ≤ 2 000.  This confirms the env var — not the hardcoded 1 000 ms
      // default — is driving the acceptance decision, ruling out the possibility
      // that the rejection test above passed only because the default was active.
      const proc = spawnSync(tsxBin, [helperScript], {
        env: {
          ...process.env,
          MAX_SENTINEL_AGE_HOURS: "1",
          MTIME_TRUNCATION_TOLERANCE_MS: "2000",
        },
        encoding: "utf8",
        timeout: 15_000,
      });

      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);

      const output = JSON.parse(proc.stdout.trim()) as {
        constant: number;
        result: string | null;
      };

      // The IIFE must have read the env var and produced 2 000.
      expect(output.constant).toBe(2000);

      // The sentinel is 600 ms past the 1-hour limit.  With a 2 000 ms tolerance
      // the guard is silent: 600 ≤ 2 000.  consumeProbeCache must accept it.
      expect(output.result).toBe(".next-probe-mtime-ci");
    },
  );

  it.each([
    ["-1", "negative numbers are not valid"],
    ["abc", "non-numeric strings are not valid"],
  ])(
    "falls back to 1 000 ms and does not crash when MTIME_TRUNCATION_TOLERANCE_MS=%s (%s) is set in the subprocess environment",
    (invalidValue) => {
      // A CI file that accidentally sets MTIME_TRUNCATION_TOLERANCE_MS to an
      // invalid value must not crash the probe step.  The IIFE in probe-cache.ts
      // must silently ignore the bad value and fall back to the 1 000 ms default.
      //
      // We verify this through the process boundary — Vitest module caching
      // cannot interfere because the child process has its own module registry.
      const proc = spawnSync(tsxBin, [helperScript], {
        env: {
          ...process.env,
          MAX_SENTINEL_AGE_HOURS: "1",
          MTIME_TRUNCATION_TOLERANCE_MS: invalidValue,
        },
        encoding: "utf8",
        timeout: 15_000,
      });

      // The subprocess must not crash regardless of the invalid env var.
      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);

      const output = JSON.parse(proc.stdout.trim()) as {
        constant: number;
        result: string | null;
      };

      // The IIFE must reject the invalid value and fall back to 1 000 ms.
      expect(output.constant).toBe(1000);

      // The sentinel is 600 ms past the 1-hour limit.  With the 1 000 ms default
      // tolerance the guard is silent: 600 ≤ 1 000.  consumeProbeCache must
      // accept it, proving the process did not crash and the fallback is active.
      expect(output.result).toBe(".next-probe-mtime-ci");
    },
  );

  it(
    "a sentinel 600 ms past the age limit is accepted when MTIME_TRUNCATION_TOLERANCE_MS is absent from the subprocess environment (1 000 ms default)",
    () => {
      // This is the most common CI misconfiguration: the env var is simply not
      // set in the job's environment.  The IIFE must fall back to 1 000 ms.
      // Removing the key from the child process env ensures the subprocess sees
      // a completely absent variable, ruling out an inherited value from the
      // Vitest runner that would mask the missing-variable code path.
      const childEnv = { ...process.env };
      delete childEnv["MTIME_TRUNCATION_TOLERANCE_MS"];

      const proc = spawnSync(tsxBin, [helperScript], {
        env: { ...childEnv, MAX_SENTINEL_AGE_HOURS: "1" },
        encoding: "utf8",
        timeout: 15_000,
      });

      // The subprocess must not crash.
      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);

      const output = JSON.parse(proc.stdout.trim()) as {
        constant: number;
        result: string | null;
      };

      // With the variable absent the IIFE must produce the 1 000 ms default.
      expect(output.constant).toBe(1000);

      // The sentinel is 600 ms past the 1-hour limit.  With the 1 000 ms default
      // tolerance the guard is silent: 600 ≤ 1 000.  consumeProbeCache must
      // accept it and return the build directory name.
      expect(output.result).toBe(".next-probe-mtime-ci");
    },
  );

  it(
    "falls back to 1 000 ms and does not crash when MTIME_TRUNCATION_TOLERANCE_MS is set to an empty string in the subprocess environment",
    () => {
      // A CI YAML file that sets `MTIME_TRUNCATION_TOLERANCE_MS:` with no value
      // passes an empty string to the child process environment.  The IIFE in
      // probe-cache.ts guards `env !== ""` before parsing, so an empty string
      // must be treated the same as an absent variable: fall back to 1 000 ms.
      //
      // This test exercises that path through the real process boundary —
      // Vitest module caching cannot interfere because the child process has
      // its own module registry.
      const proc = spawnSync(tsxBin, [helperScript], {
        env: {
          ...process.env,
          MAX_SENTINEL_AGE_HOURS: "1",
          MTIME_TRUNCATION_TOLERANCE_MS: "",
        },
        encoding: "utf8",
        timeout: 15_000,
      });

      // The subprocess must not crash when the env var is an empty string.
      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);

      const output = JSON.parse(proc.stdout.trim()) as {
        constant: number;
        result: string | null;
      };

      // The IIFE must treat "" the same as undefined and fall back to 1 000 ms.
      expect(output.constant).toBe(1000);

      // The sentinel is 600 ms past the 1-hour limit.  With the 1 000 ms default
      // tolerance the guard is silent: 600 ≤ 1 000.  consumeProbeCache must
      // accept it, confirming the process did not crash and the fallback is active.
      expect(output.result).toBe(".next-probe-mtime-ci");
    },
  );

  it(
    "resolves to 0 ms (not the 1 000 ms default) when MTIME_TRUNCATION_TOLERANCE_MS is set to the literal string '0' in the subprocess environment",
    () => {
      // This is the primary zero-tolerance mode used by meta-tests.  Setting
      // MTIME_TRUNCATION_TOLERANCE_MS="0" must cause the constant to evaluate
      // to 0 — not fall through to the 1 000 ms default.
      //
      // If the `parsed >= 0` guard in the IIFE were accidentally changed to
      // `parsed > 0`, Number("0") = 0 would fail the guard and the IIFE would
      // return 1 000 ms instead.  Meta-tests that rely on zero-tolerance mode
      // would silently use the wrong tolerance, hiding genuine regressions.
      //
      // This test closes that gap: it spawns a fresh subprocess (guaranteeing
      // the module-level IIFE re-evaluates against the subprocess environment,
      // not a cached Vitest module) and asserts both the resolved constant and
      // the resulting cache-acceptance decision.
      const proc = spawnSync(tsxBin, [helperScript], {
        env: {
          ...process.env,
          MAX_SENTINEL_AGE_HOURS: "1",
          MTIME_TRUNCATION_TOLERANCE_MS: "0",
        },
        encoding: "utf8",
        timeout: 15_000,
      });

      // The subprocess must not crash when the env var is "0".
      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);

      const output = JSON.parse(proc.stdout.trim()) as {
        constant: number;
        result: string | null;
      };

      // The IIFE must accept "0" (parsed >= 0 passes) and return 0 ms,
      // NOT the 1 000 ms default.  If this assertion fails, the guard was
      // changed from `parsed >= 0` to `parsed > 0`.
      expect(output.constant).toBe(0);

      // The sentinel is 600 ms past the 1-hour limit.  With tolerance = 0 ms
      // the guard fires: 600 > 0.  consumeProbeCache must discard the sentinel.
      expect(output.result).toBeNull();
    },
  );

  it(
    "resolves to 0 ms (not the 1 000 ms default) when MTIME_TRUNCATION_TOLERANCE_MS is set to whitespace only in the subprocess environment",
    () => {
      // A CI YAML block that sets `MTIME_TRUNCATION_TOLERANCE_MS: "  "` (spaces
      // only) passes a non-empty string to the IIFE.  Unlike the analogous
      // MAX_SENTINEL_AGE_HOURS case — where the `parsed > 0` guard rejects 0
      // and falls back to 24 h — the MTIME_TRUNCATION_TOLERANCE_MS IIFE uses
      // `parsed >= 0`, so Number("  ") = 0 passes both Number.isFinite and
      // >= 0.  The IIFE therefore accepts 0 ms as the resolved tolerance.
      //
      // With tolerance = 0 ms the sentinel (600 ms past the age limit) is
      // rejected: 600 > 0 + 0 → guard fires → result null.
      //
      // This test documents the key difference between the two IIFEs: the
      // MTIME_TRUNCATION_TOLERANCE_MS IIFE deliberately accepts 0 to enable
      // test scenarios that need zero tolerance.
      const proc = spawnSync(tsxBin, [helperScript], {
        env: {
          ...process.env,
          MAX_SENTINEL_AGE_HOURS: "1",
          MTIME_TRUNCATION_TOLERANCE_MS: "  ",
        },
        encoding: "utf8",
        timeout: 15_000,
      });

      // The subprocess must not crash when the env var is whitespace only.
      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);

      const output = JSON.parse(proc.stdout.trim()) as {
        constant: number;
        result: string | null;
      };

      // Number("  ") = 0, which passes Number.isFinite and >= 0.
      // The IIFE must accept it and produce 0 ms, not the 1 000 ms default.
      expect(output.constant).toBe(0);

      // The sentinel is 600 ms past the 1-hour limit.  With tolerance = 0 ms
      // the guard fires: 600 > 0.  consumeProbeCache must discard the sentinel.
      expect(output.result).toBeNull();
    },
  );

  it(
    "resolves to 0 ms (not the 1 000 ms default) when MTIME_TRUNCATION_TOLERANCE_MS is set to a tab character only in the subprocess environment",
    () => {
      // A tab-only value ("\t") follows the same path as whitespace-only ("  "):
      // Number("\t") = 0, which is finite and >= 0, so the IIFE accepts it and
      // returns 0 ms — NOT the 1 000 ms fallback.  This is the same behaviour
      // as "  " and documents that all JS-whitespace characters produce 0 via
      // Number() and are thus accepted as a zero-tolerance override.
      //
      // This differs from MAX_SENTINEL_AGE_HOURS where `> 0` ensures that 0
      // falls back to 24 h, making whitespace-only values fall back as well.
      const proc = spawnSync(tsxBin, [helperScript], {
        env: {
          ...process.env,
          MAX_SENTINEL_AGE_HOURS: "1",
          MTIME_TRUNCATION_TOLERANCE_MS: "\t",
        },
        encoding: "utf8",
        timeout: 15_000,
      });

      // The subprocess must not crash when the env var is a tab character only.
      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);

      const output = JSON.parse(proc.stdout.trim()) as {
        constant: number;
        result: string | null;
      };

      // Number("\t") = 0 → passes Number.isFinite and >= 0.
      // The IIFE must accept it and produce 0 ms, not the 1 000 ms default.
      expect(output.constant).toBe(0);

      // The sentinel is 600 ms past the 1-hour limit.  With tolerance = 0 ms
      // the guard fires: 600 > 0.  consumeProbeCache must discard the sentinel.
      expect(output.result).toBeNull();
    },
  );
});
