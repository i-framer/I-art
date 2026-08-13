/**
 * Simple in-memory rate limiter for the i-Framer verify action  (Task #217)
 *
 * Limits each tenant to at most MAX_ATTEMPTS verifications per WINDOW_MS.
 * Uses in-process memory so it resets on server restart, but verification
 * is an admin-initiated low-frequency operation so this is sufficient.
 * A process restart costs at most one extra allowed attempt per tenant — an
 * acceptable tradeoff vs the complexity of a DB-backed rate limiter.
 */

interface Bucket {
  attempts: number;
  windowStart: number;
}

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60 * 60 * 1000; // 1 hour

const buckets = new Map<string, Bucket>();

/**
 * Returns true if the tenant is within their allowed rate limit.
 * Returns false when the limit has been exceeded for the current window.
 */
export function checkVerifyRateLimit(tenantId: string): boolean {
  const now = Date.now();
  const bucket = buckets.get(tenantId);

  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    // New window
    buckets.set(tenantId, { attempts: 1, windowStart: now });
    return true;
  }

  if (bucket.attempts >= MAX_ATTEMPTS) return false;

  bucket.attempts += 1;
  return true;
}
