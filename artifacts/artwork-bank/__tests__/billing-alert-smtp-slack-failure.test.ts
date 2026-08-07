/**
 * Confirms that the SMTP (nodemailer) path of sendBillingAlertNotification
 * renders the Slack error banner in mailArgs.html — mirroring the parallel
 * test that already covers the Resend path in billing-alert-email-fn.test.ts.
 *
 * Coverage:
 *  - SMTP path: sendMail is called (not fetch) when SMTP_HOST is set
 *  - SMTP path + slackFailure: mailArgs.html contains the Slack error string
 *    and the warning banner text ("Slack notification failed")
 *  - SMTP path + slackFailure: long error strings are truncated to 300 chars
 *  - SMTP path: no Slack banner when slackFailure is omitted
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// base-url is imported lazily inside sendBillingAlertNotification; mock it so
// the test environment doesn't need a real Next.js server URL.
vi.mock("@/lib/base-url", () => ({
  getPlatformBaseUrl: () => "https://platform.test",
  getTenantUrl: () => "https://tenant.test/orders",
}));

// Mock nodemailer so no real SMTP connection is made.
const sendMailMock = vi.fn();
const createTransportMock = vi.fn(() => ({ sendMail: sendMailMock }));

vi.mock("nodemailer", () => ({
  default: { createTransport: createTransportMock },
}));

import { sendBillingAlertNotification } from "@/lib/email";

// ── Env-var bookkeeping ────────────────────────────────────────────────────────

const ENV_KEYS = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_SECURE",
  "RESEND_API_KEY",
  "PLATFORM_ADMIN_EMAIL",
  "EMAIL_FROM",
  "EMAIL_FROM_ORDERS",
] as const;

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  sendMailMock.mockReset().mockResolvedValue({ messageId: "smtp-test" });
  createTransportMock.mockClear();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.restoreAllMocks();
});

// ── Shared test data ───────────────────────────────────────────────────────────

const baseArgs = {
  stripeEventId: "evt_smtp_test_001",
  eventType: "customer.subscription.deleted",
  customerId: "cus_smtp_1",
  subscriptionId: "sub_smtp_1",
  reason: "No tenant matched by metadata, customer ID, or subscription ID",
};

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("sendBillingAlertNotification: SMTP transport selected", () => {
  it("calls sendMail (not fetch) when SMTP_HOST is set", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.PLATFORM_ADMIN_EMAIL = "admin@example.com";
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await sendBillingAlertNotification(baseArgs);

    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("sendBillingAlertNotification: SMTP path — slackFailure banner in mailArgs.html", () => {
  beforeEach(() => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.PLATFORM_ADMIN_EMAIL = "admin@example.com";
  });

  it("includes the Slack error string in mailArgs.html when slackFailure is provided", async () => {
    await sendBillingAlertNotification({
      ...baseArgs,
      slackFailure: "invalid_auth",
    });

    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const mailArgs = sendMailMock.mock.calls[0][0];
    expect(mailArgs.html).toContain("invalid_auth");
  });

  it("includes the warning banner text in mailArgs.html when slackFailure is provided", async () => {
    await sendBillingAlertNotification({
      ...baseArgs,
      slackFailure: "token_revoked",
    });

    const mailArgs = sendMailMock.mock.calls[0][0];
    expect(mailArgs.html).toContain("Slack notification failed");
  });

  it("includes both the banner text and the error string together", async () => {
    await sendBillingAlertNotification({
      ...baseArgs,
      slackFailure: "channel_not_found",
    });

    const mailArgs = sendMailMock.mock.calls[0][0];
    expect(mailArgs.html).toContain("Slack notification failed");
    expect(mailArgs.html).toContain("channel_not_found");
  });

  it("truncates a very long slackFailure string to 300 chars in mailArgs.html", async () => {
    const longError = "e".repeat(500);

    await sendBillingAlertNotification({
      ...baseArgs,
      slackFailure: longError,
    });

    const mailArgs = sendMailMock.mock.calls[0][0];
    // The truncated 300-char string must appear; the 301st character must not.
    expect(mailArgs.html).toContain("e".repeat(300));
    expect(mailArgs.html).not.toContain("e".repeat(301));
  });

  it("does NOT include the Slack banner when slackFailure is omitted", async () => {
    await sendBillingAlertNotification(baseArgs);

    const mailArgs = sendMailMock.mock.calls[0][0];
    expect(mailArgs.html).not.toContain("Slack notification failed");
  });

  it("re-throws when sendMail rejects so callers are not silently misled", async () => {
    sendMailMock.mockRejectedValueOnce(new Error("535 Auth failed"));

    await expect(
      sendBillingAlertNotification({ ...baseArgs, slackFailure: "invalid_auth" }),
    ).rejects.toThrow();
  });
});
