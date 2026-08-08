import { it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { checkRateLimit, resetRateLimiter, sweepStaleTestRows } from "../lib/rate-limit";
// pool import removed — calling pool.end() in afterAll would close the shared
// DB connection and break other integration suites in the same Vitest process.

// Integration tests against the shared Postgres-backed limiter, using a
// unique key prefix so runs don't interfere with real data or each other.
const prefix = `test-rl-${Date.now()}-${Math.random().toString(36).slice(2)}`;

// Prune any stale test rows left behind by crashed previous runs before the
// suite starts. This runs even when the suite is skipped (no DATABASE_URL) so
// a fresh environment stays clean over time.
beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  await sweepStaleTestRows();
});

describeIntegration("checkRateLimit (Postgres-backed)", () => {
  beforeEach(async () => {
    await resetRateLimiter(prefix);
  });

  afterAll(async () => {
    await resetRateLimiter(prefix);
    // NOTE: do NOT call pool.end() here — closing the shared pool breaks
    // other integration suites that share the same Vitest worker process.
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

  it("allows requests again after the window expires", async () => {
    // Use a very short window so we don't have to wait long in CI.
    const windowMs = 300;

    // Exhaust the limit.
    for (let i = 0; i < 3; i++) {
      await checkRateLimit(`${prefix}:ip6`, { limit: 3, windowMs });
    }
    expect(
      await checkRateLimit(`${prefix}:ip6`, { limit: 3, windowMs }),
    ).toBe(false);

    // Wait for the window to roll over.
    await new Promise((resolve) => setTimeout(resolve, windowMs + 50));

    // The key should be admitted again now that the old events have expired.
    expect(
      await checkRateLimit(`${prefix}:ip6`, { limit: 3, windowMs }),
    ).toBe(true);
  }, 10_000);
});
