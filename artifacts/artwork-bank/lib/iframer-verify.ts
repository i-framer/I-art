/**
 * i-Framer Premium subscription verification service  (Task #217)
 *
 * Queries the i-Framer database (read-only) to confirm that an account exists
 * and has an active Premium subscription.  The query is intentionally thin and
 * configurable via env vars so the column/table names can be adjusted when the
 * operator provides the real schema.
 *
 * Required env vars (document in DEPLOY.md):
 *   IFRAMER_VERIFY_DB_URL       — Postgres connection string to a read-only
 *                                  replica or role; e.g. postgres://ro:pw@host/db
 *
 * Optional env vars (defaults match the expected i-Framer schema):
 *   IFRAMER_VERIFY_TABLE        — table to query           (default: accounts)
 *   IFRAMER_VERIFY_ACCOUNT_COL  — account-ID column        (default: portal_slug)
 *   IFRAMER_VERIFY_STATUS_COL   — subscription status col  (default: subscription_status)
 *   IFRAMER_VERIFY_TIER_COL     — plan/tier column         (default: plan_tier)
 *   IFRAMER_VERIFY_ACTIVE_STATUS— comma-separated active statuses (default: active)
 *   IFRAMER_VERIFY_PREMIUM_TIER — comma-separated premium tiers (default: premium)
 *
 * The operator MUST set IFRAMER_VERIFY_DB_URL for verification to work.
 * When it is absent the service returns {configured: false} so the billing
 * page can show a "verification unavailable" notice instead of an error.
 *
 * Security:
 *  - Only called from server actions/routes; never exposed to the browser.
 *  - The Postgres client is created fresh per call so a connection-string
 *    compromise does not persist across requests.
 *  - The query uses parameterised inputs — no string interpolation of
 *    user-supplied values.
 *  - Column/table names come only from env vars (operator-controlled).
 */

import { Client } from "pg";

export interface IFramerVerifyResult {
  /** false when IFRAMER_VERIFY_DB_URL is not configured. */
  configured: false;
  accountId?: never;
  isPremiumActive?: never;
  reason?: never;
}

export interface IFramerVerifySuccess {
  configured: true;
  accountId: string;
  isPremiumActive: true;
  reason?: never;
}

export interface IFramerVerifyFailure {
  configured: true;
  accountId: string;
  isPremiumActive: false;
  /** Human-readable reason for the tenant to display. */
  reason: string;
}

export type IFramerVerifyOutcome =
  | IFramerVerifyResult
  | IFramerVerifySuccess
  | IFramerVerifyFailure;

/**
 * Normalise a raw i-Framer portal URL or account slug to a canonical account ID.
 * Accepts:
 *   - https://portal.iframer.com.au/accounts/my-gallery
 *   - portal.iframer.com.au/accounts/my-gallery
 *   - my-gallery          (raw slug, passed through)
 *
 * Returns null when the input cannot be parsed to a valid slug
 * (prevents injection of arbitrary DB values).
 */
export function normaliseIFramerUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Try to parse as a URL
  let candidate = trimmed;
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  try {
    const url = new URL(candidate);
    // Extract the last non-empty path segment as the account slug
    const segments = url.pathname.split("/").filter(Boolean);
    const slug = segments[segments.length - 1];
    if (slug && /^[a-zA-Z0-9_-]{1,100}$/.test(slug)) {
      return slug;
    }
  } catch {
    // Not a URL — treat the whole string as a slug if it looks safe
  }

  // Fall back: if it looks like a plain slug, use it directly
  if (/^[a-zA-Z0-9_-]{1,100}$/.test(trimmed)) {
    return trimmed;
  }

  return null;
}

/** Whether IFRAMER_VERIFY_DB_URL is present in the environment. */
export function isIFramerVerifyConfigured(): boolean {
  return Boolean(process.env.IFRAMER_VERIFY_DB_URL);
}

/**
 * Check whether an i-Framer account has an active Premium subscription.
 *
 * The function is intentionally side-effect-free (no writes, no caching) so
 * it can be called safely from a rate-limited server action. Caching is the
 * caller's responsibility (store `iframerVerifiedAt` on the tenant row).
 *
 * @param accountId  Normalised account slug returned by normaliseIFramerUrl().
 */
export async function verifyIFramerPremium(
  accountId: string,
): Promise<IFramerVerifyOutcome> {
  const dbUrl = process.env.IFRAMER_VERIFY_DB_URL;
  if (!dbUrl) {
    return { configured: false };
  }

  // Build query from env vars (operator-controlled, never user-controlled)
  const table = process.env.IFRAMER_VERIFY_TABLE ?? "accounts";
  const accountCol = process.env.IFRAMER_VERIFY_ACCOUNT_COL ?? "portal_slug";
  const statusCol = process.env.IFRAMER_VERIFY_STATUS_COL ?? "subscription_status";
  const tierCol = process.env.IFRAMER_VERIFY_TIER_COL ?? "plan_tier";

  const activeStatuses = new Set(
    (process.env.IFRAMER_VERIFY_ACTIVE_STATUS ?? "active")
      .split(",")
      .map((s) => s.trim().toLowerCase()),
  );
  const premiumTiers = new Set(
    (process.env.IFRAMER_VERIFY_PREMIUM_TIER ?? "premium")
      .split(",")
      .map((s) => s.trim().toLowerCase()),
  );

  // Validate table/column names: only word characters + underscores (no injection)
  const identifier = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
  if (
    !identifier.test(table) ||
    !identifier.test(accountCol) ||
    !identifier.test(statusCol) ||
    !identifier.test(tierCol)
  ) {
    throw new Error("i-Framer verify: invalid table/column names in env config");
  }

  const client = new Client({ connectionString: dbUrl, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    // `table`, `accountCol`, `statusCol`, `tierCol` are validated above — safe to interpolate
    const query = `SELECT "${statusCol}", "${tierCol}" FROM "${table}" WHERE "${accountCol}" = $1 LIMIT 1`;
    const result = await client.query(query, [accountId]);

    if (result.rows.length === 0) {
      return {
        configured: true,
        accountId,
        isPremiumActive: false,
        reason: "No i-Framer account found for this URL. Check you've entered the correct portal URL.",
      };
    }

    const row = result.rows[0];
    const status = String(row[statusCol] ?? "").toLowerCase();
    const tier = String(row[tierCol] ?? "").toLowerCase();

    if (!premiumTiers.has(tier)) {
      return {
        configured: true,
        accountId,
        isPremiumActive: false,
        reason: `Your i-Framer account is on the ${row[tierCol] ?? "unknown"} plan. Artwork Bank is free on the Premium plan only. Upgrade at iframer.com.au.`,
      };
    }

    if (!activeStatuses.has(status)) {
      return {
        configured: true,
        accountId,
        isPremiumActive: false,
        reason: `Your i-Framer Premium subscription is ${row[statusCol] ?? "inactive"}. Reactivate it at iframer.com.au to unlock free access.`,
      };
    }

    return { configured: true, accountId, isPremiumActive: true };
  } finally {
    await client.end().catch(() => {});
  }
}
