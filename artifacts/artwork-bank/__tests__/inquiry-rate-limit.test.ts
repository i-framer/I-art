import { describe, it, expect, beforeEach } from "vitest";
import { checkRateLimit, resetRateLimiter } from "../lib/rate-limit";

describe("checkRateLimit", () => {
  beforeEach(() => {
    resetRateLimiter();
  });

  it("allows up to the limit within the window", () => {
    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit("ip:1", { limit: 5, windowMs: 60_000 })).toBe(true);
    }
  });

  it("rejects requests over the limit", () => {
    for (let i = 0; i < 5; i++) {
      checkRateLimit("ip:2", { limit: 5, windowMs: 60_000 });
    }
    expect(checkRateLimit("ip:2", { limit: 5, windowMs: 60_000 })).toBe(false);
  });

  it("keeps different keys independent", () => {
    for (let i = 0; i < 5; i++) {
      checkRateLimit("ip:3", { limit: 5, windowMs: 60_000 });
    }
    expect(checkRateLimit("ip:4", { limit: 5, windowMs: 60_000 })).toBe(true);
  });
});
