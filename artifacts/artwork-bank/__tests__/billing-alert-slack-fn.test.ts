/**
 * Unit-tests sendBillingAlertSlackNotification directly (not through the webhook).
 *
 * Coverage:
 *  - SLACK_BILLING_ALERTS_CHANNEL not set → resolves without throwing (no-op)
 *  - Successful Slack post → resolves without logging an error
 *  - Token-refresh scenario: the Replit connectors SDK handles OAuth token rotation
 *    transparently; from the perspective of this function the proxy() call just
 *    succeeds, so re-running after a rotation must still deliver the message.
 *  - Hard auth failure (invalid_auth body) → resolves without throwing (logs error)
 *  - HTTP-level error (non-ok status) → resolves without throwing (logs error)
 *  - Network failure (proxy() rejects) → resolves without throwing (logs error)
 *  - Channel routing:
 *      SLACK_CHANNEL_INVOICE_FAILED overrides for invoice.payment_failed
 *      SLACK_CHANNEL_SUBSCRIPTION_EVENTS overrides for customer.subscription.*
 *      SLACK_BILLING_ALERTS_CHANNEL used as fallback
 *
 * Token-refresh rationale
 * -----------------------
 * The Replit connectors SDK rotates the OAuth access token behind the scenes
 * before each proxy() call when the token is near expiry, and retries once if
 * it receives a 401.  From this function's point of view the proxy() call either
 * succeeds (token was valid or was transparently refreshed) or throws / returns
 * an error response (the refresh itself failed — a permanent auth error).
 *
 * The tests below simulate both outcomes so we know:
 *   1. After a transparent refresh the message is still delivered (success path).
 *   2. After a permanent auth failure the function still resolves without throwing,
 *      ensuring the webhook handler can always return 200 to Stripe.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

// vi.hoisted ensures mockProxy is defined before the vi.mock() factory runs.
const mockProxy = vi.hoisted(() =>
  vi.fn<(integration: string, path: string, opts: { method: string; body: string }) => Promise<Response>>(),
);

vi.mock("@replit/connectors-sdk", () => ({
  ReplitConnectors: vi.fn().mockImplementation(function (this: any) {
    this.proxy = mockProxy;
  }),
}));

vi.mock("@/lib/base-url", () => ({
  getPlatformBaseUrl: vi.fn().mockReturnValue("https://platform.test"),
}));

import { sendBillingAlertSlackNotification } from "@/lib/slack";

// ── Helpers ───────────────────────────────────────────────────────────────────

const baseArgs = {
  stripeEventId: "evt_test_001",
  eventType: "customer.subscription.updated",
  customerId: "cus_test_1",
  subscriptionId: "sub_test_1",
  reason: "No tenant matched",
};

function okResponse(body: object = { ok: true }) {
  return new Response(JSON.stringify(body), { status: 200 });
}

function errorResponse(status: number, body: object = { ok: false, error: "some_error" }) {
  return new Response(JSON.stringify(body), { status });
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.SLACK_BILLING_ALERTS_CHANNEL;
  delete process.env.SLACK_CHANNEL_INVOICE_FAILED;
  delete process.env.SLACK_CHANNEL_SUBSCRIPTION_EVENTS;
});

afterEach(() => {
  delete process.env.SLACK_BILLING_ALERTS_CHANNEL;
  delete process.env.SLACK_CHANNEL_INVOICE_FAILED;
  delete process.env.SLACK_CHANNEL_SUBSCRIPTION_EVENTS;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("sendBillingAlertSlackNotification: channel guard", () => {
  it("is a no-op and resolves when SLACK_BILLING_ALERTS_CHANNEL is not set", async () => {
    await expect(sendBillingAlertSlackNotification(baseArgs)).resolves.toMatchObject({ ok: true });
    expect(mockProxy).not.toHaveBeenCalled();
  });

  it("is a no-op for invoice.payment_failed when no channel is configured", async () => {
    await expect(
      sendBillingAlertSlackNotification({ ...baseArgs, eventType: "invoice.payment_failed" }),
    ).resolves.toMatchObject({ ok: true });
    expect(mockProxy).not.toHaveBeenCalled();
  });
});

describe("sendBillingAlertSlackNotification: success path", () => {
  beforeEach(() => {
    process.env.SLACK_BILLING_ALERTS_CHANNEL = "#billing-alerts";
  });

  it("posts to the correct Slack endpoint when channel is set", async () => {
    mockProxy.mockResolvedValueOnce(okResponse());

    await sendBillingAlertSlackNotification(baseArgs);

    expect(mockProxy).toHaveBeenCalledTimes(1);
    const [integration, path] = mockProxy.mock.calls[0];
    expect(integration).toBe("slack");
    expect(path).toBe("/chat.postMessage");
  });

  it("sends the correct channel and a message containing the event type", async () => {
    mockProxy.mockResolvedValueOnce(okResponse());

    await sendBillingAlertSlackNotification(baseArgs);

    const [, , options] = mockProxy.mock.calls[0];
    const body = JSON.parse(options.body as string);
    expect(body.channel).toBe("#billing-alerts");
    expect(body.text).toContain(baseArgs.eventType);
  });

  it("resolves with { ok: true } on a successful post", async () => {
    mockProxy.mockResolvedValueOnce(okResponse());

    await expect(sendBillingAlertSlackNotification(baseArgs)).resolves.toMatchObject({ ok: true });
  });
});

describe("sendBillingAlertSlackNotification: token-refresh scenario", () => {
  /**
   * The Replit connectors SDK rotates the OAuth token transparently before
   * calling the Slack API.  After a token rotation the proxy() call resolves
   * with a 200 { ok: true } response just like any other successful call.
   *
   * These tests verify the function behaves correctly across multiple invocations
   * that span a simulated token rotation (first call → old token, second call
   * → refreshed token, both succeed from this function's perspective).
   */

  beforeEach(() => {
    process.env.SLACK_BILLING_ALERTS_CHANNEL = "#billing-alerts";
  });

  it("delivers a message on the first call (before any rotation)", async () => {
    mockProxy.mockResolvedValueOnce(okResponse());

    await expect(sendBillingAlertSlackNotification(baseArgs)).resolves.toMatchObject({ ok: true });
    expect(mockProxy).toHaveBeenCalledTimes(1);
  });

  it("still delivers a message on a subsequent call after token rotation (SDK transparent refresh)", async () => {
    // Simulate two successive smoke-test runs.
    // Between runs the SDK refreshed the token; proxy() still returns 200 { ok: true }
    // because the refresh was transparent.
    mockProxy
      .mockResolvedValueOnce(okResponse()) // first smoke run
      .mockResolvedValueOnce(okResponse()); // second smoke run (post token rotation)

    await sendBillingAlertSlackNotification({ ...baseArgs, stripeEventId: "evt_run1" });
    await sendBillingAlertSlackNotification({ ...baseArgs, stripeEventId: "evt_run2" });

    expect(mockProxy).toHaveBeenCalledTimes(2);

    // Both calls must target the same channel — channel resolution must be
    // stable across invocations.
    const body1 = JSON.parse(mockProxy.mock.calls[0][2].body as string);
    const body2 = JSON.parse(mockProxy.mock.calls[1][2].body as string);
    expect(body1.channel).toBe("#billing-alerts");
    expect(body2.channel).toBe("#billing-alerts");
  });

  it("resolves with { ok: false } even when the SDK cannot refresh the token (permanent auth failure)", async () => {
    /**
     * If the SDK exhausts its refresh attempts it surfaces a Slack API error
     * via the response body { ok: false, error: "invalid_auth" }.
     * The function must still resolve (not throw) so the webhook handler can
     * return 200 to Stripe, and must return { ok: false } so the caller can
     * escalate via the operator email.
     */
    mockProxy.mockResolvedValueOnce(
      errorResponse(200, { ok: false, error: "invalid_auth" }),
    );

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await sendBillingAlertSlackNotification(baseArgs);
    expect(result).toMatchObject({ ok: false, error: "invalid_auth" });

    // The error must be logged so the operator knows the channel is broken.
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[Billing alert Slack] Post failed"),
      expect.stringContaining("invalid_auth"),
    );

    consoleErrorSpy.mockRestore();
  });

  it("delivers a message on the very next call after a one-off token-refresh failure", async () => {
    /**
     * Transient scenario: first call hits an expired-token window and Slack
     * returns invalid_auth; the SDK refreshes and the next call succeeds.
     * (From this function's view: first call → error body, second call → ok.)
     */
    mockProxy
      .mockResolvedValueOnce(errorResponse(200, { ok: false, error: "invalid_auth" }))
      .mockResolvedValueOnce(okResponse());

    vi.spyOn(console, "error").mockImplementation(() => {});

    // First call logs and returns { ok: false }
    const r1 = await sendBillingAlertSlackNotification({ ...baseArgs, stripeEventId: "evt_stale" });
    expect(r1).toMatchObject({ ok: false });

    // Second call (after SDK-level token rotation) succeeds cleanly
    const r2 = await sendBillingAlertSlackNotification({ ...baseArgs, stripeEventId: "evt_refreshed" });
    expect(r2).toMatchObject({ ok: true });

    expect(mockProxy).toHaveBeenCalledTimes(2);

    vi.restoreAllMocks();
  });
});

describe("sendBillingAlertSlackNotification: error resilience", () => {
  beforeEach(() => {
    process.env.SLACK_BILLING_ALERTS_CHANNEL = "#billing-alerts";
  });

  it("resolves with { ok: false } when the HTTP status is non-ok", async () => {
    mockProxy.mockResolvedValueOnce(errorResponse(500));

    await expect(sendBillingAlertSlackNotification(baseArgs)).resolves.toMatchObject({ ok: false });
  });

  it("logs an error when the HTTP status is non-ok", async () => {
    mockProxy.mockResolvedValueOnce(errorResponse(500, { ok: false, error: "server_error" }));

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await sendBillingAlertSlackNotification(baseArgs);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[Billing alert Slack] Post failed"),
      expect.stringContaining("server_error"),
    );

    consoleErrorSpy.mockRestore();
  });

  it("resolves with { ok: false } when proxy() itself rejects (network error)", async () => {
    mockProxy.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    await expect(sendBillingAlertSlackNotification(baseArgs)).resolves.toMatchObject({ ok: false });
  });

  it("logs the network error message when proxy() rejects", async () => {
    mockProxy.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await sendBillingAlertSlackNotification(baseArgs);

    // The implementation interpolates eventId + error message into a single string arg.
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[Billing alert Slack] Failed to post message for eventId="),
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("ECONNREFUSED"),
    );

    consoleErrorSpy.mockRestore();
  });

  it("resolves with { ok: true } when the response body is not JSON but status is 200", async () => {
    mockProxy.mockResolvedValueOnce(new Response("not json", { status: 200 }));

    await expect(sendBillingAlertSlackNotification(baseArgs)).resolves.toMatchObject({ ok: true });
  });
});

describe("resolveSlackChannel: empty / whitespace-only overrides", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SLACK_BILLING_ALERTS_CHANNEL;
    delete process.env.SLACK_CHANNEL_INVOICE_FAILED;
    delete process.env.SLACK_CHANNEL_SUBSCRIPTION_EVENTS;
  });

  afterEach(() => {
    delete process.env.SLACK_BILLING_ALERTS_CHANNEL;
    delete process.env.SLACK_CHANNEL_INVOICE_FAILED;
    delete process.env.SLACK_CHANNEL_SUBSCRIPTION_EVENTS;
  });

  it("falls back to SLACK_BILLING_ALERTS_CHANNEL when SLACK_CHANNEL_INVOICE_FAILED is an empty string", async () => {
    process.env.SLACK_CHANNEL_INVOICE_FAILED = "";
    process.env.SLACK_BILLING_ALERTS_CHANNEL = "#billing-alerts";
    mockProxy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await sendBillingAlertSlackNotification({ ...baseArgs, eventType: "invoice.payment_failed" });

    const body = JSON.parse(mockProxy.mock.calls[0][2].body as string);
    expect(body.channel).toBe("#billing-alerts");
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("SLACK_CHANNEL_INVOICE_FAILED"));
    consoleSpy.mockRestore();
  });

  it("falls back to SLACK_BILLING_ALERTS_CHANNEL when SLACK_CHANNEL_INVOICE_FAILED is whitespace-only", async () => {
    process.env.SLACK_CHANNEL_INVOICE_FAILED = "   ";
    process.env.SLACK_BILLING_ALERTS_CHANNEL = "#billing-alerts";
    mockProxy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await sendBillingAlertSlackNotification({ ...baseArgs, eventType: "invoice.payment_failed" });

    const body = JSON.parse(mockProxy.mock.calls[0][2].body as string);
    expect(body.channel).toBe("#billing-alerts");
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("SLACK_CHANNEL_INVOICE_FAILED"));
    consoleSpy.mockRestore();
  });

  it("falls back to SLACK_BILLING_ALERTS_CHANNEL when SLACK_CHANNEL_SUBSCRIPTION_EVENTS is an empty string", async () => {
    process.env.SLACK_CHANNEL_SUBSCRIPTION_EVENTS = "";
    process.env.SLACK_BILLING_ALERTS_CHANNEL = "#billing-alerts";
    mockProxy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await sendBillingAlertSlackNotification({ ...baseArgs, eventType: "customer.subscription.updated" });

    const body = JSON.parse(mockProxy.mock.calls[0][2].body as string);
    expect(body.channel).toBe("#billing-alerts");
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("SLACK_CHANNEL_SUBSCRIPTION_EVENTS"));
    consoleSpy.mockRestore();
  });

  it("falls back to SLACK_BILLING_ALERTS_CHANNEL when SLACK_CHANNEL_SUBSCRIPTION_EVENTS is whitespace-only", async () => {
    process.env.SLACK_CHANNEL_SUBSCRIPTION_EVENTS = "  ";
    process.env.SLACK_BILLING_ALERTS_CHANNEL = "#billing-alerts";
    mockProxy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await sendBillingAlertSlackNotification({ ...baseArgs, eventType: "customer.subscription.deleted" });

    const body = JSON.parse(mockProxy.mock.calls[0][2].body as string);
    expect(body.channel).toBe("#billing-alerts");
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("SLACK_CHANNEL_SUBSCRIPTION_EVENTS"));
    consoleSpy.mockRestore();
  });

  it("is a no-op when SLACK_BILLING_ALERTS_CHANNEL is an empty string", async () => {
    process.env.SLACK_BILLING_ALERTS_CHANNEL = "";

    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await sendBillingAlertSlackNotification(baseArgs);

    expect(result).toMatchObject({ ok: true });
    expect(mockProxy).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("SLACK_BILLING_ALERTS_CHANNEL"));
    consoleSpy.mockRestore();
  });

  it("is a no-op when SLACK_BILLING_ALERTS_CHANNEL is whitespace-only", async () => {
    process.env.SLACK_BILLING_ALERTS_CHANNEL = "   ";

    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await sendBillingAlertSlackNotification(baseArgs);

    expect(result).toMatchObject({ ok: true });
    expect(mockProxy).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("SLACK_BILLING_ALERTS_CHANNEL"));
    consoleSpy.mockRestore();
  });

  it("logs a distinct console.warn (not just console.log) for an empty-string fallback channel", async () => {
    process.env.SLACK_BILLING_ALERTS_CHANNEL = "";

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    await sendBillingAlertSlackNotification(baseArgs);

    // The misconfiguration must surface as a console.warn with an explicit message,
    // not merely a silent no-op, so an operator can grep for it in logs.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("empty or whitespace-only"));

    vi.restoreAllMocks();
  });
});

describe("sendBillingAlertSlackNotification: per-event-type channel routing", () => {
  it("uses SLACK_CHANNEL_INVOICE_FAILED for invoice.payment_failed events", async () => {
    process.env.SLACK_CHANNEL_INVOICE_FAILED = "#invoice-failures";
    process.env.SLACK_BILLING_ALERTS_CHANNEL = "#billing-alerts";
    mockProxy.mockResolvedValueOnce(okResponse());

    await sendBillingAlertSlackNotification({
      ...baseArgs,
      eventType: "invoice.payment_failed",
    });

    const body = JSON.parse(mockProxy.mock.calls[0][2].body as string);
    expect(body.channel).toBe("#invoice-failures");
  });

  it("falls back to SLACK_BILLING_ALERTS_CHANNEL for invoice.payment_failed when override is absent", async () => {
    process.env.SLACK_BILLING_ALERTS_CHANNEL = "#billing-alerts";
    // SLACK_CHANNEL_INVOICE_FAILED intentionally absent
    mockProxy.mockResolvedValueOnce(okResponse());

    await sendBillingAlertSlackNotification({
      ...baseArgs,
      eventType: "invoice.payment_failed",
    });

    const body = JSON.parse(mockProxy.mock.calls[0][2].body as string);
    expect(body.channel).toBe("#billing-alerts");
  });

  it("uses SLACK_CHANNEL_SUBSCRIPTION_EVENTS for customer.subscription.* events", async () => {
    process.env.SLACK_CHANNEL_SUBSCRIPTION_EVENTS = "#subscription-events";
    process.env.SLACK_BILLING_ALERTS_CHANNEL = "#billing-alerts";
    mockProxy.mockResolvedValueOnce(okResponse());

    await sendBillingAlertSlackNotification({
      ...baseArgs,
      eventType: "customer.subscription.deleted",
    });

    const body = JSON.parse(mockProxy.mock.calls[0][2].body as string);
    expect(body.channel).toBe("#subscription-events");
  });

  it("falls back to SLACK_BILLING_ALERTS_CHANNEL for subscription events when override is absent", async () => {
    process.env.SLACK_BILLING_ALERTS_CHANNEL = "#billing-alerts";
    // SLACK_CHANNEL_SUBSCRIPTION_EVENTS intentionally absent
    mockProxy.mockResolvedValueOnce(okResponse());

    await sendBillingAlertSlackNotification({
      ...baseArgs,
      eventType: "customer.subscription.updated",
    });

    const body = JSON.parse(mockProxy.mock.calls[0][2].body as string);
    expect(body.channel).toBe("#billing-alerts");
  });

  it("SLACK_CHANNEL_INVOICE_FAILED takes precedence over SLACK_BILLING_ALERTS_CHANNEL", async () => {
    process.env.SLACK_CHANNEL_INVOICE_FAILED = "#invoice-specific";
    process.env.SLACK_BILLING_ALERTS_CHANNEL = "#generic-alerts";
    mockProxy.mockResolvedValueOnce(okResponse());

    await sendBillingAlertSlackNotification({
      ...baseArgs,
      eventType: "invoice.payment_failed",
    });

    const body = JSON.parse(mockProxy.mock.calls[0][2].body as string);
    expect(body.channel).toBe("#invoice-specific");
  });
});

describe("sendBillingAlertSlackNotification: message content", () => {
  beforeEach(() => {
    process.env.SLACK_BILLING_ALERTS_CHANNEL = "#billing-alerts";
    mockProxy.mockResolvedValue(okResponse());
  });

  it("includes the customer ID in the message when provided", async () => {
    await sendBillingAlertSlackNotification({ ...baseArgs, customerId: "cus_abc123" });

    const body = JSON.parse(mockProxy.mock.calls[0][2].body as string);
    expect(body.text).toContain("cus_abc123");
  });

  it("includes the subscription ID in the message when provided", async () => {
    await sendBillingAlertSlackNotification({ ...baseArgs, subscriptionId: "sub_xyz789" });

    const body = JSON.parse(mockProxy.mock.calls[0][2].body as string);
    expect(body.text).toContain("sub_xyz789");
  });

  it("includes the reason in the message", async () => {
    await sendBillingAlertSlackNotification({ ...baseArgs, reason: "No tenant matched" });

    const body = JSON.parse(mockProxy.mock.calls[0][2].body as string);
    expect(body.text).toContain("No tenant matched");
  });

  it("includes a link to the billing alerts panel when a base URL is configured", async () => {
    await sendBillingAlertSlackNotification(baseArgs);

    const body = JSON.parse(mockProxy.mock.calls[0][2].body as string);
    expect(body.text).toContain("https://platform.test/platform");
  });
});
