import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { calcApplicationFee, PLATFORM_FEE_PERCENT } from "@/lib/stripe";

describe("platform commission (application fee)", () => {
  it("defaults to 5%", () => {
    expect(PLATFORM_FEE_PERCENT).toBe(5);
  });

  it("charges 5% of the sale amount", () => {
    expect(calcApplicationFee(10_000)).toBe(500); // $100 → $5.00
    expect(calcApplicationFee(12_000)).toBe(600); // $120 → $6.00
  });

  it("rounds to whole cents", () => {
    expect(calcApplicationFee(999)).toBe(50); // 49.95 → 50
    expect(calcApplicationFee(1010)).toBe(51); // 50.5 → 51 (round half up)
    expect(calcApplicationFee(101)).toBe(5); // 5.05 → 5
  });

  it("returns 0 for a zero amount", () => {
    expect(calcApplicationFee(0)).toBe(0);
  });
});

/**
 * These tests reload the stripe module with a custom PLATFORM_FEE_PERCENT env
 * var to verify that invalid values trigger the console.error fallback rather
 * than crashing the process or silently charging 0% / NaN%.
 *
 * vi.resetModules() is required because PLATFORM_FEE_PERCENT is evaluated at
 * module load time; only a fresh import picks up the new env value.
 */
describe("parsePlatformFeePercent — invalid configuration", () => {
  let originalValue: string | undefined;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalValue = process.env.PLATFORM_FEE_PERCENT;
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.resetModules();
  });

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.PLATFORM_FEE_PERCENT;
    } else {
      process.env.PLATFORM_FEE_PERCENT = originalValue;
    }
    consoleErrorSpy.mockRestore();
    vi.resetModules();
  });

  async function loadStripeModule() {
    return import("@/lib/stripe");
  }

  it("falls back to 5 and logs an error when the value is a non-numeric string", async () => {
    process.env.PLATFORM_FEE_PERCENT = "fifty";
    const { PLATFORM_FEE_PERCENT: fee } = await loadStripeModule();
    expect(fee).toBe(5);
    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    expect(consoleErrorSpy.mock.calls[0][0]).toMatch(/PLATFORM_FEE_PERCENT/);
    expect(consoleErrorSpy.mock.calls[0][0]).toMatch(/fifty/);
    expect(consoleErrorSpy.mock.calls[0][0]).toMatch(/Falling back/);
  });

  it("falls back to 5 and logs an error when the value is NaN-producing empty string", async () => {
    process.env.PLATFORM_FEE_PERCENT = "";
    const { PLATFORM_FEE_PERCENT: fee } = await loadStripeModule();
    expect(fee).toBe(5);
    expect(consoleErrorSpy).toHaveBeenCalledOnce();
  });

  it("falls back to 5 and logs an error when the value is negative", async () => {
    process.env.PLATFORM_FEE_PERCENT = "-1";
    const { PLATFORM_FEE_PERCENT: fee } = await loadStripeModule();
    expect(fee).toBe(5);
    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    expect(consoleErrorSpy.mock.calls[0][0]).toMatch(/-1/);
  });

  it("falls back to 5 and logs an error when the value exceeds 100", async () => {
    process.env.PLATFORM_FEE_PERCENT = "150";
    const { PLATFORM_FEE_PERCENT: fee } = await loadStripeModule();
    expect(fee).toBe(5);
    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    expect(consoleErrorSpy.mock.calls[0][0]).toMatch(/150/);
  });

  it("does NOT log an error for a valid value", async () => {
    process.env.PLATFORM_FEE_PERCENT = "10";
    const { PLATFORM_FEE_PERCENT: fee } = await loadStripeModule();
    expect(fee).toBe(10);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("accepts 0 as a valid (zero-fee) value without logging an error", async () => {
    process.env.PLATFORM_FEE_PERCENT = "0";
    const { PLATFORM_FEE_PERCENT: fee } = await loadStripeModule();
    expect(fee).toBe(0);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
