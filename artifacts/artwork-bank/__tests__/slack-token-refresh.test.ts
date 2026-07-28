/**
 * Tests for sendBillingAlertSlackNotification behaviour when the Replit
 * Connectors SDK throws a token-refresh-style error mid-flight.
 *
 * Covers two scenarios from the task spec:
 *
 * 1. The proxy call throws on the first attempt — the function must not
 *    re-throw so the webhook handler can always return 200 to Stripe.
 * 2. The error is logged with enough detail (eventId + error message) so
 *    that ops can identify and replay the missed alert.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── ReplitConnectors mock ─────────────────────────────────────────────────────
// Must use a regular function (not an arrow function) so that `new ReplitConnectors()`
// works correctly — arrow functions cannot be constructors.

const mockProxy = vi.hoisted(() => vi.fn());

vi.mock("@replit/connectors-sdk", () => ({
  ReplitConnectors: vi.fn().mockImplementation(function (this: any) {
    this.proxy = mockProxy;
  }),
}));

// ── base-url mock ─────────────────────────────────────────────────────────────
vi.mock("@/lib/base-url", () => ({
  getPlatformBaseUrl: vi.fn().mockReturnValue("https://example.com"),
}));

// ── Import the module under test ──────────────────────────────────────────────
import { sendBillingAlertSlackNotification } from "@/lib/slack";

// ── Shared test parameters ────────────────────────────────────────────────────
const BASE_PARAMS = {
  stripeEventId: "evt_tok_refresh_test_1",
  eventType: "customer.subscription.updated",
  customerId: "cus_test_1",
  subscriptionId: "sub_test_1",
  reason: "No matching tenant found",
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SLACK_BILLING_ALERTS_CHANNEL = "#billing-alerts";
});

afterEach(() => {
  delete process.env.SLACK_BILLING_ALERTS_CHANNEL;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("sendBillingAlertSlackNotification — token-refresh error handling", () => {
  it("does not re-throw when the proxy throws a token-refresh error", async () => {
    mockProxy.mockRejectedValueOnce(
      new Error("Token refresh failed: OAuth token has expired"),
    );

    // Must resolve without throwing — the webhook handler must never see this.
    const result = await sendBillingAlertSlackNotification(BASE_PARAMS);
    expect(result).toMatchObject({ ok: false });
  });

  it("logs the stripeEventId alongside the error message so ops can replay the event", async () => {
    mockProxy.mockRejectedValueOnce(
      new Error("Token refresh failed: OAuth token has expired"),
    );

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await sendBillingAlertSlackNotification(BASE_PARAMS);

    // The catch block interpolates everything into a single string argument.
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining(BASE_PARAMS.stripeEventId),
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Token refresh failed"),
    );

    consoleSpy.mockRestore();
  });

  it("logs the eventId even when the proxy throws an error with no message", async () => {
    mockProxy.mockRejectedValueOnce(new Error(""));

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await sendBillingAlertSlackNotification(BASE_PARAMS);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining(BASE_PARAMS.stripeEventId),
    );

    consoleSpy.mockRestore();
  });

  it("logs the eventId when the proxy rejects with a non-Error object", async () => {
    // Some SDK versions surface auth errors as plain string rejections.
    mockProxy.mockRejectedValueOnce("auth/token-refresh-required");

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await sendBillingAlertSlackNotification(BASE_PARAMS);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining(BASE_PARAMS.stripeEventId),
    );

    consoleSpy.mockRestore();
  });
});

describe("sendBillingAlertSlackNotification — successful post after token is refreshed", () => {
  it("succeeds and does NOT log an error when the proxy call resolves normally", async () => {
    mockProxy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await sendBillingAlertSlackNotification(BASE_PARAMS);

    // A clean proxy response must not produce any error logs.
    expect(consoleSpy).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it("logs an HTTP-failure message (not a throw) when the proxy returns ok=false with a 401", async () => {
    // Simulates a token expiry surfaced as HTTP 401 rather than a thrown error.
    mockProxy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: "token_revoked" }), {
        status: 401,
      }),
    );

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await sendBillingAlertSlackNotification(BASE_PARAMS);
    expect(result).toMatchObject({ ok: false });

    // The non-ok HTTP path logs "[Billing alert Slack] Post failed (HTTP N):" + error.
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("401"),
      expect.anything(),
    );

    consoleSpy.mockRestore();
  });
});

describe("sendBillingAlertSlackNotification — no-op when channel is not configured", () => {
  it("skips silently when SLACK_BILLING_ALERTS_CHANNEL is unset", async () => {
    delete process.env.SLACK_BILLING_ALERTS_CHANNEL;

    await expect(
      sendBillingAlertSlackNotification(BASE_PARAMS),
    ).resolves.toMatchObject({ ok: true });

    // Proxy must not have been called.
    expect(mockProxy).not.toHaveBeenCalled();
  });
});
