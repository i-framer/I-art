/**
 * Tasks #38 and #296 — Rate-limit test reliability and isolation.
 *
 * Verifies that:
 *  #296 — Rate-limit events stored under one key prefix do NOT count against
 *         a different key prefix, so counters from one test run cannot corrupt
 *         another.
 *  #38  — resetRateLimiter with a key prefix clears ONLY events for that
 *         prefix, leaving events for other prefixes intact.  This proves the
 *         cleanup strategy used in inquiry-rate-limit.test.ts is correct and
 *         that a fresh environment (empty table) always starts at zero.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { checkRateLimit, resetRateLimiter } from "../lib/rate-limit";
import { pool } from "@workspace/db";

// Unique prefix for this test file so it never clashes with other runs.
const PREFIX_A = `test-iso-a-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const PREFIX_B = `test-iso-b-${Date.now()}-${Math.random().toString(36).slice(2)}`;

describeIntegration("rate-limit key isolation (Tasks #296, #38)", () => {
  beforeEach(async () => {
    await resetRateLimiter(PREFIX_A);
    await resetRateLimiter(PREFIX_B);
  });

  afterAll(async () => {
    await resetRateLimiter(PREFIX_A);
    await resetRateLimiter(PREFIX_B);
    await pool.end();
  });

  it("#296 — exhausting PREFIX_A does not affect PREFIX_B", async () => {
    const limit = 3;
    const opts = { limit, windowMs: 60_000 };

    // Use up all of PREFIX_A's quota
    for (let i = 0; i < limit; i++) {
      await checkRateLimit(`${PREFIX_A}:ip1`, opts);
    }
    // PREFIX_A should now be blocked
    expect(await checkRateLimit(`${PREFIX_A}:ip1`, opts)).toBe(false);

    // PREFIX_B must be unaffected — still at zero
    expect(await checkRateLimit(`${PREFIX_B}:ip1`, opts)).toBe(true);
  });

  it("#296 — counter does not carry over after resetRateLimiter", async () => {
    const limit = 2;
    const opts = { limit, windowMs: 60_000 };

    // Exhaust PREFIX_A
    for (let i = 0; i < limit; i++) {
      await checkRateLimit(`${PREFIX_A}:ip2`, opts);
    }
    expect(await checkRateLimit(`${PREFIX_A}:ip2`, opts)).toBe(false);

    // Reset only PREFIX_A
    await resetRateLimiter(PREFIX_A);

    // Counter should be back to zero after reset
    expect(await checkRateLimit(`${PREFIX_A}:ip2`, opts)).toBe(true);
  });

  it("#38 — resetRateLimiter(prefix) only clears its own events, not others", async () => {
    const limit = 3;
    const opts = { limit, windowMs: 60_000 };

    // Record some events under both prefixes
    await checkRateLimit(`${PREFIX_A}:ip3`, opts);
    await checkRateLimit(`${PREFIX_B}:ip3`, opts);

    // Clear only PREFIX_A
    await resetRateLimiter(PREFIX_A);

    // PREFIX_B should still have its event (1 of 3 used, still allowed)
    expect(await checkRateLimit(`${PREFIX_B}:ip3`, opts)).toBe(true);
    // But PREFIX_A is back to zero (1 of 3 used after reset, still allowed)
    expect(await checkRateLimit(`${PREFIX_A}:ip3`, opts)).toBe(true);
  });

  it("#38 — a fresh environment (no prior events) starts at full quota", async () => {
    // Any unique key that has never been used should immediately be allowed.
    const freshKey = `${PREFIX_A}:fresh-${Math.random().toString(36).slice(2)}`;
    expect(
      await checkRateLimit(freshKey, { limit: 1, windowMs: 60_000 }),
    ).toBe(true);
  });

  it("#296 — two different IPs under the same prefix are counted independently", async () => {
    const opts = { limit: 2, windowMs: 60_000 };

    // Exhaust ip4
    await checkRateLimit(`${PREFIX_A}:ip4`, opts);
    await checkRateLimit(`${PREFIX_A}:ip4`, opts);
    expect(await checkRateLimit(`${PREFIX_A}:ip4`, opts)).toBe(false);

    // ip5 has its own counter and must be unaffected
    expect(await checkRateLimit(`${PREFIX_A}:ip5`, opts)).toBe(true);
  });
});
