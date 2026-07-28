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

describe("sendBillingAlertSlackNotification — structured JSON log on failure", () => {
  it("emits a structured JSON log with eventId, channel, and errorType=sdk_throw when the proxy throws", async () => {
    mockProxy.mockRejectedValueOnce(
      new Error("Token refresh failed: OAuth token has expired"),
    );

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await sendBillingAlertSlackNotification(BASE_PARAMS);

    // Find the call whose first argument is a JSON string with our structure.
    const structuredCall = consoleSpy.mock.calls.find((args) => {
      try {
        const parsed = JSON.parse(args[0] as string);
        return parsed.type === "slack_billing_alert_failure";
      } catch {
        return false;
      }
    });

    expect(structuredCall).toBeDefined();
    const parsed = JSON.parse(structuredCall![0] as string);
    expect(parsed).toMatchObject({
      type: "slack_billing_alert_failure",
      eventId: BASE_PARAMS.stripeEventId,
      channel: "#billing-alerts",
      errorType: "sdk_throw",
    });

    consoleSpy.mockRestore();
  });

  it("emits a structured JSON log with errorType=http_error when the proxy returns a non-ok response", async () => {
    mockProxy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: "token_revoked" }), {
        status: 401,
      }),
    );

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await sendBillingAlertSlackNotification(BASE_PARAMS);

    const structuredCall = consoleSpy.mock.calls.find((args) => {
      try {
        const parsed = JSON.parse(args[0] as string);
        return parsed.type === "slack_billing_alert_failure";
      } catch {
        return false;
      }
    });

    expect(structuredCall).toBeDefined();
    const parsed = JSON.parse(structuredCall![0] as string);
    expect(parsed).toMatchObject({
      type: "slack_billing_alert_failure",
      eventId: BASE_PARAMS.stripeEventId,
      channel: "#billing-alerts",
      errorType: "http_error",
    });

    consoleSpy.mockRestore();
  });

  it("does NOT emit a structured failure log when the post succeeds", async () => {
    mockProxy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await sendBillingAlertSlackNotification(BASE_PARAMS);

    const structuredCall = consoleSpy.mock.calls.find((args) => {
      try {
        const parsed = JSON.parse(args[0] as string);
        return parsed.type === "slack_billing_alert_failure";
      } catch {
        return false;
      }
    });

    expect(structuredCall).toBeUndefined();

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

describe("sendBillingAlertSlackNotification — connector reconnect path", () => {
  /**
   * Simulates the Replit connector being temporarily unavailable (e.g. the
   * operator just reconnected / re-authorised the Slack app at the platform
   * level).  The first alert call happens to land while the connector is still
   * not ready and throws "connector not configured".  Once the connector is
   * live, the very next call must succeed and must NOT produce any error log.
   */
  it("returns ok:false on the first call when the connector is not configured", async () => {
    mockProxy.mockRejectedValueOnce(
      new Error("connector not configured"),
    );

    const result = await sendBillingAlertSlackNotification(BASE_PARAMS);

    expect(result).toMatchObject({ ok: false });
    expect(mockProxy).toHaveBeenCalledTimes(1);
  });

  it("succeeds on the next call after the connector becomes available", async () => {
    // First call: connector still unavailable.
    mockProxy.mockRejectedValueOnce(
      new Error("connector not configured"),
    );
    // Second call: connector is now live.
    mockProxy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // First alert — connector not yet ready; should fail gracefully.
    const firstResult = await sendBillingAlertSlackNotification({
      ...BASE_PARAMS,
      stripeEventId: "evt_reconnect_first",
    });
    expect(firstResult).toMatchObject({ ok: false });

    // Reset spy so we can assert the second call is clean.
    consoleSpy.mockClear();

    // Second alert — connector is now reconnected; should succeed.
    const secondResult = await sendBillingAlertSlackNotification({
      ...BASE_PARAMS,
      stripeEventId: "evt_reconnect_second",
    });
    expect(secondResult).toMatchObject({ ok: true });

    // The successful call must not produce any error log.
    expect(consoleSpy).not.toHaveBeenCalled();

    // Both calls must have reached the proxy (not short-circuited before it).
    expect(mockProxy).toHaveBeenCalledTimes(2);

    consoleSpy.mockRestore();
  });

  it("posts to the correct channel on the successful reconnect call", async () => {
    // First call fails; second succeeds.
    mockProxy.mockRejectedValueOnce(new Error("connector not configured"));
    mockProxy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await sendBillingAlertSlackNotification({
      ...BASE_PARAMS,
      stripeEventId: "evt_reconnect_channel_check_1",
    });
    await sendBillingAlertSlackNotification({
      ...BASE_PARAMS,
      stripeEventId: "evt_reconnect_channel_check_2",
    });

    // Inspect the body passed to the second proxy call.
    const secondCallArgs = mockProxy.mock.calls[1];
    const body = JSON.parse(secondCallArgs[2].body as string) as {
      channel: string;
    };
    expect(body.channel).toBe("#billing-alerts");

    consoleSpy.mockRestore();
  });
});
