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
  };
});

import {
  consumeProbeCache,
  PROBE_CACHE_SENTINEL,
  DEV_BUILD_DIR,
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
