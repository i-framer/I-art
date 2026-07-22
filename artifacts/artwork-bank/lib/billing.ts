import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db, tenantsTable, type Tenant } from "@workspace/db";
import { getStripeClient } from "@/lib/stripe";

/** Monthly subscription price in cents (AUD). */
export const SUBSCRIPTION_PRICE_CENTS = 1000; // $10 AUD / month
export const SUBSCRIPTION_CURRENCY = "aud";
const SUBSCRIPTION_PRODUCT_NAME = "Artwork Bank subscription";
/** Lookup key so the price can be found again without an env var. */
const SUBSCRIPTION_PRICE_LOOKUP_KEY = "artwork_bank_monthly_v1";

/**
 * Subscription statuses that grant admin access.
 * `past_due` is included as a grace period — a lapsed card shouldn't lock a
 * gallery out instantly (Stripe retries the charge; the status becomes
 * `canceled`/`unpaid` when dunning is exhausted).
 */
const ACTIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

type BillingFields = Pick<Tenant, "billingExempt" | "subscriptionStatus">;

/** Whether the tenant currently has access to the admin app. */
export function hasActiveAccess(tenant: BillingFields): boolean {
  if (tenant.billingExempt) return true;
  return (
    tenant.subscriptionStatus != null &&
    ACTIVE_STATUSES.has(tenant.subscriptionStatus)
  );
}

/**
 * Server-side billing guard for gated admin mutations. The paywall layout
 * only hides pages — server actions must re-validate billing state so an
 * unsubscribed tenant can't invoke mutations directly.
 * Throws when the tenant has no active subscription (and no exemption).
 */
export async function requireActiveBillingAccess(
  tenantId: string,
): Promise<void> {
  const tenant = await db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.id, tenantId),
    columns: { billingExempt: true, subscriptionStatus: true },
  });
  if (!tenant || !hasActiveAccess(tenant)) {
    throw new Error("Subscription required");
  }
}

/**
 * Resolve the Stripe Price ID for the $10/month plan.
 * Order of precedence:
 *   1. SUBSCRIPTION_PRICE_ID env var (explicit override)
 *   2. Existing price found by lookup key
 *   3. Create the product + price (idempotent via the lookup key)
 */
export async function getSubscriptionPriceId(
  stripe?: Stripe,
): Promise<string> {
  if (process.env.SUBSCRIPTION_PRICE_ID) {
    return process.env.SUBSCRIPTION_PRICE_ID;
  }

  const client = stripe ?? (await getStripeClient());

  const existing = await client.prices.list({
    lookup_keys: [SUBSCRIPTION_PRICE_LOOKUP_KEY],
    active: true,
    limit: 1,
  });
  if (existing.data[0]) return existing.data[0].id;

  const price = await client.prices.create({
    currency: SUBSCRIPTION_CURRENCY,
    unit_amount: SUBSCRIPTION_PRICE_CENTS,
    recurring: { interval: "month" },
    lookup_key: SUBSCRIPTION_PRICE_LOOKUP_KEY,
    product_data: { name: SUBSCRIPTION_PRODUCT_NAME },
  });
  return price.id;
}
