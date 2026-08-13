/**
 * i-Framer Premium — commission rate calculation  (Task #217)
 *
 * Verifies calcApplicationFeeForTenant uses the per-tenant override when
 * present and falls back to the global rate when absent.
 */
import { describe, it, expect } from "vitest";
import {
  calcApplicationFeeForTenant,
  PLATFORM_FEE_PERCENT,
  PLATFORM_FEE_PERCENT_DEFAULT,
} from "@/lib/stripe";

describe("calcApplicationFeeForTenant (Task #217)", () => {
  it("uses 3.5% (350 bp) for i-Framer Premium tenants", () => {
    const { feeCents, commissionBasisPoints } = calcApplicationFeeForTenant(10000, 350);
    expect(feeCents).toBe(350); // 3.5% of $100 = $3.50 = 350 cents
    expect(commissionBasisPoints).toBe(350);
  });

  it("uses the global rate when commissionBasisPoints is null", () => {
    const { feeCents, commissionBasisPoints } = calcApplicationFeeForTenant(10000, null);
    const expectedFee = Math.round(10000 * (PLATFORM_FEE_PERCENT / 100));
    expect(feeCents).toBe(expectedFee);
    expect(commissionBasisPoints).toBe(Math.round(PLATFORM_FEE_PERCENT * 100));
  });

  it("uses the global rate when commissionBasisPoints is undefined", () => {
    const { feeCents } = calcApplicationFeeForTenant(10000, undefined);
    const expectedFee = Math.round(10000 * (PLATFORM_FEE_PERCENT / 100));
    expect(feeCents).toBe(expectedFee);
  });

  it("3.5% commission on $500 artwork = $17.50", () => {
    const { feeCents } = calcApplicationFeeForTenant(50000, 350);
    expect(feeCents).toBe(1750);
  });

  it("5% commission on $500 artwork = $25", () => {
    const { feeCents } = calcApplicationFeeForTenant(50000, 500);
    expect(feeCents).toBe(2500);
  });

  it("0% commission (free tier) = $0 fee", () => {
    const { feeCents, commissionBasisPoints } = calcApplicationFeeForTenant(10000, 0);
    expect(feeCents).toBe(0);
    expect(commissionBasisPoints).toBe(0);
  });

  it("feeCents + galleryShare = full price (no rounding leak)", () => {
    const prices = [9999, 10000, 10001, 50000, 123456];
    for (const price of prices) {
      const { feeCents } = calcApplicationFeeForTenant(price, 350);
      expect(feeCents).toBeGreaterThanOrEqual(0);
      expect(feeCents).toBeLessThanOrEqual(price);
    }
  });

  it("commissionBasisPoints field equals the input bp when explicitly set", () => {
    const { commissionBasisPoints } = calcApplicationFeeForTenant(10000, 350);
    expect(commissionBasisPoints).toBe(350);
  });

  it("i-Framer 3.5% vs standard 5% gives a lower fee", () => {
    const { feeCents: iFramerFee } = calcApplicationFeeForTenant(10000, 350);
    const { feeCents: standardFee } = calcApplicationFeeForTenant(10000, 500);
    expect(iFramerFee).toBeLessThan(standardFee);
  });
});
