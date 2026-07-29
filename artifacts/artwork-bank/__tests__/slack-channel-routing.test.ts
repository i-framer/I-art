/**
 * Unit tests for resolveSlackChannel — verifies that each billing-alert event
 * type is routed to the correct Slack channel based on env-var configuration.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the Replit connectors SDK so sendBillingAlertSlackNotification can be
// imported without a real connector present.
vi.mock("@replit/connectors-sdk", () => ({
  ReplitConnectors: vi.fn().mockImplementation(() => ({
    proxy: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    }),
  })),
}));

// base-url is imported lazily inside sendBillingAlertSlackNotification.
vi.mock("@/lib/base-url", () => ({
  getPlatformBaseUrl: () => "https://example.com",
}));

import { resolveSlackChannel } from "@/lib/slack";

// ── Helpers ──────────────────────────────────────────────────────────────────

const ENV_VARS = [
  "SLACK_CHANNEL_INVOICE_FAILED",
  "SLACK_CHANNEL_SUBSCRIPTION_EVENTS",
  "SLACK_BILLING_ALERTS_CHANNEL",
] as const;

function setEnv(vars: Partial<Record<(typeof ENV_VARS)[number], string>>) {
  for (const key of ENV_VARS) {
    if (key in vars) {
      process.env[key] = vars[key as keyof typeof vars];
    } else {
      delete process.env[key];
    }
  }
}

beforeEach(() => {
  // Start each test with a clean slate — no channel env-vars set.
  for (const key of ENV_VARS) delete process.env[key];
  // Reset all spy call counts so they don't accumulate across tests.
  vi.clearAllMocks();
});

afterEach(() => {
  for (const key of ENV_VARS) delete process.env[key];
});

// ── resolveSlackChannel ───────────────────────────────────────────────────────

describe("resolveSlackChannel", () => {
  describe("invoice.payment_failed", () => {
    it("returns SLACK_CHANNEL_INVOICE_FAILED when the override is set", () => {
      setEnv({
        SLACK_CHANNEL_INVOICE_FAILED: "#invoice-alerts",
        SLACK_BILLING_ALERTS_CHANNEL: "#billing-general",
      });
      expect(resolveSlackChannel("invoice.payment_failed")).toBe(
        "#invoice-alerts",
      );
    });

    it("falls back to SLACK_BILLING_ALERTS_CHANNEL when the override is absent", () => {
      setEnv({ SLACK_BILLING_ALERTS_CHANNEL: "#billing-general" });
      expect(resolveSlackChannel("invoice.payment_failed")).toBe(
        "#billing-general",
      );
    });
  });

  describe("customer.subscription.* events", () => {
    it("returns SLACK_CHANNEL_SUBSCRIPTION_EVENTS when the override is set (deleted)", () => {
      setEnv({
        SLACK_CHANNEL_SUBSCRIPTION_EVENTS: "#sub-events",
        SLACK_BILLING_ALERTS_CHANNEL: "#billing-general",
      });
      expect(resolveSlackChannel("customer.subscription.deleted")).toBe(
        "#sub-events",
      );
    });

    it("returns SLACK_CHANNEL_SUBSCRIPTION_EVENTS when the override is set (created)", () => {
      setEnv({
        SLACK_CHANNEL_SUBSCRIPTION_EVENTS: "#sub-events",
        SLACK_BILLING_ALERTS_CHANNEL: "#billing-general",
      });
      expect(resolveSlackChannel("customer.subscription.created")).toBe(
        "#sub-events",
      );
    });

    it("returns SLACK_CHANNEL_SUBSCRIPTION_EVENTS when the override is set (updated)", () => {
      setEnv({
        SLACK_CHANNEL_SUBSCRIPTION_EVENTS: "#sub-events",
        SLACK_BILLING_ALERTS_CHANNEL: "#billing-general",
      });
      expect(resolveSlackChannel("customer.subscription.updated")).toBe(
        "#sub-events",
      );
    });

    it("falls back to SLACK_BILLING_ALERTS_CHANNEL when the subscription override is absent", () => {
      setEnv({ SLACK_BILLING_ALERTS_CHANNEL: "#billing-general" });
      expect(resolveSlackChannel("customer.subscription.deleted")).toBe(
        "#billing-general",
      );
    });
  });

  describe("other event types", () => {
    it("routes an arbitrary event to SLACK_BILLING_ALERTS_CHANNEL", () => {
      setEnv({ SLACK_BILLING_ALERTS_CHANNEL: "#billing-general" });
      expect(resolveSlackChannel("charge.refunded")).toBe("#billing-general");
    });

    it("routes an arbitrary event to SLACK_BILLING_ALERTS_CHANNEL even if per-type overrides are set", () => {
      setEnv({
        SLACK_CHANNEL_INVOICE_FAILED: "#invoice-alerts",
        SLACK_CHANNEL_SUBSCRIPTION_EVENTS: "#sub-events",
        SLACK_BILLING_ALERTS_CHANNEL: "#billing-general",
      });
      expect(resolveSlackChannel("payment_intent.payment_failed")).toBe(
        "#billing-general",
      );
    });
  });

  describe("both per-type overrides set simultaneously", () => {
    it("routes invoice.payment_failed to SLACK_CHANNEL_INVOICE_FAILED, not SLACK_CHANNEL_SUBSCRIPTION_EVENTS", () => {
      setEnv({
        SLACK_CHANNEL_INVOICE_FAILED: "#invoice-alerts",
        SLACK_CHANNEL_SUBSCRIPTION_EVENTS: "#sub-events",
        SLACK_BILLING_ALERTS_CHANNEL: "#billing-general",
      });
      expect(resolveSlackChannel("invoice.payment_failed")).toBe(
        "#invoice-alerts",
      );
    });

    it("routes customer.subscription.deleted to SLACK_CHANNEL_SUBSCRIPTION_EVENTS, not SLACK_CHANNEL_INVOICE_FAILED", () => {
      setEnv({
        SLACK_CHANNEL_INVOICE_FAILED: "#invoice-alerts",
        SLACK_CHANNEL_SUBSCRIPTION_EVENTS: "#sub-events",
        SLACK_BILLING_ALERTS_CHANNEL: "#billing-general",
      });
      expect(resolveSlackChannel("customer.subscription.deleted")).toBe(
        "#sub-events",
      );
    });

    it("routes customer.subscription.created to SLACK_CHANNEL_SUBSCRIPTION_EVENTS, not SLACK_CHANNEL_INVOICE_FAILED", () => {
      setEnv({
        SLACK_CHANNEL_INVOICE_FAILED: "#invoice-alerts",
        SLACK_CHANNEL_SUBSCRIPTION_EVENTS: "#sub-events",
        SLACK_BILLING_ALERTS_CHANNEL: "#billing-general",
      });
      expect(resolveSlackChannel("customer.subscription.created")).toBe(
        "#sub-events",
      );
    });

    it("routes customer.subscription.updated to SLACK_CHANNEL_SUBSCRIPTION_EVENTS, not SLACK_CHANNEL_INVOICE_FAILED", () => {
      setEnv({
        SLACK_CHANNEL_INVOICE_FAILED: "#invoice-alerts",
        SLACK_CHANNEL_SUBSCRIPTION_EVENTS: "#sub-events",
        SLACK_BILLING_ALERTS_CHANNEL: "#billing-general",
      });
      expect(resolveSlackChannel("customer.subscription.updated")).toBe(
        "#sub-events",
      );
    });

    it("does not bleed: invoice channel is distinct from subscription channel", () => {
      setEnv({
        SLACK_CHANNEL_INVOICE_FAILED: "#invoice-alerts",
        SLACK_CHANNEL_SUBSCRIPTION_EVENTS: "#sub-events",
      });
      const invoiceChannel = resolveSlackChannel("invoice.payment_failed");
      const subscriptionChannel = resolveSlackChannel(
        "customer.subscription.deleted",
      );
      expect(invoiceChannel).toBe("#invoice-alerts");
      expect(subscriptionChannel).toBe("#sub-events");
      expect(invoiceChannel).not.toBe(subscriptionChannel);
    });

    it("routes an unrelated event to SLACK_BILLING_ALERTS_CHANNEL even when both overrides are set", () => {
      setEnv({
        SLACK_CHANNEL_INVOICE_FAILED: "#invoice-alerts",
        SLACK_CHANNEL_SUBSCRIPTION_EVENTS: "#sub-events",
        SLACK_BILLING_ALERTS_CHANNEL: "#billing-general",
      });
      expect(resolveSlackChannel("charge.refunded")).toBe("#billing-general");
    });
  });

  describe("empty-string overrides", () => {
    it("falls back to SLACK_BILLING_ALERTS_CHANNEL and warns when SLACK_CHANNEL_INVOICE_FAILED is \"\"", () => {
      setEnv({
        SLACK_CHANNEL_INVOICE_FAILED: "",
        SLACK_BILLING_ALERTS_CHANNEL: "#billing-general",
      });
      const warnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);

      const result = resolveSlackChannel("invoice.payment_failed");

      expect(result).toBe("#billing-general");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("SLACK_CHANNEL_INVOICE_FAILED is set to an empty or whitespace-only string"),
      );
      warnSpy.mockRestore();
    });

    it("falls back to SLACK_BILLING_ALERTS_CHANNEL and warns when SLACK_CHANNEL_SUBSCRIPTION_EVENTS is \"\"", () => {
      setEnv({
        SLACK_CHANNEL_SUBSCRIPTION_EVENTS: "",
        SLACK_BILLING_ALERTS_CHANNEL: "#billing-general",
      });
      const warnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);

      const result = resolveSlackChannel("customer.subscription.deleted");

      expect(result).toBe("#billing-general");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("SLACK_CHANNEL_SUBSCRIPTION_EVENTS is set to an empty or whitespace-only string"),
      );
      warnSpy.mockRestore();
    });

    it("returns undefined and warns when SLACK_CHANNEL_INVOICE_FAILED is \"\" and no fallback is configured", () => {
      setEnv({ SLACK_CHANNEL_INVOICE_FAILED: "" });
      const warnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);

      const result = resolveSlackChannel("invoice.payment_failed");

      expect(result).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("SLACK_CHANNEL_INVOICE_FAILED is set to an empty or whitespace-only string"),
      );
      warnSpy.mockRestore();
    });

    it("returns undefined and warns when SLACK_CHANNEL_SUBSCRIPTION_EVENTS is \"\" and no fallback is configured", () => {
      setEnv({ SLACK_CHANNEL_SUBSCRIPTION_EVENTS: "" });
      const warnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);

      const result = resolveSlackChannel("customer.subscription.updated");

      expect(result).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("SLACK_CHANNEL_SUBSCRIPTION_EVENTS is set to an empty or whitespace-only string"),
      );
      warnSpy.mockRestore();
    });

    it("does not warn when SLACK_CHANNEL_INVOICE_FAILED is a valid non-empty string", () => {
      setEnv({ SLACK_CHANNEL_INVOICE_FAILED: "#invoice-alerts" });
      const warnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);

      resolveSlackChannel("invoice.payment_failed");

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("does not warn when SLACK_CHANNEL_SUBSCRIPTION_EVENTS is a valid non-empty string", () => {
      setEnv({ SLACK_CHANNEL_SUBSCRIPTION_EVENTS: "#sub-events" });
      const warnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);

      resolveSlackChannel("customer.subscription.created");

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe("per-type overrides cleared at runtime", () => {
    it("falls back to SLACK_BILLING_ALERTS_CHANNEL for invoice.payment_failed after SLACK_CHANNEL_INVOICE_FAILED is deleted", () => {
      // Start with both overrides set.
      setEnv({
        SLACK_CHANNEL_INVOICE_FAILED: "#invoice-alerts",
        SLACK_CHANNEL_SUBSCRIPTION_EVENTS: "#sub-events",
        SLACK_BILLING_ALERTS_CHANNEL: "#billing-general",
      });

      // Confirm the override is active.
      expect(resolveSlackChannel("invoice.payment_failed")).toBe(
        "#invoice-alerts",
      );

      // Clear the per-type override at runtime.
      delete process.env.SLACK_CHANNEL_INVOICE_FAILED;

      // Must fall back to the general channel on the very next call.
      expect(resolveSlackChannel("invoice.payment_failed")).toBe(
        "#billing-general",
      );
    });

    it("falls back to SLACK_BILLING_ALERTS_CHANNEL for customer.subscription.deleted after SLACK_CHANNEL_SUBSCRIPTION_EVENTS is deleted", () => {
      // Start with both overrides set.
      setEnv({
        SLACK_CHANNEL_INVOICE_FAILED: "#invoice-alerts",
        SLACK_CHANNEL_SUBSCRIPTION_EVENTS: "#sub-events",
        SLACK_BILLING_ALERTS_CHANNEL: "#billing-general",
      });

      // Confirm the override is active.
      expect(resolveSlackChannel("customer.subscription.deleted")).toBe(
        "#sub-events",
      );

      // Clear the per-type override at runtime.
      delete process.env.SLACK_CHANNEL_SUBSCRIPTION_EVENTS;

      // Must fall back to the general channel on the very next call.
      expect(resolveSlackChannel("customer.subscription.deleted")).toBe(
        "#billing-general",
      );
    });

    it("falls back to SLACK_BILLING_ALERTS_CHANNEL for both event types after both overrides are cleared", () => {
      // Start with both overrides set.
      setEnv({
        SLACK_CHANNEL_INVOICE_FAILED: "#invoice-alerts",
        SLACK_CHANNEL_SUBSCRIPTION_EVENTS: "#sub-events",
        SLACK_BILLING_ALERTS_CHANNEL: "#billing-general",
      });

      // Confirm both overrides are active before clearing.
      expect(resolveSlackChannel("invoice.payment_failed")).toBe(
        "#invoice-alerts",
      );
      expect(resolveSlackChannel("customer.subscription.deleted")).toBe(
        "#sub-events",
      );

      // Clear both per-type overrides at runtime.
      delete process.env.SLACK_CHANNEL_INVOICE_FAILED;
      delete process.env.SLACK_CHANNEL_SUBSCRIPTION_EVENTS;

      // Both event types must fall back to the general channel.
      expect(resolveSlackChannel("invoice.payment_failed")).toBe(
        "#billing-general",
      );
      expect(resolveSlackChannel("customer.subscription.deleted")).toBe(
        "#billing-general",
      );
    });

    it("does not cache the resolved channel between calls — re-reads env vars each invocation", () => {
      setEnv({
        SLACK_CHANNEL_INVOICE_FAILED: "#invoice-alerts",
        SLACK_BILLING_ALERTS_CHANNEL: "#billing-general",
      });

      // First call uses the override.
      expect(resolveSlackChannel("invoice.payment_failed")).toBe(
        "#invoice-alerts",
      );

      // Simulate a runtime config change by swapping the override value.
      process.env.SLACK_CHANNEL_INVOICE_FAILED = "#invoice-alerts-v2";

      // Second call must reflect the new value without any module reload.
      expect(resolveSlackChannel("invoice.payment_failed")).toBe(
        "#invoice-alerts-v2",
      );

      // Clear the override — third call must see the fallback.
      delete process.env.SLACK_CHANNEL_INVOICE_FAILED;

      expect(resolveSlackChannel("invoice.payment_failed")).toBe(
        "#billing-general",
      );
    });
  });

  describe("no channel configured", () => {
    it("returns undefined when no channel env-vars are set", () => {
      expect(resolveSlackChannel("invoice.payment_failed")).toBeUndefined();
    });

    it("returns undefined for a subscription event when no channel env-vars are set", () => {
      expect(
        resolveSlackChannel("customer.subscription.deleted"),
      ).toBeUndefined();
    });

    it("returns undefined for an arbitrary event when no channel env-vars are set", () => {
      expect(resolveSlackChannel("charge.refunded")).toBeUndefined();
    });
  });
});

// ── No-op behaviour when no channel is configured ────────────────────────────
// Tests sendBillingAlertSlackNotification skips posting and logs when undefined.

describe("sendBillingAlertSlackNotification — no channel configured", () => {
  it("skips posting and logs when no channel is set", async () => {
    // All channel env-vars already cleared in beforeEach.
    const { sendBillingAlertSlackNotification } = await import("@/lib/slack");
    const consoleSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    await sendBillingAlertSlackNotification({
      stripeEventId: "evt_test_1",
      eventType: "invoice.payment_failed",
      customerId: "cus_1",
      subscriptionId: null,
      reason: "payment declined",
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Billing alert Slack skipped"),
    );
    consoleSpy.mockRestore();
  });
});
