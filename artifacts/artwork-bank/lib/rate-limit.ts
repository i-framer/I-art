/**
 * Sliding-window rate limiter backed by the shared Postgres database, keyed
 * by an arbitrary string (e.g. `inquiry:<client IP>`). Because the counts
 * live in Postgres, the limit holds across all server instances (e.g. when
 * the app is deployed with autoscale).
 *
 * The check-and-record step is a single atomic INSERT ... SELECT so that
 * concurrent requests from the same key cannot both slip under the limit.
 */

import { pool } from "@workspace/db";

let lastSweep = 0;

async function sweep(now: number) {
  // Prune stale events at most once a minute so the table stays small.
  // An hour comfortably exceeds any window we use.
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  try {
    await pool.query(
      `DELETE FROM rate_limit_event WHERE created_at < now() - interval '1 hour'`,
    );
  } catch (err) {
    console.error("Rate limiter sweep failed", err);
  }
}

/**
 * Returns true if the caller identified by `key` is allowed to proceed,
 * false if they exceeded `limit` actions within `windowMs`.
 *
 * Fails open: if the database is unreachable the request is allowed, since
 * any subsequent write would fail anyway and legitimate users should not be
 * blocked by a limiter outage.
 */
export async function checkRateLimit(
  key: string,
  { limit, windowMs }: { limit: number; windowMs: number },
): Promise<boolean> {
  try {
    // Serialize concurrent checks for the same key with a transaction-scoped
    // advisory lock, then record the event only if still under the limit.
    // Without the lock, concurrent transactions can't see each other's
    // uncommitted inserts and would all slip under the limit.
    const client = await pool.connect();
    let allowed: boolean;
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [key]);
      const result = await client.query(
        `INSERT INTO rate_limit_event (key)
         SELECT $1
         WHERE (
           SELECT count(*) FROM rate_limit_event
           WHERE key = $1
             AND created_at > now() - ($2 || ' milliseconds')::interval
         ) < $3
         RETURNING id`,
        [key, String(windowMs), limit],
      );
      await client.query("COMMIT");
      allowed = (result.rowCount ?? 0) > 0;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    void sweep(Date.now());
    return allowed;
  } catch (err) {
    console.error("Rate limit check failed; allowing request", err);
    return true;
  }
}

/** Test-only helper to reset limiter state for a set of keys. */
export async function resetRateLimiter(keyPrefix?: string) {
  if (keyPrefix) {
    await pool.query(`DELETE FROM rate_limit_event WHERE key LIKE $1`, [
      `${keyPrefix}%`,
    ]);
  } else {
    await pool.query(`DELETE FROM rate_limit_event`);
  }
  lastSweep = 0;
}

/**
 * Test-only helper that prunes stale test rows left behind by crashed runs.
 *
 * Integration tests use a per-run `test-rl-*` key prefix so normal runs never
 * collide, but when a process crashes the `afterAll` cleanup is skipped and
 * those rows accumulate. Call this once at the start of a test suite to
 * delete any `test-rl-*` rows older than `maxAgeMs` (default: 5 minutes),
 * which is safely beyond any window used by the tests themselves.
 */
export async function sweepStaleTestRows(maxAgeMs = 5 * 60_000): Promise<void> {
  await pool.query(
    `DELETE FROM rate_limit_event
     WHERE key LIKE 'test-rl-%'
       AND created_at < now() - ($1 || ' milliseconds')::interval`,
    [String(maxAgeMs)],
  );
}
