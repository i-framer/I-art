/**
 * Storefront artwork detail page — paymentsAvailable gate.
 *
 * The page computes:
 *   paymentsAvailable =
 *     Boolean(tenant.stripeAccountId) &&
 *     tenant.stripeChargesEnabled !== false &&
 *     isStripeConfigured()
 *
 * stripeChargesEnabled values:
 *   true  — account.updated webhook confirmed charges are on → show buy button
 *   false — account.updated webhook confirmed charges are off → hide buy button
 *   null  — no webhook received yet (give benefit of the doubt) → show buy button
 *
 * These unit tests document and lock the three conditions, with particular
 * attention to stripeChargesEnabled = null (no account.updated webhook
 * received yet) — it gives benefit of the doubt and lets the buyer proceed;
 * the checkout route performs its own live Stripe check at payment time.
 */
import { describe, it, expect } from "vitest";

// Mirror the inline logic from app/t/[slug]/[artworkId]/page.tsx so we can
// test it without rendering the full Server Component.
function paymentsAvailable(
  stripeAccountId: string | null | undefined,
  stripeChargesEnabled: boolean | null | undefined,
  stripeConfigured: boolean,
): boolean {
  return (
    Boolean(stripeAccountId) &&
    stripeChargesEnabled !== false &&
    stripeConfigured
  );
}

describe("storefront paymentsAvailable — stripeChargesEnabled", () => {
  it("returns true when stripeChargesEnabled is null (no webhook yet — benefit of the doubt)", () => {
    expect(paymentsAvailable("acct_123", null, true)).toBe(true);
  });

  it("returns false when stripeChargesEnabled is false (explicitly not ready)", () => {
    expect(paymentsAvailable("acct_123", false, true)).toBe(false);
  });

  it("returns true when stripeChargesEnabled is true and all other conditions are met", () => {
    expect(paymentsAvailable("acct_123", true, true)).toBe(true);
  });
});

describe("storefront paymentsAvailable — stripeAccountId", () => {
  it("returns false when stripeAccountId is null (no Connect account)", () => {
    expect(paymentsAvailable(null, true, true)).toBe(false);
  });

  it("returns false when stripeAccountId is an empty string", () => {
    expect(paymentsAvailable("", true, true)).toBe(false);
  });
});

describe("storefront paymentsAvailable — platform Stripe config", () => {
  it("returns false when the platform Stripe client is not configured", () => {
    expect(paymentsAvailable("acct_123", true, false)).toBe(false);
  });
});
