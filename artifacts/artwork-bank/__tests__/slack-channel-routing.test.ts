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
        expect.stringContaining("SLACK_CHANNEL_INVOICE_FAILED is set to an empty string"),
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
        expect.stringContaining("SLACK_CHANNEL_SUBSCRIPTION_EVENTS is set to an empty string"),
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
        expect.stringContaining("SLACK_CHANNEL_INVOICE_FAILED is set to an empty string"),
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
        expect.stringContaining("SLACK_CHANNEL_SUBSCRIPTION_EVENTS is set to an empty string"),
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
