/**
 * Rate limiter — DB unavailable behavior (fail-open).
 *
 * checkRateLimit() explicitly fails open: if the database is unreachable
 * the request is allowed, since blocking legitimate users due to a limiter
 * outage would be worse than allowing extra requests through.
 *
 * Covers:
 *  - pool.connect() throws → function returns true (fail-open)
 *  - Transaction query throws after connect → function returns true (fail-open)
 *  - Error does not escape the function (no unhandled rejection)
 *  - release() is called even when a query fails after connect
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── DB pool mock ──────────────────────────────────────────────────────────────
const releaseFn = vi.hoisted(() => vi.fn());
const queryFn = vi.hoisted(() => vi.fn());
const connectFn = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    query: queryFn,
    release: releaseFn,
  }),
);

vi.mock("@workspace/db", () => ({
  pool: {
    connect: connectFn,
    query: vi.fn().mockResolvedValue({ rows: [] }),
  },
}));

import { checkRateLimit } from "@/lib/rate-limit";

beforeEach(() => {
  // Use clearAllMocks (not resetAllMocks / mockReset) so the default implementations
  // set in the vi.hoisted factories are not wiped between tests.
  vi.clearAllMocks();
  releaseFn.mockReset(); // clear call history only — releaseFn has no default impl
  queryFn.mockReset();   // same
  // Re-establish the connect mock so it returns a client object with fresh mocks
  connectFn.mockResolvedValue({ query: queryFn, release: releaseFn });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("checkRateLimit — DB failure / fail-open behavior", () => {
  it("returns true (fail-open) when pool.connect() throws", async () => {
    connectFn.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const allowed = await checkRateLimit("test-key", { limit: 5, windowMs: 60_000 });

    expect(allowed).toBe(true);
  });

  it("does not propagate the connection error", async () => {
    connectFn.mockRejectedValueOnce(new Error("DB down"));

    await expect(
      checkRateLimit("test-key", { limit: 5, windowMs: 60_000 }),
    ).resolves.toBe(true); // resolves, does not reject
  });

  it("returns true (fail-open) when a transaction query throws after connect", async () => {
    queryFn
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockRejectedValueOnce(new Error("query timeout")) // pg_advisory_xact_lock
      .mockResolvedValue(undefined); // ROLLBACK

    const allowed = await checkRateLimit("test-key", { limit: 5, windowMs: 60_000 });

    expect(allowed).toBe(true);
  });

  it("calls release() after a query failure (no connection leak)", async () => {
    queryFn
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockRejectedValueOnce(new Error("INSERT failed")) // advisory lock
      .mockResolvedValue(undefined); // ROLLBACK

    await checkRateLimit("test-key", { limit: 5, windowMs: 60_000 });

    expect(releaseFn).toHaveBeenCalledOnce();
  });

  it("logs the failure (does not swallow errors silently)", async () => {
    connectFn.mockRejectedValueOnce(new Error("DB offline"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await checkRateLimit("test-key", { limit: 5, windowMs: 60_000 });

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("returns false (rate-limited) when DB is healthy and limit exceeded", async () => {
    // Simulate a healthy DB that rejects the INSERT (limit exceeded → 0 rows)
    queryFn
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // advisory lock
      .mockResolvedValueOnce({ rowCount: 0 }) // INSERT ... WHERE count < limit → no row
      .mockResolvedValueOnce(undefined); // COMMIT

    const allowed = await checkRateLimit("test-key", { limit: 1, windowMs: 60_000 });

    expect(allowed).toBe(false);
  });

  it("returns true (allowed) when DB is healthy and limit not yet reached", async () => {
    queryFn
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // advisory lock
      .mockResolvedValueOnce({ rowCount: 1 }) // INSERT ... RETURNING id
      .mockResolvedValueOnce(undefined); // COMMIT

    const allowed = await checkRateLimit("test-key", { limit: 5, windowMs: 60_000 });

    expect(allowed).toBe(true);
  });
});
