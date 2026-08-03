/**
 * Order list — refund-notification-failed badge logic (Task #148).
 *
 * The orders list page derives per-row badge conditions from the order row.
 * This test covers the `refundNotifFailed` condition that shows the
 * "Refund email failed" badge — introduced so gallery owners scanning the list
 * can see a partial-refund notification failure without opening each order.
 *
 * The condition (mirrored from both page.tsx files) is:
 *   !!order.statusEmailError &&
 *   order.statusEmailAttempts === 0 &&
 *   !order.statusEmailQueuedAt
 *
 * This distinguishes a one-shot refund-notification failure
 * (notifyBuyerOfPartialRefund sets statusEmailError but never touches
 *  statusEmailAttempts or statusEmailQueuedAt) from the sweep/status-email path
 * (which uses statusEmailAttempts > 0 and/or statusEmailQueuedAt set).
 *
 * Covers:
 *  - An order with statusEmailError + attempts=0 + no queue → refundNotifFailed=true
 *  - An order with no statusEmailError → refundNotifFailed=false
 *  - An order where attempts > 0 (status-email sweep) → refundNotifFailed=false
 *  - An order where statusEmailQueuedAt is set (queued) → refundNotifFailed=false
 *  - An order where both error + attempts >= MAX → statusEmailFailed (not refundNotifFailed)
 *  - An order with partial refund but no email error → only shows refund badge, not email error
 *  - Mutual exclusivity: statusEmailRetrying and refundNotifFailed never overlap
 */
import { describe, it, expect } from "vitest";

const MAX_EMAIL_ATTEMPTS = 5;

/**
 * Replicate the badge-derivation logic from orders/page.tsx for isolated testing.
 * Any change to the page's conditions should be reflected here.
 */
function deriveBadges(order: {
  emailSentAt: Date | null;
  emailAttempts: number;
  statusEmailError: string | null;
  statusEmailAttempts: number;
  statusEmailQueuedAt: Date | null;
  refundedAmountCents: number | null;
  status: string;
}) {
  const isPartialRefund =
    (order.refundedAmountCents ?? 0) > 0 && order.status !== "CANCELLED";

  const emailFailed =
    !order.emailSentAt && order.emailAttempts >= MAX_EMAIL_ATTEMPTS;

  const statusEmailFailed =
    !!order.statusEmailError &&
    order.statusEmailAttempts >= MAX_EMAIL_ATTEMPTS;

  const statusEmailRetrying =
    !!order.statusEmailError &&
    order.statusEmailAttempts > 0 &&
    order.statusEmailAttempts < MAX_EMAIL_ATTEMPTS;

  const refundNotifFailed =
    !!order.statusEmailError &&
    order.statusEmailAttempts === 0 &&
    !order.statusEmailQueuedAt;

  return { isPartialRefund, emailFailed, statusEmailFailed, statusEmailRetrying, refundNotifFailed };
}

const baseOrder = {
  emailSentAt: new Date(),
  emailAttempts: 0,
  statusEmailError: null,
  statusEmailAttempts: 0,
  statusEmailQueuedAt: null,
  refundedAmountCents: null,
  status: "PAID",
};

describe("refundNotifFailed badge condition (Task #148)", () => {
  it("is true when notifyBuyerOfPartialRefund failed (error set, attempts=0, not queued)", () => {
    const badges = deriveBadges({
      ...baseOrder,
      statusEmailError: "SMTP connection refused",
      statusEmailAttempts: 0,
      statusEmailQueuedAt: null,
    });
    expect(badges.refundNotifFailed).toBe(true);
  });

  it("is false when there is no statusEmailError", () => {
    const badges = deriveBadges({
      ...baseOrder,
      statusEmailError: null,
      statusEmailAttempts: 0,
      statusEmailQueuedAt: null,
    });
    expect(badges.refundNotifFailed).toBe(false);
  });

  it("is false when statusEmailAttempts > 0 (sweep path, not refund notification)", () => {
    const badges = deriveBadges({
      ...baseOrder,
      statusEmailError: "Send failed",
      statusEmailAttempts: 2,
      statusEmailQueuedAt: null,
    });
    expect(badges.refundNotifFailed).toBe(false);
  });

  it("is false when statusEmailQueuedAt is set (queued for sweep retry)", () => {
    const badges = deriveBadges({
      ...baseOrder,
      statusEmailError: "Send failed",
      statusEmailAttempts: 0,
      statusEmailQueuedAt: new Date(),
    });
    expect(badges.refundNotifFailed).toBe(false);
  });

  it("is false when attempts reached MAX (statusEmailFailed takes precedence)", () => {
    const badges = deriveBadges({
      ...baseOrder,
      statusEmailError: "Send failed",
      statusEmailAttempts: MAX_EMAIL_ATTEMPTS,
      statusEmailQueuedAt: null,
    });
    expect(badges.refundNotifFailed).toBe(false);
    expect(badges.statusEmailFailed).toBe(true);
  });
});

describe("refundNotifFailed mutual exclusivity", () => {
  it("never overlaps with statusEmailRetrying (attempts > 0 rules both out)", () => {
    // statusEmailRetrying requires attempts > 0; refundNotifFailed requires attempts === 0
    for (let attempts = 1; attempts < MAX_EMAIL_ATTEMPTS; attempts++) {
      const badges = deriveBadges({
        ...baseOrder,
        statusEmailError: "err",
        statusEmailAttempts: attempts,
        statusEmailQueuedAt: null,
      });
      expect(badges.refundNotifFailed).toBe(false);
      expect(badges.statusEmailRetrying).toBe(true);
    }
  });

  it("never overlaps with statusEmailFailed (attempts >= MAX rules both out)", () => {
    const badges = deriveBadges({
      ...baseOrder,
      statusEmailError: "err",
      statusEmailAttempts: MAX_EMAIL_ATTEMPTS,
      statusEmailQueuedAt: null,
    });
    expect(badges.refundNotifFailed).toBe(false);
    expect(badges.statusEmailFailed).toBe(true);
  });

  it("can coexist with isPartialRefund when a partial-refund row also fails notification", () => {
    const badges = deriveBadges({
      ...baseOrder,
      statusEmailError: "SMTP failure",
      statusEmailAttempts: 0,
      statusEmailQueuedAt: null,
      refundedAmountCents: 5000,
      status: "PAID",
    });
    expect(badges.refundNotifFailed).toBe(true);
    expect(badges.isPartialRefund).toBe(true);
  });
});

describe("existing badge conditions unchanged (regression)", () => {
  it("emailFailed is true when confirmation email was never sent after MAX attempts", () => {
    const badges = deriveBadges({
      ...baseOrder,
      emailSentAt: null,
      emailAttempts: MAX_EMAIL_ATTEMPTS,
    });
    expect(badges.emailFailed).toBe(true);
  });

  it("emailFailed is false when email was sent successfully", () => {
    const badges = deriveBadges({
      ...baseOrder,
      emailSentAt: new Date(),
      emailAttempts: 1,
    });
    expect(badges.emailFailed).toBe(false);
  });

  it("isPartialRefund is false for a CANCELLED order even if refunded", () => {
    const badges = deriveBadges({
      ...baseOrder,
      refundedAmountCents: 10000,
      status: "CANCELLED",
    });
    expect(badges.isPartialRefund).toBe(false);
  });

  it("statusEmailRetrying shows for attempts between 1 and MAX", () => {
    const badges = deriveBadges({
      ...baseOrder,
      statusEmailError: "err",
      statusEmailAttempts: 2,
    });
    expect(badges.statusEmailRetrying).toBe(true);
  });
});
