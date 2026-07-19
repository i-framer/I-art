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
    throw new StripeNotConfiguredError(
      `Stripe connector unreachable: ${err?.message ?? String(err)}`,
    );
  }

  if (!resp.ok) {
    throw new StripeNotConfiguredError(
      `Failed to fetch Stripe credentials: ${resp.status} ${resp.statusText}`,
    );
  }

  const data = await resp.json();
  const settings = data.items?.[0]?.settings;

  if (!settings?.secret_key) {
    throw new StripeNotConfiguredError(
      "Stripe integration not connected. Connect Stripe via the Integrations tab.",
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

/** Platform application fee as a percentage (default 5%). */
export const PLATFORM_FEE_PERCENT = parseFloat(
  process.env.PLATFORM_FEE_PERCENT ?? "5",
);

/** Calculate the platform application fee in cents. */
export function calcApplicationFee(subtotalCents: number): number {
  return Math.round(subtotalCents * (PLATFORM_FEE_PERCENT / 100));
}
