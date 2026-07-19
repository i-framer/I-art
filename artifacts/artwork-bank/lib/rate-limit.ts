/**
 * Simple in-memory sliding-window rate limiter, keyed by an arbitrary string
 * (e.g. client IP). Suitable for a single-process server; entries are pruned
 * lazily so memory stays bounded.
 */

type Entry = {
  timestamps: number[];
};

const buckets = new Map<string, Entry>();

let lastSweep = 0;

function sweep(now: number, windowMs: number) {
  // Prune stale buckets at most once a minute to keep memory bounded.
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, entry] of buckets) {
    entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);
    if (entry.timestamps.length === 0) buckets.delete(key);
  }
}

/**
 * Returns true if the caller identified by `key` is allowed to proceed,
 * false if they exceeded `limit` actions within `windowMs`.
 */
export function checkRateLimit(
  key: string,
  { limit, windowMs }: { limit: number; windowMs: number },
): boolean {
  const now = Date.now();
  sweep(now, windowMs);

  const entry = buckets.get(key) ?? { timestamps: [] };
  entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);

  if (entry.timestamps.length >= limit) {
    buckets.set(key, entry);
    return false;
  }

  entry.timestamps.push(now);
  buckets.set(key, entry);
  return true;
}

/** Test-only helper to reset limiter state. */
export function resetRateLimiter() {
  buckets.clear();
  lastSweep = 0;
}
