/**
 * Tests that PLATFORM_FEE_PERCENT is validated at module load time.
 * Each case resets the module registry so the IIFE validation re-runs.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  delete process.env.PLATFORM_FEE_PERCENT;
});

describe("PLATFORM_FEE_PERCENT startup guard", () => {
  it("throws a clear error when the value is not a number", async () => {
    process.env.PLATFORM_FEE_PERCENT = "notanumber";
    await expect(import("@/lib/stripe")).rejects.toThrow(
      /Invalid PLATFORM_FEE_PERCENT "notanumber"/,
    );
  });

  it("throws a clear error for an empty string", async () => {
    process.env.PLATFORM_FEE_PERCENT = "";
    await expect(import("@/lib/stripe")).rejects.toThrow(
      /Invalid PLATFORM_FEE_PERCENT ""/,
    );
  });

  it("throws when the value is negative", async () => {
    process.env.PLATFORM_FEE_PERCENT = "-1";
    await expect(import("@/lib/stripe")).rejects.toThrow(
      /Invalid PLATFORM_FEE_PERCENT "-1"/,
    );
  });

  it("throws when the value exceeds 100", async () => {
    process.env.PLATFORM_FEE_PERCENT = "101";
    await expect(import("@/lib/stripe")).rejects.toThrow(
      /Invalid PLATFORM_FEE_PERCENT "101"/,
    );
  });

  it("throws for Infinity", async () => {
    process.env.PLATFORM_FEE_PERCENT = "Infinity";
    await expect(import("@/lib/stripe")).rejects.toThrow(
      /Invalid PLATFORM_FEE_PERCENT "Infinity"/,
    );
  });

  it("accepts 0 (platform takes nothing — deliberate)", async () => {
    process.env.PLATFORM_FEE_PERCENT = "0";
    const { PLATFORM_FEE_PERCENT, calcApplicationFee } = await import(
      "@/lib/stripe"
    );
    expect(PLATFORM_FEE_PERCENT).toBe(0);
    expect(calcApplicationFee(10_000)).toBe(0);
  });

  it("accepts 100 (platform takes entire amount — deliberate)", async () => {
    process.env.PLATFORM_FEE_PERCENT = "100";
    const { PLATFORM_FEE_PERCENT, calcApplicationFee } = await import(
      "@/lib/stripe"
    );
    expect(PLATFORM_FEE_PERCENT).toBe(100);
    expect(calcApplicationFee(10_000)).toBe(10_000);
  });

  it("accepts a decimal like 2.5", async () => {
    process.env.PLATFORM_FEE_PERCENT = "2.5";
    const { PLATFORM_FEE_PERCENT, calcApplicationFee } = await import(
      "@/lib/stripe"
    );
    expect(PLATFORM_FEE_PERCENT).toBe(2.5);
    expect(calcApplicationFee(10_000)).toBe(250);
  });

  it("defaults to 5 when the variable is unset", async () => {
    const { PLATFORM_FEE_PERCENT } = await import("@/lib/stripe");
    expect(PLATFORM_FEE_PERCENT).toBe(5);
  });
});
