/**
 * Consignment & Commission Tracker — split calculation  (Task #82)
 *
 * Verifies calculateSplit() is correct across a range of inputs.
 */
import { describe, it, expect } from "vitest";
import { calculateSplit } from "@/app/(admin)/(gated)/consignment/actions";

describe("calculateSplit (Task #82)", () => {
  it("60/40 split on $1000 sale", () => {
    const { artistAmountCents, galleryAmountCents } = calculateSplit(100000, 60);
    expect(artistAmountCents).toBe(60000);
    expect(galleryAmountCents).toBe(40000);
    expect(artistAmountCents + galleryAmountCents).toBe(100000);
  });

  it("50/50 split", () => {
    const { artistAmountCents, galleryAmountCents } = calculateSplit(50000, 50);
    expect(artistAmountCents).toBe(25000);
    expect(galleryAmountCents).toBe(25000);
    expect(artistAmountCents + galleryAmountCents).toBe(50000);
  });

  it("70/30 split — artist gets more", () => {
    const { artistAmountCents, galleryAmountCents } = calculateSplit(30000, 70);
    expect(artistAmountCents).toBe(21000);
    expect(galleryAmountCents).toBe(9000);
  });

  it("100% to artist", () => {
    const { artistAmountCents, galleryAmountCents } = calculateSplit(20000, 100);
    expect(artistAmountCents).toBe(20000);
    expect(galleryAmountCents).toBe(0);
  });

  it("0% to artist (gallery keeps all)", () => {
    const { artistAmountCents, galleryAmountCents } = calculateSplit(20000, 0);
    expect(artistAmountCents).toBe(0);
    expect(galleryAmountCents).toBe(20000);
  });

  it("rounds down — artist never gets MORE than the exact share", () => {
    // 33% of 10 cents = 3.3 → floor to 3, gallery gets 7
    const { artistAmountCents, galleryAmountCents } = calculateSplit(10, 33);
    expect(artistAmountCents).toBe(3);
    expect(galleryAmountCents).toBe(7);
    // Sum must still equal the full sale price
    expect(artistAmountCents + galleryAmountCents).toBe(10);
  });

  it("amounts always add up to full sale price (no rounding leak)", () => {
    const cases: Array<[number, number]> = [
      [99999, 33],
      [1, 50],
      [100, 67],
      [123456, 41],
      [999999, 13],
    ];
    for (const [price, pct] of cases) {
      const { artistAmountCents, galleryAmountCents } = calculateSplit(price, pct);
      expect(artistAmountCents + galleryAmountCents).toBe(price);
    }
  });

  it("1 cent sale at 50% — floor ensures no negative gallery amount", () => {
    const { artistAmountCents, galleryAmountCents } = calculateSplit(1, 50);
    expect(artistAmountCents).toBe(0);
    expect(galleryAmountCents).toBe(1);
    expect(galleryAmountCents).toBeGreaterThanOrEqual(0);
  });

  it("returns integers (no fractional cents)", () => {
    const { artistAmountCents, galleryAmountCents } = calculateSplit(10001, 33);
    expect(Number.isInteger(artistAmountCents)).toBe(true);
    expect(Number.isInteger(galleryAmountCents)).toBe(true);
  });
});
