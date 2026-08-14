/**
 * Unit tests for sendInquiryEmailFailureSlackNotification.
 *
 * Coverage:
 *  - SLACK_BILLING_ALERTS_CHANNEL not set → resolves ok:true (no-op)
 *  - Successful post → resolves ok:true
 *  - Slack API returns ok:false body → resolves ok:false (logs error, no throw)
 *  - HTTP-level error → resolves ok:false (logs error, no throw)
 *  - Network failure (proxy() rejects) → resolves ok:false (logs error, no throw)
 *  - Message includes gallery name, buyer details, and inquiry ID
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockProxy = vi.hoisted(() =>
  vi.fn<
    (
      integration: string,
      path: string,
      opts: { method: string; body: string },
    ) => Promise<Response>
  >(),
);

vi.mock("@replit/connectors-sdk", () => ({
  ReplitConnectors: vi.fn().mockImplementation(function (this: any) {
    this.proxy = mockProxy;
  }),
}));

import { sendInquiryEmailFailureSlackNotification } from "@/lib/slack";

// ── Helpers ───────────────────────────────────────────────────────────────────

const baseArgs = {
  tenantName: "Jane Smith Studio",
  tenantSlug: "jane-smith",
  buyerName: "Art Buyer",
  buyerEmail: "buyer@example.com",
  artworkTitle: "Blue Mountains",
  inquiryId: "inq-abc123",
};

function okResponse(body: object = { ok: true }) {
  return new Response(JSON.stringify(body), { status: 200 });
}

function errorResponse(
  status: number,
  body: object = { ok: false, error: "some_error" },
) {
  return new Response(JSON.stringify(body), { status });
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.SLACK_BILLING_ALERTS_CHANNEL;
});

afterEach(() => {
  delete process.env.SLACK_BILLING_ALERTS_CHANNEL;
});

// ─────────────────────────────────────────────────────────────────────────────

describe("sendInquiryEmailFailureSlackNotification", () => {
  it("returns ok:true without calling proxy when channel is not configured", async () => {
    const result = await sendInquiryEmailFailureSlackNotification(baseArgs);

    expect(result).toEqual({ ok: true });
    expect(mockProxy).not.toHaveBeenCalled();
  });

  it("returns ok:true on a successful Slack post", async () => {
    process.env.SLACK_BILLING_ALERTS_CHANNEL = "ops-alerts";
    mockProxy.mockResolvedValueOnce(okResponse());

    const result = await sendInquiryEmailFailureSlackNotification(baseArgs);

    expect(result).toEqual({ ok: true });
    expect(mockProxy).toHaveBeenCalledOnce();
  });

  it("posts to the configured channel", async () => {
    process.env.SLACK_BILLING_ALERTS_CHANNEL = "gallery-ops";
    mockProxy.mockResolvedValueOnce(okResponse());

    await sendInquiryEmailFailureSlackNotification(baseArgs);

    const call = mockProxy.mock.calls[0];
    const body = JSON.parse(call![2].body as string);
    expect(body.channel).toBe("gallery-ops");
  });

  it("message includes gallery name, buyer details, artwork title, and inquiry ID", async () => {
    process.env.SLACK_BILLING_ALERTS_CHANNEL = "ops-alerts";
    mockProxy.mockResolvedValueOnce(okResponse());

    await sendInquiryEmailFailureSlackNotification(baseArgs);

    const call = mockProxy.mock.calls[0];
    const body = JSON.parse(call![2].body as string);
    expect(body.text).toContain("Jane Smith Studio");
    expect(body.text).toContain("Art Buyer");
    expect(body.text).toContain("buyer@example.com");
    expect(body.text).toContain("Blue Mountains");
    expect(body.text).toContain("inq-abc123");
  });

  it("returns ok:false when Slack body contains ok:false", async () => {
    process.env.SLACK_BILLING_ALERTS_CHANNEL = "ops-alerts";
    mockProxy.mockResolvedValueOnce(
      okResponse({ ok: false, error: "invalid_auth" }),
    );
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await sendInquiryEmailFailureSlackNotification(baseArgs);

    expect(result).toEqual({ ok: false, error: "invalid_auth" });
    expect(consoleSpy).toHaveBeenCalled();
  });

  it("returns ok:false on HTTP error without throwing", async () => {
    process.env.SLACK_BILLING_ALERTS_CHANNEL = "ops-alerts";
    mockProxy.mockResolvedValueOnce(errorResponse(500));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await sendInquiryEmailFailureSlackNotification(baseArgs);

    expect(result.ok).toBe(false);
    expect(consoleSpy).toHaveBeenCalled();
  });

  it("returns ok:false when proxy() throws without re-throwing", async () => {
    process.env.SLACK_BILLING_ALERTS_CHANNEL = "ops-alerts";
    mockProxy.mockRejectedValueOnce(new Error("network error"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await sendInquiryEmailFailureSlackNotification(baseArgs);

    expect(result).toEqual({ ok: false, error: "network error" });
    expect(consoleSpy).toHaveBeenCalled();
  });
});
