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

// ── Tests ─────────────────────────────────────────────────────────────────────

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
});
