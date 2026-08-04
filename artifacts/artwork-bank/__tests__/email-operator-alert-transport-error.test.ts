/**
 * Task #365 — Confirm operator alert emails are re-sent when the transport
 * comes back online after a temporary outage.
 *
 * Specifically tests the "surfacing" requirement: a transient transport error
 * (SMTP throws, Resend network failure) must NOT be silently swallowed by the
 * four operator alert email functions.  When the transport is back online the
 * caller can retry; it can only do that if the failure is visible.
 *
 * Coverage:
 *  sendSchemaPushFailureEmail   — returns false (error surfaced via return val)
 *  sendDriftFailureEmail        — returns false (error surfaced via return val)
 *  sendOrphanSweepErrorNotification — re-throws so the caller is notified
 *  sendBillingAlertNotification     — re-throws so the caller is notified
 *
 * In all cases the transport error is also written to console.error so
 * a monitoring system watching for error-level log lines can alert.
 *
 * Config-missing (no SMTP_HOST, no RESEND_API_KEY, or no PLATFORM_ADMIN_EMAIL)
 * is NOT a transient error — those paths still return silently because there is
 * nothing to retry.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Transport mocks ────────────────────────────────────────────────────────────

// SMTP — throws a transient ECONNREFUSED from the sendMail call
const mockSendMail = vi.fn();
vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn().mockReturnValue({ sendMail: mockSendMail }),
  },
}));

// Resend — we intercept fetch so we can simulate network-level failures
// (distinct from API-level 4xx which is covered by wrong-key tests)
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// base-url is lazily imported inside sendBillingAlertNotification
vi.mock("@/lib/base-url", () => ({
  getPlatformBaseUrl: () => "https://platform.test",
}));

// ── Environment helpers ────────────────────────────────────────────────────────
const ALL_KEYS = [
  "SMTP_HOST",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_PORT",
  "RESEND_API_KEY",
  "PLATFORM_ADMIN_EMAIL",
] as const;
const savedEnv: Record<string, string | undefined> = {};

function saveEnv() {
  for (const k of ALL_KEYS) savedEnv[k] = process.env[k];
}

function restoreEnv() {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v as string;
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k];
}

/** SMTP configured, no Resend key. */
function setSmtpEnv() {
  process.env.SMTP_HOST = "smtp.test.local";
  process.env.SMTP_USER = "user@test.local";
  process.env.SMTP_PASS = "pass";
  process.env.SMTP_PORT = "587";
  process.env.PLATFORM_ADMIN_EMAIL = "admin@test.local";
  delete process.env.RESEND_API_KEY;
}

/** Resend configured, no SMTP. */
function setResendEnv() {
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  delete process.env.SMTP_PORT;
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.PLATFORM_ADMIN_EMAIL = "admin@test.local";
}

/** Make the SMTP transport throw a transient connection error. */
function smtpNetworkError() {
  mockSendMail.mockRejectedValue(new Error("connect ECONNREFUSED smtp.test.local:587"));
}

/** Make fetch simulate a Resend network-level failure (not an HTTP error). */
function resendNetworkError() {
  mockFetch.mockRejectedValue(new Error("fetch failed: ECONNRESET"));
}

// ─────────────────────────────────────────────────────────────────────────────

import {
  sendSchemaPushFailureEmail,
  sendDriftFailureEmail,
  sendOrphanSweepErrorNotification,
  sendBillingAlertNotification,
} from "@/lib/email";

let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  saveEnv();
  vi.clearAllMocks();
  consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleSpy.mockRestore();
  restoreEnv();
});

// ── sendSchemaPushFailureEmail ─────────────────────────────────────────────────

describe("sendSchemaPushFailureEmail — transient transport error surfacing", () => {
  it("returns false (not true) when SMTP throws a connection error", async () => {
    setSmtpEnv();
    smtpNetworkError();

    const result = await sendSchemaPushFailureEmail({ errorText: "push failed" });
    // false signals 'delivery failed' to the caller (scripts/notify-schema-push-failure.ts)
    expect(result).toBe(false);
  });

  it("returns false (not true) when Resend fetch throws a network error", async () => {
    setResendEnv();
    resendNetworkError();

    const result = await sendSchemaPushFailureEmail({ errorText: "push failed" });
    expect(result).toBe(false);
  });

  it("logs the SMTP transport error via console.error before returning false", async () => {
    setSmtpEnv();
    smtpNetworkError();

    await sendSchemaPushFailureEmail({ errorText: "push failed" });

    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[Schema push alert email] Failed to send operator notification:"),
      expect.stringContaining("ECONNREFUSED"),
    );
  });

  it("logs the Resend network error via console.error before returning false", async () => {
    setResendEnv();
    resendNetworkError();

    await sendSchemaPushFailureEmail({ errorText: "push failed" });

    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[Schema push alert email] Failed to send operator notification:"),
      expect.stringContaining("ECONNRESET"),
    );
  });

  it("does not throw even when the transport fails (non-fatal for caller)", async () => {
    setSmtpEnv();
    smtpNetworkError();

    // The post-merge script must never throw — it owns the exit code
    await expect(
      sendSchemaPushFailureEmail({ errorText: "push failed" }),
    ).resolves.toBe(false);
  });
});

// ── sendDriftFailureEmail ──────────────────────────────────────────────────────

describe("sendDriftFailureEmail — transient transport error surfacing", () => {
  it("returns false (not true) when SMTP throws a connection error", async () => {
    setSmtpEnv();
    smtpNetworkError();

    const result = await sendDriftFailureEmail({ errorText: "drift detected" });
    expect(result).toBe(false);
  });

  it("returns false (not true) when Resend fetch throws a network error", async () => {
    setResendEnv();
    resendNetworkError();

    const result = await sendDriftFailureEmail({ errorText: "drift detected" });
    expect(result).toBe(false);
  });

  it("logs the SMTP transport error via console.error before returning false", async () => {
    setSmtpEnv();
    smtpNetworkError();

    await sendDriftFailureEmail({ errorText: "drift detected" });

    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[Drift alert email] Failed to send operator notification:"),
      expect.stringContaining("ECONNREFUSED"),
    );
  });

  it("logs the Resend network error via console.error before returning false", async () => {
    setResendEnv();
    resendNetworkError();

    await sendDriftFailureEmail({ errorText: "drift detected" });

    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[Drift alert email] Failed to send operator notification:"),
      expect.stringContaining("ECONNRESET"),
    );
  });

  it("does not throw even when the transport fails (non-fatal for caller)", async () => {
    setSmtpEnv();
    smtpNetworkError();

    await expect(
      sendDriftFailureEmail({ errorText: "drift detected" }),
    ).resolves.toBe(false);
  });
});

// ── sendOrphanSweepErrorNotification ──────────────────────────────────────────

describe("sendOrphanSweepErrorNotification — transient transport error surfacing", () => {
  it("re-throws when SMTP throws a connection error (caller must catch)", async () => {
    setSmtpEnv();
    smtpNetworkError();

    await expect(
      sendOrphanSweepErrorNotification({ errors: 3, failedPaths: ["/uploads/a.jpg"] }),
    ).rejects.toThrow("ECONNREFUSED");
  });

  it("re-throws when Resend fetch throws a network error (caller must catch)", async () => {
    setResendEnv();
    resendNetworkError();

    await expect(
      sendOrphanSweepErrorNotification({ errors: 1, failedPaths: ["/uploads/b.jpg"] }),
    ).rejects.toThrow("ECONNRESET");
  });

  it("logs the SMTP transport error via console.error before re-throwing", async () => {
    setSmtpEnv();
    smtpNetworkError();

    await expect(
      sendOrphanSweepErrorNotification({ errors: 2, failedPaths: ["/uploads/c.jpg"] }),
    ).rejects.toThrow();

    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[Orphan sweep email] Failed to send operator notification:"),
      expect.stringContaining("ECONNREFUSED"),
    );
  });

  it("logs the Resend network error via console.error before re-throwing", async () => {
    setResendEnv();
    resendNetworkError();

    await expect(
      sendOrphanSweepErrorNotification({ errors: 2, failedPaths: [] }),
    ).rejects.toThrow();

    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[Orphan sweep email] Failed to send operator notification:"),
      expect.stringContaining("ECONNRESET"),
    );
  });

  it("still returns without throwing when transport is not configured (config-missing is not a transient error)", async () => {
    // Neither SMTP_HOST nor RESEND_API_KEY — this is a config-missing skip, not a transport failure
    delete process.env.SMTP_HOST;
    delete process.env.RESEND_API_KEY;
    process.env.PLATFORM_ADMIN_EMAIL = "admin@test.local";

    await expect(
      sendOrphanSweepErrorNotification({ errors: 1, failedPaths: [] }),
    ).resolves.toBeUndefined();
  });
});

// ── sendBillingAlertNotification ───────────────────────────────────────────────

const BILLING_ARGS = {
  stripeEventId: "evt_test_transport_001",
  eventType: "customer.subscription.deleted",
  customerId: "cus_test_1",
  reason: "No tenant found for customer",
};

describe("sendBillingAlertNotification — transient transport error surfacing", () => {
  it("re-throws when SMTP throws a connection error (caller must catch)", async () => {
    setSmtpEnv();
    smtpNetworkError();

    await expect(
      sendBillingAlertNotification(BILLING_ARGS),
    ).rejects.toThrow("ECONNREFUSED");
  });

  it("re-throws when Resend fetch throws a network error (caller must catch)", async () => {
    setResendEnv();
    resendNetworkError();

    await expect(
      sendBillingAlertNotification(BILLING_ARGS),
    ).rejects.toThrow("ECONNRESET");
  });

  it("logs the SMTP transport error via console.error before re-throwing", async () => {
    setSmtpEnv();
    smtpNetworkError();

    await expect(
      sendBillingAlertNotification(BILLING_ARGS),
    ).rejects.toThrow();

    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[Billing alert email] Failed to send notification:"),
    );
    const loggedMsg: string = consoleSpy.mock.calls[0][0];
    expect(loggedMsg).toContain("ECONNREFUSED");
  });

  it("logs the Resend network error via console.error before re-throwing", async () => {
    setResendEnv();
    resendNetworkError();

    await expect(
      sendBillingAlertNotification(BILLING_ARGS),
    ).rejects.toThrow();

    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[Billing alert email] Failed to send notification:"),
    );
    const loggedMsg: string = consoleSpy.mock.calls[0][0];
    expect(loggedMsg).toContain("ECONNRESET");
  });

  it("still returns without throwing when transport is not configured (config-missing is not a transient error)", async () => {
    delete process.env.SMTP_HOST;
    delete process.env.RESEND_API_KEY;
    process.env.PLATFORM_ADMIN_EMAIL = "admin@test.local";

    await expect(
      sendBillingAlertNotification(BILLING_ARGS),
    ).resolves.toBeUndefined();
  });

  it("still returns without throwing when PLATFORM_ADMIN_EMAIL is absent (config-missing is not a transient error)", async () => {
    setResendEnv();
    delete process.env.PLATFORM_ADMIN_EMAIL;

    await expect(
      sendBillingAlertNotification(BILLING_ARGS),
    ).resolves.toBeUndefined();
  });
});
