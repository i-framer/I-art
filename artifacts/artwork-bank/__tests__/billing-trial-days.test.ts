import { describe, it, expect } from "vitest";
import { getTrialDaysRemaining } from "@/lib/billing";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-08-03T12:00:00Z");

describe("getTrialDaysRemaining", () => {
  it("returns null when not trialing", () => {
    expect(getTrialDaysRemaining("active", new Date(now + 5 * DAY), now)).toBeNull();
    expect(getTrialDaysRemaining(null, new Date(now + 5 * DAY), now)).toBeNull();
  });

  it("returns null when no trialEnd is stored", () => {
    expect(getTrialDaysRemaining("trialing", null, now)).toBeNull();
    expect(getTrialDaysRemaining("trialing", undefined, now)).toBeNull();
  });

  it("rounds partial days up", () => {
    expect(getTrialDaysRemaining("trialing", new Date(now + 4.5 * DAY), now)).toBe(5);
    expect(getTrialDaysRemaining("trialing", new Date(now + 1 * DAY), now)).toBe(1);
  });

  it("returns 0 when the trial end has passed or is now", () => {
    expect(getTrialDaysRemaining("trialing", new Date(now), now)).toBe(0);
    expect(getTrialDaysRemaining("trialing", new Date(now - DAY), now)).toBe(0);
  });

  it("counts full days remaining", () => {
    expect(getTrialDaysRemaining("trialing", new Date(now + 14 * DAY), now)).toBe(14);
  });
});
