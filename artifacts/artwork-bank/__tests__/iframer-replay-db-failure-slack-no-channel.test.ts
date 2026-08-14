/**
 * Unit tests for sendIframerReplayDbFailureSlackNotification — no-channel path.
 *
 * When SLACK_BILLING_ALERTS_CHANNEL is not set the function must:
 *   1. Return { ok: true } without calling the Slack connector at all.
 *   2. Log a console message that identifies the skip reason.
 *
 * These two tests guard against a misconfigured environment surfacing a
 * secondary error on top of the DB failure the function is meant to report.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Mock ReplitConnectors so any accidental call is detectable ────────────────

const mockProxy = vi.hoisted(() => vi.fn());

vi.mock("@replit/connectors-sdk", () => ({
  ReplitConnectors: vi.fn().mockImplementation(function (this: any) {
    this.proxy = mockProxy;
  }),
}));

import { sendIframerReplayDbFailureSlackNotification } from "@/lib/slack";

// ── Setup / teardown ──────────────────────────────────────────────────────────

const ORIGINAL_CHANNEL = process.env.SLACK_BILLING_ALERTS_CHANNEL;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.SLACK_BILLING_ALERTS_CHANNEL;
});

afterEach(() => {
  if (ORIGINAL_CHANNEL !== undefined) {
    process.env.SLACK_BILLING_ALERTS_CHANNEL = ORIGINAL_CHANNEL;
  } else {
    delete process.env.SLACK_BILLING_ALERTS_CHANNEL;
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("sendIframerReplayDbFailureSlackNotification — channel not configured", () => {
  it(
    "returns { ok: true } without calling the Slack connector when SLACK_BILLING_ALERTS_CHANNEL is unset",
    async () => {
      const result = await sendIframerReplayDbFailureSlackNotification({
        tenantId: "tenant-no-channel-test",
      });

      // Must resolve cleanly with ok: true — no secondary error thrown.
      expect(result).toEqual({ ok: true });

      // The Slack connector must never have been called.
      expect(mockProxy).not.toHaveBeenCalled();
    },
  );

  it(
    "logs a console message identifying the skip when SLACK_BILLING_ALERTS_CHANNEL is unset",
    async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await sendIframerReplayDbFailureSlackNotification({
        tenantId: "tenant-log-skip-test",
      });

      // Capture calls before restoring (mockRestore clears recorded calls).
      const calls = logSpy.mock.calls.slice();
      logSpy.mockRestore();

      // At least one console.log call must have occurred.
      expect(calls.length).toBeGreaterThan(0);

      // The logged message must mention the skip reason so operators can
      // identify a misconfigured environment from the server logs.
      const allArgs = calls.flat();
      const hasSkipMessage = allArgs.some(
        (arg) =>
          typeof arg === "string" &&
          arg
            .toLowerCase()
            .includes("slack_billing_alerts_channel"),
      );
      expect(hasSkipMessage).toBe(true);
    },
  );
});
