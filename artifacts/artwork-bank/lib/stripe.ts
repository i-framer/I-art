import Stripe from "stripe";

/**
 * Thrown when Stripe credentials are missing or the connector is unreachable.
 * Routes should catch this and return a friendly "payments unavailable" error.
 */
export class StripeNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeNotConfiguredError";
  }
}

/**
 * Fetches Stripe credentials from the Replit connector API.
 * Not cached — tokens can rotate, so always fetch fresh.
 */
async function getStripeCredentials(): Promise<{
  secretKey: string;
  webhookSecret?: string;
}> {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? "depl " + process.env.WEB_REPL_RENEWAL
      : null;

  if (!hostname || !xReplitToken) {
    // Fallback for dev without Replit connector
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      throw new StripeNotConfiguredError(
        "Stripe not configured. Connect the Stripe integration or set STRIPE_SECRET_KEY.",
      );
    }
    return { secretKey, webhookSecret: process.env.STRIPE_WEBHOOK_SECRET };
  }

  // Falls back to STRIPE_SECRET_KEY when the connector fails for any reason
  // (unreachable, non-OK response, or not connected), so the same code runs
  // on Vercel or any host with plain env vars.
  const envFallback = (reason: string) => {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (secretKey) {
      return { secretKey, webhookSecret: process.env.STRIPE_WEBHOOK_SECRET };
    }
    throw new StripeNotConfiguredError(reason);
  };

  let resp: Response;
  try {
    resp = await fetch(
      `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=stripe`,
      {
        headers: { Accept: "application/json", X_REPLIT_TOKEN: xReplitToken },
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
      },
    );
  } catch (err: any) {
    return envFallback(
      `Stripe connector unreachable: ${err?.message ?? String(err)}`,
    );
  }

  if (!resp.ok) {
    return envFallback(
      `Failed to fetch Stripe credentials: ${resp.status} ${resp.statusText}`,
    );
  }

  const data = await resp.json();
  const settings = data.items?.[0]?.settings;

  if (!settings?.secret_key) {
    return envFallback(
      "Stripe integration not connected. Connect Stripe via the Integrations tab or set STRIPE_SECRET_KEY.",
    );
  }

  return {
    secretKey: settings.secret_key as string,
    webhookSecret: (settings.webhook_secret as string | undefined) ?? process.env.STRIPE_WEBHOOK_SECRET,
  };
}

/**
 * Returns true when Stripe credentials are available (connector or env var).
 * Used for pre-flight availability checks — never throws.
 */
export async function isStripeConfigured(): Promise<boolean> {
  try {
    await getStripeCredentials();
    return true;
  } catch {
    return false;
  }
}

/** Returns a fresh authenticated Stripe client. */
export async function getStripeClient(): Promise<Stripe> {
  const { secretKey } = await getStripeCredentials();
  return new Stripe(secretKey);
}

/** Returns the webhook signing secret, preferring the connector then env var. */
export async function getStripeWebhookSecret(): Promise<string | undefined> {
  try {
    const { webhookSecret } = await getStripeCredentials();
    return webhookSecret ?? process.env.STRIPE_WEBHOOK_SECRET;
  } catch {
    return process.env.STRIPE_WEBHOOK_SECRET;
  }
}

// ---------------------------------------------------------------------------
// Stripe environment diagnostic (operator-facing)
// ---------------------------------------------------------------------------

/**
 * True when Stripe rejected a Connect-scoped call because Connect is not
 * enabled on the platform account. Mirrors the classification used by the
 * onboarding action.
 */
export function isConnectNotEnabledError(err: unknown): boolean {
  const msg = String((err as { message?: string } | null)?.message ?? "");
  return /connect/i.test(msg) && /(signed up|not.*enabled|platform)/i.test(msg);
}

export type StripeConnectStatus = "enabled" | "disabled" | "unknown";

export type StripeEnvironmentDiagnostic =
  | { status: "not_configured"; message: string }
  | { status: "invalid_key"; message: string }
  | { status: "unreachable"; message: string }
  | {
      status: "ok";
      /** The platform account ID the configured key resolves to (acct_…). */
      accountId: string;
      /** Business/display name of the account, if set. */
      accountName: string | null;
      /** true = live-mode key, false = test/sandbox key. */
      livemode: boolean;
      /**
       * Whether Stripe Connect is usable on this account.
       * - "enabled": a Connect-scoped read succeeded and connected accounts exist
       * - "disabled": Stripe rejected the read with its Connect-not-enabled error
       * - "unknown": the read succeeded but returned no connected accounts (Stripe
       *   returns an empty list for non-Connect platforms too), or it failed for
       *   an unrelated/transient reason — the panel should not assert either way
       */
      connectStatus: StripeConnectStatus;
    };

// ---------------------------------------------------------------------------
// Short-lived in-memory cache for the diagnostic (avoids Stripe round-trips
// on every page load while keeping TTL short enough to catch key rotations).
// ---------------------------------------------------------------------------

let _diagnosticCache: {
  value: StripeEnvironmentDiagnostic;
  expiresAt: number;
} | null = null;

/** Cache TTL in milliseconds. Short enough to catch key rotations quickly. */
export const DIAGNOSTIC_CACHE_TTL_MS = 60_000;

/**
 * Resets the in-process diagnostic cache.
 * Exposed so test suites can clear state between cases without waiting for TTL.
 */
export function resetStripeEnvironmentDiagnosticCache(): void {
  _diagnosticCache = null;
}

/**
 * Resolves which Stripe account and mode the configured secret key belongs
 * to, and probes whether Connect is enabled — via a harmless Connect-scoped
 * read (listing connected accounts). Never throws; never exposes key
 * material, only non-sensitive account metadata.
 *
 * Results are cached in-process for up to 60 seconds so slow/down Stripe
 * doesn't block the operator page on every load. `expiresAt` is set after
 * the fetch resolves so slow Stripe calls don't eat into the TTL window.
 */
export async function getStripeEnvironmentDiagnostic(): Promise<StripeEnvironmentDiagnostic> {
  const now = Date.now();
  if (_diagnosticCache && now < _diagnosticCache.expiresAt) {
    return _diagnosticCache.value;
  }
  const result = await _fetchStripeEnvironmentDiagnostic();
  // Record expiresAt *after* the fetch so a slow Stripe call doesn't shorten
  // the effective cache window.
  _diagnosticCache = {
    value: result,
    expiresAt: Date.now() + DIAGNOSTIC_CACHE_TTL_MS,
  };
  return result;
}

async function _fetchStripeEnvironmentDiagnostic(): Promise<StripeEnvironmentDiagnostic> {
  let stripe: Stripe;
  try {
    stripe = await getStripeClient();
  } catch (err) {
    return {
      status: "not_configured",
      message:
        err instanceof StripeNotConfiguredError
          ? err.message
          : "Stripe is not configured.",
    };
  }

  let account: Stripe.Account;
  try {
    // No-arg form retrieves the platform's own account; the installed type
    // definitions only declare the (id, params) overloads.
    account = await (
      stripe.accounts.retrieve as unknown as () => Promise<Stripe.Account>
    )();
  } catch (err: any) {
    const type = err?.type ?? err?.raw?.type;
    if (type === "StripeAuthenticationError" || err?.statusCode === 401) {
      return {
        status: "invalid_key",
        message:
          "The configured Stripe secret key was rejected by Stripe. It may have been revoked or rolled — update the key.",
      };
    }
    // Not an auth failure — likely a network/API problem, not a bad key.
    return {
      status: "unreachable",
      message: `Stripe could not be reached: ${err?.message ?? String(err)}`,
    };
  }

  // Probe Connect with a harmless read (listing connected accounts).
  // - Rejected with the Connect-not-enabled error → definitively disabled.
  // - Succeeds with at least one connected account → definitively enabled.
  // - Succeeds but empty → ambiguous (Stripe also returns an empty list for
  //   non-Connect platforms), so report "unknown" rather than asserting.
  let connectStatus: StripeConnectStatus = "unknown";
  try {
    const list = await stripe.accounts.list({ limit: 1 });
    connectStatus = list.data.length > 0 ? "enabled" : "unknown";
  } catch (err) {
    if (isConnectNotEnabledError(err)) {
      connectStatus = "disabled";
    }
    // Any other failure: leave "unknown" — don't falsely alarm the operator.
  }

  const settingsName = (account.settings?.dashboard?.display_name ??
    null) as string | null;
  return {
    status: "ok",
    accountId: account.id,
    accountName: account.business_profile?.name ?? settingsName,
    livemode: Boolean((account as { livemode?: boolean }).livemode),
    connectStatus,
  };
}

/** The fallback platform fee percentage used when the env var is misconfigured. */
export const PLATFORM_FEE_PERCENT_DEFAULT = 5;

/**
 * Parse and validate PLATFORM_FEE_PERCENT at module load time.
 * Logs a clear error and falls back to the documented default (5%) if the
 * value is missing or invalid, so operators see the problem in startup logs
 * rather than silently charging NaN% or 0% on every sale.
 */
function parsePlatformFeePercent(): number {
  const raw = process.env.PLATFORM_FEE_PERCENT ?? String(PLATFORM_FEE_PERCENT_DEFAULT);
  const parsed = parseFloat(raw);
  if (!isFinite(parsed) || parsed < 0 || parsed > 100) {
    console.error(
      `[stripe] Invalid PLATFORM_FEE_PERCENT "${raw}": must be a finite number between 0 ` +
        `and 100. Falling back to the default of ${PLATFORM_FEE_PERCENT_DEFAULT}%. ` +
        `Fix the environment variable to suppress this warning.`,
    );
    return PLATFORM_FEE_PERCENT_DEFAULT;
  }
  return parsed;
}

/** Platform application fee as a percentage (default 5%). */
export const PLATFORM_FEE_PERCENT = parsePlatformFeePercent();

/** Calculate the platform application fee in cents. */
export function calcApplicationFee(subtotalCents: number): number {
  return Math.round(subtotalCents * (PLATFORM_FEE_PERCENT / 100));
}

// ---------------------------------------------------------------------------
// Dashboard Stripe Connect banner logic
// ---------------------------------------------------------------------------

/**
 * Href for the "Complete setup" link shown in the warning banner.
 * Points to the settings page with the Stripe onboarding refresh flow.
 */
export const STRIPE_WARNING_BANNER_HREF = "/settings?stripe=refresh";

/**
 * Href for the "Check status" link shown in the pending banner.
 */
export const STRIPE_PENDING_BANNER_HREF = "/settings";

/**
 * Determines which Stripe Connect banner (if any) the dashboard should show.
 *
 * - "warning"  → account is linked but charges are disabled (onboarding incomplete)
 * - "pending"  → account is linked but we have not yet received an account.updated
 *                event (stripeChargesEnabled is null)
 * - null       → no banner (charges are enabled, or no Stripe account linked)
 */
export function getStripeBannerKind(tenant: {
  stripeAccountId: string | null | undefined;
  stripeChargesEnabled: boolean | null | undefined;
}): "warning" | "pending" | null {
  if (!tenant.stripeAccountId) return null;
  if (tenant.stripeChargesEnabled === false) return "warning";
  if (tenant.stripeChargesEnabled === null) return "pending";
  return null;
}
