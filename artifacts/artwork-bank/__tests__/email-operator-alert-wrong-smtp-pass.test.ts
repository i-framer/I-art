/**
 * Wrong SMTP password guard tests for operator alert emails
 *
 * Verifies that sendSchemaPushFailureEmail, sendDriftFailureEmail,
 * sendOrphanSweepErrorNotification, and sendBillingAlertNotification
 * each behave correctly when nodemailer throws an SMTP authentication error
 * (e.g. wrong SMTP_PASS, expired credentials).
 *
 * Specifically:
 *  - The error must NOT be silently swallowed (console.error must fire)
 *  - sendSchemaPushFailureEmail / sendDriftFailureEmail must NOT propagate
 *    the error — they return false so the caller (post-merge.sh) keeps its
 *    own non-zero exit code
 *  - sendOrphanSweepErrorNotification / sendBillingAlertNotification MUST
 *    re-throw so callers know delivery failed
 *
 * This is the SMTP parallel of the wrong-Resend-key tests (Task #364).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── nodemailer mock ─────────────────────────────────────────────────────────────
const mockSendMail = vi.fn();

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn().mockReturnValue({ sendMail: mockSendMail }),
  },
}));

// ── fetch mock (must not be reached when SMTP_HOST is set) ────────────────────
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ── Environment helpers ────────────────────────────────────────────────────────
const ALL_KEYS = [
  "SMTP_HOST",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_PORT",
  "RESEND_API_KEY",
  "PLATFORM_ADMIN_EMAIL",
];
const savedEnv: Record<string, string | undefined> = {};

function saveEnv() {
  for (const k of ALL_KEYS) savedEnv[k] = process.env[k];
}

function restoreEnv() {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k];
}

/**
 * Configure SMTP transport with a dummy (wrong) password.
 * RESEND_API_KEY is absent so the SMTP branch is the only path attempted.
 */
function setWrongSmtpPass() {
  process.env.SMTP_HOST = "smtp.test.local";
  process.env.SMTP_USER = "test@test.local";
  process.env.SMTP_PASS = "WRONG_PASSWORD";
  process.env.SMTP_PORT = "587";
  delete process.env.RESEND_API_KEY;
  process.env.PLATFORM_ADMIN_EMAIL = "admin@test.local";
}

/** Make nodemailer's sendMail reject with an SMTP 535 auth error. */
function mockSmtpAuthError() {
  const err = new Error(
    "Invalid login: 535 5.7.8 Authentication credentials invalid",
  );
  (err as any).code = "EAUTH";
  (err as any).responseCode = 535;
  mockSendMail.mockRejectedValue(err);
}

let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  saveEnv();
  vi.clearAllMocks();
  setWrongSmtpPass();
  mockSmtpAuthError();
  consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleSpy.mockRestore();
  restoreEnv();
});

import {
  sendSchemaPushFailureEmail,
  sendDriftFailureEmail,
  sendOrphanSweepErrorNotification,
  sendBillingAlertNotification,
} from "@/lib/email";

// ── sendSchemaPushFailureEmail ─────────────────────────────────────────────────

describe("sendSchemaPushFailureEmail — wrong SMTP password", () => {
  it("returns false without throwing when nodemailer throws an auth error", async () => {
    await expect(
      sendSchemaPushFailureEmail({ errorText: "push failed" }),
    ).resolves.toBe(false);
  });

  it("logs the failure via console.error when nodemailer throws an auth error", async () => {
    await sendSchemaPushFailureEmail({ errorText: "push failed" });
    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "[Schema push alert email] Failed to send operator notification:",
      ),
      expect.stringContaining("SMTP error"),
    );
  });

  it("attempted delivery via SMTP when SMTP_HOST is set", async () => {
    await sendSchemaPushFailureEmail({ errorText: "push failed" });
    expect(mockSendMail).toHaveBeenCalledOnce();
  });

  it("does not fall through to Resend when SMTP_HOST is set", async () => {
    await sendSchemaPushFailureEmail({ errorText: "push failed" });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ── sendDriftFailureEmail ──────────────────────────────────────────────────────

describe("sendDriftFailureEmail — wrong SMTP password", () => {
  it("returns false without throwing when nodemailer throws an auth error", async () => {
    await expect(
      sendDriftFailureEmail({ errorText: "drift detected" }),
    ).resolves.toBe(false);
  });

  it("logs the failure via console.error when nodemailer throws an auth error", async () => {
    await sendDriftFailureEmail({ errorText: "drift detected" });
    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "[Drift alert email] Failed to send operator notification:",
      ),
      expect.stringContaining("SMTP error"),
    );
  });

  it("attempted delivery via SMTP when SMTP_HOST is set", async () => {
    await sendDriftFailureEmail({ errorText: "drift detected" });
    expect(mockSendMail).toHaveBeenCalledOnce();
  });

  it("does not fall through to Resend when SMTP_HOST is set", async () => {
    await sendDriftFailureEmail({ errorText: "drift detected" });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ── sendOrphanSweepErrorNotification ──────────────────────────────────────────

describe("sendOrphanSweepErrorNotification — wrong SMTP password", () => {
  it("re-throws so callers are not silently misled", async () => {
    await expect(
      sendOrphanSweepErrorNotification({ errors: 3, failedPaths: ["a/b/c.jpg"] }),
    ).rejects.toThrow();
  });

  it("logs the failure via console.error before re-throwing", async () => {
    await expect(
      sendOrphanSweepErrorNotification({ errors: 2, failedPaths: ["x.jpg"] }),
    ).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "[Orphan sweep email] Failed to send operator notification:",
      ),
      expect.stringContaining("SMTP error"),
    );
  });

  it("attempted delivery via SMTP when SMTP_HOST is set", async () => {
    await sendOrphanSweepErrorNotification({
      errors: 1,
      failedPaths: ["y.png"],
    }).catch(() => {});
    expect(mockSendMail).toHaveBeenCalledOnce();
  });

  it("does not fall through to Resend when SMTP_HOST is set", async () => {
    await sendOrphanSweepErrorNotification({
      errors: 1,
      failedPaths: [],
    }).catch(() => {});
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ── sendBillingAlertNotification ───────────────────────────────────────────────

const BILLING_BASE = {
  stripeEventId: "evt_test_wrong_smtp_001",
  eventType: "customer.subscription.deleted",
  reason: "No tenant found for customer",
};

describe("sendBillingAlertNotification — wrong SMTP password", () => {
  it("re-throws so callers are not silently misled", async () => {
    await expect(sendBillingAlertNotification(BILLING_BASE)).rejects.toThrow();
  });

  it("logs the failure via console.error before re-throwing", async () => {
    await expect(sendBillingAlertNotification(BILLING_BASE)).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "[Billing alert email] Failed to send notification:",
      ),
    );
    // The single-argument log must also mention the SMTP error.
    const loggedMsg: string = consoleSpy.mock.calls[0][0];
    expect(loggedMsg).toContain("SMTP error");
  });

  it("attempted delivery via SMTP when SMTP_HOST is set", async () => {
    await sendBillingAlertNotification(BILLING_BASE).catch(() => {});
    expect(mockSendMail).toHaveBeenCalledOnce();
  });

  it("does not fall through to Resend when SMTP_HOST is set", async () => {
    await sendBillingAlertNotification(BILLING_BASE).catch(() => {});
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
