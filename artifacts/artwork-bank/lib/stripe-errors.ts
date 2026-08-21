/**
 * True when a Stripe error means a saved account/customer ID no longer exists
 * under the current API key (for example after switching between live and test
 * mode, or between Stripe platform accounts).
 */
export function isStripeResourceMissing(err: unknown): boolean {
  const error = err as {
    code?: string;
    raw?: { code?: string };
    message?: string;
  } | null;
  const code = error?.code ?? error?.raw?.code;

  if (code === "resource_missing" || code === "account_invalid") return true;

  return /no such (account|customer)/i.test(
    String(error?.message ?? ""),
  );
}

/**
 * True only when Stripe says a saved Connect account ID no longer exists.
 * Unlike isStripeResourceMissing, this deliberately excludes account_invalid:
 * Stripe also uses that code while a valid account is still completing
 * onboarding, which must continue through the normal "not ready" path.
 */
export function isStripeAccountMissing(err: unknown): boolean {
  const error = err as {
    code?: string;
    raw?: { code?: string };
    message?: string;
  } | null;
  const code = error?.code ?? error?.raw?.code;

  return (
    code === "resource_missing" ||
    /no such account/i.test(String(error?.message ?? ""))
  );
}