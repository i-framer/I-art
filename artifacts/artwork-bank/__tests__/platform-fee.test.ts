import { describe, it, expect } from "vitest";
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
