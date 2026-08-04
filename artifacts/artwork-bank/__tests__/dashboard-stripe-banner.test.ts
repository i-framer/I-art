/**
 * Dashboard Stripe Connect banners.
 *
 * The dashboard shows:
 *  - a warning banner  when the account is linked but charges are disabled
 *    (onboarding incomplete / restricted)
 *  - a pending banner  when the account is linked but no account.updated
 *    webhook has arrived yet (stripeChargesEnabled === null)
 *  - no banner         when charges are enabled (onboarding complete)
 */
import { describe, it, expect } from "vitest";
import {
  getStripeBannerKind,
  STRIPE_WARNING_BANNER_HREF,
  STRIPE_PENDING_BANNER_HREF,
} from "@/lib/stripe";

const ACCOUNT_ID = "acct_test_123";

describe("getStripeBannerKind", () => {
  it("returns 'warning' when stripeChargesEnabled is false", () => {
    expect(
      getStripeBannerKind({
        stripeAccountId: ACCOUNT_ID,
        stripeChargesEnabled: false,
      }),
    ).toBe("warning");
  });

  it("returns 'pending' when stripeChargesEnabled is null", () => {
    expect(
      getStripeBannerKind({
        stripeAccountId: ACCOUNT_ID,
        stripeChargesEnabled: null,
      }),
    ).toBe("pending");
  });

  it("returns null (no banner) when stripeChargesEnabled is true", () => {
    expect(
      getStripeBannerKind({
        stripeAccountId: ACCOUNT_ID,
        stripeChargesEnabled: true,
      }),
    ).toBeNull();
  });

  it("returns null when no Stripe account is linked at all", () => {
    expect(
      getStripeBannerKind({
        stripeAccountId: null,
        stripeChargesEnabled: false,
      }),
    ).toBeNull();

    expect(
      getStripeBannerKind({
        stripeAccountId: undefined,
        stripeChargesEnabled: null,
      }),
    ).toBeNull();
  });
});

describe("Stripe banner hrefs", () => {
  it("warning banner links to /settings?stripe=refresh (triggers Stripe onboarding refresh)", () => {
    expect(STRIPE_WARNING_BANNER_HREF).toBe("/settings?stripe=refresh");
  });

  it("pending banner links to /settings (not the refresh flow)", () => {
    expect(STRIPE_PENDING_BANNER_HREF).toBe("/settings");
  });
});
