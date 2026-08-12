/**
 * Task #735 — Confirm MTIME_TRUNCATION_TOLERANCE_MS=0 is accepted as an
 * explicit zero-tolerance override in CI.
 *
 * Context
 * ───────
 * `__tests__/slow/helpers/probe-cache.ts` exports `MTIME_TRUNCATION_TOLERANCE_MS`,
 * an IIFE-evaluated constant that parses the same-named environment variable:
 *
 *   export const MTIME_TRUNCATION_TOLERANCE_MS: number = (() => {
 *     const env = process.env["MTIME_TRUNCATION_TOLERANCE_MS"];
 *     if (env !== undefined && env !== "") {
 *       const parsed = Number(env);
 *       if (Number.isFinite(parsed) && parsed >= 0) return parsed;
 *     }
 *     return 1000;
 *   })();
 *
 * The guard `parsed >= 0` intentionally accepts the string `"0"` as a valid
 * explicit zero — removing the 1 000 ms tolerance buffer — so that CI tests
 * can verify the age guard rejects a sentinel that overshoots the maximum age
 * by any amount, without the buffer obscuring marginal cases.
 *
 * The `.github/workflows/mtime-tolerance-guard.yml` workflow enforces this
 * property statically (by checking the `>= 0` pattern in source), but that
 * guard is only a structural assertion — it does not confirm the runtime
 * behaviour.  This file adds runtime tests for the key env-parsing cases to
 * catch a regression where someone changes the guard to `> 0` (which would
 * make `"0"` fall through to the 1 000 ms default) or to `parsed > 0` (same).
 *
 * Technique
 * ─────────
 * The constant is an IIFE evaluated once at module load time.  To test with
 * different env values we call `vi.resetModules()` before each dynamic import
 * so the module re-evaluates its IIFE with the current env.
 *
 * What this test verifies
 * ───────────────────────
 *  1. MTIME_TRUNCATION_TOLERANCE_MS="0" → constant resolves to 0 (not 1000).
 *  2. MTIME_TRUNCATION_TOLERANCE_MS="500" → constant resolves to 500.
 *  3. MTIME_TRUNCATION_TOLERANCE_MS="" (empty string) → falls back to 1000.
 *  4. MTIME_TRUNCATION_TOLERANCE_MS unset → falls back to 1000.
 *  5. MTIME_TRUNCATION_TOLERANCE_MS="abc" (invalid) → falls back to 1000.
 *  6. MTIME_TRUNCATION_TOLERANCE_MS="-1" (negative) → falls back to 1000.
 *  7. MTIME_TRUNCATION_TOLERANCE_MS="0.5" (fractional) → 0.5 accepted.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

// Each test calls vi.resetModules() so the IIFE re-evaluates with the current env.
afterEach(() => {
  vi.resetModules();
  delete process.env["MTIME_TRUNCATION_TOLERANCE_MS"];
});

// Import path relative to this test file: __tests__/slow/helpers/probe-cache.ts
const MODULE_PATH = "./slow/helpers/probe-cache";

describe("MTIME_TRUNCATION_TOLERANCE_MS env resolution (Task #735)", () => {
  it('"0" is accepted as explicit zero-tolerance override (not treated as missing)', async () => {
    process.env["MTIME_TRUNCATION_TOLERANCE_MS"] = "0";
    vi.resetModules();
    const { MTIME_TRUNCATION_TOLERANCE_MS } = await import(MODULE_PATH);
    // Must be exactly 0, not the 1000 ms default.
    expect(MTIME_TRUNCATION_TOLERANCE_MS).toBe(0);
  });

  it('"0" does not fall back to the 1000 ms default', async () => {
    process.env["MTIME_TRUNCATION_TOLERANCE_MS"] = "0";
    vi.resetModules();
    const { MTIME_TRUNCATION_TOLERANCE_MS } = await import(MODULE_PATH);
    expect(MTIME_TRUNCATION_TOLERANCE_MS).not.toBe(1000);
  });

  it('"500" is accepted and resolves to 500', async () => {
    process.env["MTIME_TRUNCATION_TOLERANCE_MS"] = "500";
    vi.resetModules();
    const { MTIME_TRUNCATION_TOLERANCE_MS } = await import(MODULE_PATH);
    expect(MTIME_TRUNCATION_TOLERANCE_MS).toBe(500);
  });

  it('"0.5" (fractional zero-plus) is accepted and resolves to 0.5', async () => {
    process.env["MTIME_TRUNCATION_TOLERANCE_MS"] = "0.5";
    vi.resetModules();
    const { MTIME_TRUNCATION_TOLERANCE_MS } = await import(MODULE_PATH);
    expect(MTIME_TRUNCATION_TOLERANCE_MS).toBe(0.5);
  });

  it('empty string "" falls back to 1000', async () => {
    process.env["MTIME_TRUNCATION_TOLERANCE_MS"] = "";
    vi.resetModules();
    const { MTIME_TRUNCATION_TOLERANCE_MS } = await import(MODULE_PATH);
    expect(MTIME_TRUNCATION_TOLERANCE_MS).toBe(1000);
  });

  it("unset env falls back to 1000", async () => {
    delete process.env["MTIME_TRUNCATION_TOLERANCE_MS"];
    vi.resetModules();
    const { MTIME_TRUNCATION_TOLERANCE_MS } = await import(MODULE_PATH);
    expect(MTIME_TRUNCATION_TOLERANCE_MS).toBe(1000);
  });

  it('"abc" (non-numeric) falls back to 1000', async () => {
    process.env["MTIME_TRUNCATION_TOLERANCE_MS"] = "abc";
    vi.resetModules();
    const { MTIME_TRUNCATION_TOLERANCE_MS } = await import(MODULE_PATH);
    expect(MTIME_TRUNCATION_TOLERANCE_MS).toBe(1000);
  });

  it('"-1" (negative) falls back to 1000', async () => {
    process.env["MTIME_TRUNCATION_TOLERANCE_MS"] = "-1";
    vi.resetModules();
    const { MTIME_TRUNCATION_TOLERANCE_MS } = await import(MODULE_PATH);
    expect(MTIME_TRUNCATION_TOLERANCE_MS).toBe(1000);
  });

  it('"Infinity" falls back to 1000 (not a finite value)', async () => {
    process.env["MTIME_TRUNCATION_TOLERANCE_MS"] = "Infinity";
    vi.resetModules();
    const { MTIME_TRUNCATION_TOLERANCE_MS } = await import(MODULE_PATH);
    expect(MTIME_TRUNCATION_TOLERANCE_MS).toBe(1000);
  });
});
