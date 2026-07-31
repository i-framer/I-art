import { it, expect, beforeEach, afterAll } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { checkRateLimit, resetRateLimiter } from "../lib/rate-limit";
import { pool } from "@workspace/db";

// Integration tests against the shared Postgres-backed limiter, using a
// unique key prefix so runs don't interfere with real data or each other.
const prefix = `test-rl-${Date.now()}-${Math.random().toString(36).slice(2)}`;

describeIntegration("checkRateLimit (Postgres-backed)", () => {
  beforeEach(async () => {
    await resetRateLimiter(prefix);
  });

  afterAll(async () => {
    await resetRateLimiter(prefix);
    await pool.end();
  });

  it("allows up to the limit within the window", async () => {
    for (let i = 0; i < 5; i++) {
      expect(
        await checkRateLimit(`${prefix}:ip1`, { limit: 5, windowMs: 60_000 }),
      ).toBe(true);
    }
  });

  it("rejects requests over the limit", async () => {
    for (let i = 0; i < 5; i++) {
      await checkRateLimit(`${prefix}:ip2`, { limit: 5, windowMs: 60_000 });
    }
    expect(
      await checkRateLimit(`${prefix}:ip2`, { limit: 5, windowMs: 60_000 }),
    ).toBe(false);
  });

  it("keeps different keys independent", async () => {
    for (let i = 0; i < 5; i++) {
      await checkRateLimit(`${prefix}:ip3`, { limit: 5, windowMs: 60_000 });
    }
    expect(
      await checkRateLimit(`${prefix}:ip4`, { limit: 5, windowMs: 60_000 }),
    ).toBe(true);
  });

  it("holds the limit under concurrent requests", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        checkRateLimit(`${prefix}:ip5`, { limit: 5, windowMs: 60_000 }),
      ),
    );
    expect(results.filter(Boolean).length).toBe(5);
  });
});
