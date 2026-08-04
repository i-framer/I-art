/**
 * Wrong-key guard tests for operator alert emails — Task #364
 *
 * Verifies that sendSchemaPushFailureEmail, sendDriftFailureEmail,
 * sendOrphanSweepErrorNotification, and sendBillingAlertNotification
 * each:
 *  - Do NOT propagate the error to the caller (return false / resolve to void)
 *  - DO log the failure via console.error so operators can discover it in logs
 *
 * This covers the distinct failure mode from Task #346 (absent key) where the
 * key is present but invalid — Resend returns 401 or 422. A regression that
 * catches the error but silently swallows it (no log) would also fail here.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── nodemailer must not be used in these tests ─────────────────────────────────
const mockSendMail = vi.fn();

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn().mockReturnValue({ sendMail: mockSendMail }),
  },
}));

// ── fetch mock ─────────────────────────────────────────────────────────────────
// email.ts calls fetch directly for Resend; we intercept it here.
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
 * Configure the environment so Resend is the only transport and the key is
 * present-but-wrong.  SMTP_HOST is absent so the SMTP branch is skipped.
 */
function setWrongResendKey() {
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  delete process.env.SMTP_PORT;
  process.env.RESEND_API_KEY = "re_WRONG_KEY_dummy";
  process.env.PLATFORM_ADMIN_EMAIL = "admin@test.local";
}

/** Make fetch simulate a Resend 401 Unauthorized response. */
function mockResend401() {
  mockFetch.mockResolvedValue({
    ok: false,
    status: 401,
    text: async () =>
      '{"statusCode":401,"message":"API key is invalid","name":"unauthorized"}',
  });
}

/** Make fetch simulate a Resend 422 Unprocessable Entity response. */
function mockResend422() {
  mockFetch.mockResolvedValue({
    ok: false,
    status: 422,
    text: async () =>
      '{"statusCode":422,"message":"Invalid `from` field","name":"validation_error"}',
  });
}

let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  saveEnv();
  vi.clearAllMocks();
  setWrongResendKey();
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

describe("sendSchemaPushFailureEmail — wrong Resend API key", () => {
  it("returns false without throwing when Resend returns 401", async () => {
    mockResend401();
    await expect(
      sendSchemaPushFailureEmail({ errorText: "push failed" }),
    ).resolves.toBe(false);
  });

  it("returns false without throwing when Resend returns 422", async () => {
    mockResend422();
    await expect(
      sendSchemaPushFailureEmail({ errorText: "push failed" }),
    ).resolves.toBe(false);
  });

  it("logs the failure via console.error when Resend returns 401", async () => {
    mockResend401();
    await sendSchemaPushFailureEmail({ errorText: "push failed" });
    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[Schema push alert email] Failed to send operator notification:"),
      expect.stringContaining("Resend error 401"),
    );
  });

  it("logs the failure via console.error when Resend returns 422", async () => {
    mockResend422();
    await sendSchemaPushFailureEmail({ errorText: "push failed" });
    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[Schema push alert email] Failed to send operator notification:"),
      expect.stringContaining("Resend error 422"),
    );
  });

  it("attempted delivery via Resend when key is present (even if wrong)", async () => {
    mockResend401();
    await sendSchemaPushFailureEmail({ errorText: "push failed" });
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.resend.com/emails",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("does not fall through to SMTP when Resend key is present", async () => {
    mockResend401();
    await sendSchemaPushFailureEmail({ errorText: "push failed" });
    expect(mockSendMail).not.toHaveBeenCalled();
  });
});

// ── sendDriftFailureEmail ──────────────────────────────────────────────────────

describe("sendDriftFailureEmail — wrong Resend API key", () => {
  it("returns false without throwing when Resend returns 401", async () => {
    mockResend401();
    await expect(
      sendDriftFailureEmail({ errorText: "drift detected" }),
    ).resolves.toBe(false);
  });

  it("returns false without throwing when Resend returns 422", async () => {
    mockResend422();
    await expect(
      sendDriftFailureEmail({ errorText: "drift detected" }),
    ).resolves.toBe(false);
  });

  it("logs the failure via console.error when Resend returns 401", async () => {
    mockResend401();
    await sendDriftFailureEmail({ errorText: "drift detected" });
    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[Drift alert email] Failed to send operator notification:"),
      expect.stringContaining("Resend error 401"),
    );
  });

  it("logs the failure via console.error when Resend returns 422", async () => {
    mockResend422();
    await sendDriftFailureEmail({ errorText: "drift detected" });
    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[Drift alert email] Failed to send operator notification:"),
      expect.stringContaining("Resend error 422"),
    );
  });

  it("attempted delivery via Resend when key is present (even if wrong)", async () => {
    mockResend401();
    await sendDriftFailureEmail({ errorText: "drift detected" });
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.resend.com/emails",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("does not fall through to SMTP when Resend key is present", async () => {
    mockResend401();
    await sendDriftFailureEmail({ errorText: "drift detected" });
    expect(mockSendMail).not.toHaveBeenCalled();
  });
});

// ── sendOrphanSweepErrorNotification ──────────────────────────────────────────

describe("sendOrphanSweepErrorNotification — wrong Resend API key", () => {
  it("re-throws the transport error so callers are not silently misled (Resend 401)", async () => {
    mockResend401();
    await expect(
      sendOrphanSweepErrorNotification({ errors: 3, failedPaths: ["a/b/c.jpg"] }),
    ).rejects.toThrow();
  });

  it("re-throws the transport error so callers are not silently misled (Resend 422)", async () => {
    mockResend422();
    await expect(
      sendOrphanSweepErrorNotification({ errors: 1, failedPaths: [] }),
    ).rejects.toThrow();
  });

  it("logs the failure via console.error before re-throwing when Resend returns 401", async () => {
    mockResend401();
    await expect(
      sendOrphanSweepErrorNotification({ errors: 2, failedPaths: ["x.jpg"] }),
    ).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[Orphan sweep email] Failed to send operator notification:"),
      expect.stringContaining("Resend error 401"),
    );
  });

  it("logs the failure via console.error before re-throwing when Resend returns 422", async () => {
    mockResend422();
    await expect(
      sendOrphanSweepErrorNotification({ errors: 1, failedPaths: ["y.png"] }),
    ).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[Orphan sweep email] Failed to send operator notification:"),
      expect.stringContaining("Resend error 422"),
    );
  });

  it("attempted delivery via Resend when key is present (even if wrong)", async () => {
    mockResend401();
    await sendOrphanSweepErrorNotification({ errors: 1, failedPaths: ["y.png"] }).catch(() => {});
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.resend.com/emails",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("does not fall through to SMTP when Resend key is present", async () => {
    mockResend401();
    await sendOrphanSweepErrorNotification({ errors: 1, failedPaths: [] }).catch(() => {});
    expect(mockSendMail).not.toHaveBeenCalled();
  });
});

// ── sendBillingAlertNotification ───────────────────────────────────────────────

const BILLING_BASE = {
  stripeEventId: "evt_test_wrong_key_001",
  eventType: "customer.subscription.deleted",
  reason: "No tenant found for customer",
};

describe("sendBillingAlertNotification — wrong Resend API key", () => {
  it("re-throws the transport error so callers are not silently misled (Resend 401)", async () => {
    mockResend401();
    await expect(sendBillingAlertNotification(BILLING_BASE)).rejects.toThrow();
  });

  it("re-throws the transport error so callers are not silently misled (Resend 422)", async () => {
    mockResend422();
    await expect(sendBillingAlertNotification(BILLING_BASE)).rejects.toThrow();
  });

  it("logs the failure via console.error before re-throwing when Resend returns 401", async () => {
    mockResend401();
    await expect(sendBillingAlertNotification(BILLING_BASE)).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[Billing alert email] Failed to send notification:"),
    );
    // The single-argument log must also mention the Resend error status.
    const loggedMsg: string = consoleSpy.mock.calls[0][0];
    expect(loggedMsg).toContain("Resend error 401");
  });

  it("logs the failure via console.error before re-throwing when Resend returns 422", async () => {
    mockResend422();
    await expect(sendBillingAlertNotification(BILLING_BASE)).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[Billing alert email] Failed to send notification:"),
    );
    const loggedMsg: string = consoleSpy.mock.calls[0][0];
    expect(loggedMsg).toContain("Resend error 422");
  });

  it("attempted delivery via Resend when key is present (even if wrong)", async () => {
    mockResend401();
    await sendBillingAlertNotification(BILLING_BASE).catch(() => {});
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.resend.com/emails",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("does not fall through to SMTP when Resend key is present", async () => {
    mockResend401();
    await sendBillingAlertNotification(BILLING_BASE).catch(() => {});
    expect(mockSendMail).not.toHaveBeenCalled();
  });
});
