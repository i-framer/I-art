/**
 * Storefront artwork detail page — paymentsAvailable gate.
 *
 * The page computes:
 *   paymentsAvailable =
 *     Boolean(tenant.stripeAccountId) &&
 *     tenant.stripeChargesEnabled === true &&
 *     isStripeConfigured()
 *
 * These unit tests document and lock the three conditions, with particular
 * attention to stripeChargesEnabled = null (no account.updated webhook
 * received yet) — it must evaluate to false, not true, so a buyer sees
 * "Gallery not yet accepting payments" rather than a checkout CTA that
 * immediately returns 503.
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
    stripeChargesEnabled === true &&
    stripeConfigured
  );
}

describe("storefront paymentsAvailable — stripeChargesEnabled", () => {
  it("returns false when stripeChargesEnabled is null (no webhook received yet)", () => {
    expect(paymentsAvailable("acct_123", null, true)).toBe(false);
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
