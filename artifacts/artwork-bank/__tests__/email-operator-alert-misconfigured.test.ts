/**
 * Misconfiguration guard tests for operator alert emails — Task #346
 *
 * Verifies that sendSchemaPushFailureEmail, sendDriftFailureEmail,
 * sendOrphanSweepErrorNotification, and sendBillingAlertNotification
 * each return false/void without throwing — and without attempting
 * delivery — when either PLATFORM_ADMIN_EMAIL or the email transport
 * (SMTP_HOST + RESEND_API_KEY) is absent.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Transport mocks ────────────────────────────────────────────────────────────
const mockSendMail = vi.fn().mockResolvedValue({ messageId: "test-msg" });

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn().mockReturnValue({ sendMail: mockSendMail }),
  },
}));

vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: { send: vi.fn().mockResolvedValue({ id: "test-resend" }) },
  })),
}));

// ── Environment helpers ────────────────────────────────────────────────────────
const TRANSPORT_KEYS = ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "SMTP_PORT", "RESEND_API_KEY"];
const ALL_KEYS = [...TRANSPORT_KEYS, "PLATFORM_ADMIN_EMAIL"];
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

/** Set up a fully-configured environment (SMTP + admin email). */
function setFullEnv() {
  process.env.SMTP_HOST = "smtp.test.local";
  process.env.SMTP_USER = "test@test.local";
  process.env.SMTP_PASS = "testpass";
  process.env.SMTP_PORT = "587";
  process.env.PLATFORM_ADMIN_EMAIL = "admin@test.local";
  delete process.env.RESEND_API_KEY;
}

/** Remove PLATFORM_ADMIN_EMAIL but keep a valid transport. */
function setMissingAdminEmail() {
  process.env.SMTP_HOST = "smtp.test.local";
  process.env.SMTP_USER = "test@test.local";
  process.env.SMTP_PASS = "testpass";
  process.env.SMTP_PORT = "587";
  delete process.env.PLATFORM_ADMIN_EMAIL;
  delete process.env.RESEND_API_KEY;
}

/** Remove all transport env vars but keep PLATFORM_ADMIN_EMAIL. */
function setMissingTransport() {
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  delete process.env.SMTP_PORT;
  delete process.env.RESEND_API_KEY;
  process.env.PLATFORM_ADMIN_EMAIL = "admin@test.local";
}

beforeEach(() => {
  saveEnv();
  vi.clearAllMocks();
});

afterEach(() => {
  restoreEnv();
  vi.clearAllMocks();
});

import {
  sendSchemaPushFailureEmail,
  sendDriftFailureEmail,
  sendOrphanSweepErrorNotification,
  sendBillingAlertNotification,
} from "@/lib/email";

// ── sendSchemaPushFailureEmail ─────────────────────────────────────────────────

describe("sendSchemaPushFailureEmail — misconfigured transport", () => {
  it("returns false without throwing when PLATFORM_ADMIN_EMAIL is absent", async () => {
    setMissingAdminEmail();
    await expect(
      sendSchemaPushFailureEmail({ errorText: "push failed" }),
    ).resolves.toBe(false);
  });

  it("does not attempt delivery when PLATFORM_ADMIN_EMAIL is absent", async () => {
    setMissingAdminEmail();
    await sendSchemaPushFailureEmail({ errorText: "push failed" });
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("returns false without throwing when SMTP_HOST and RESEND_API_KEY are absent", async () => {
    setMissingTransport();
    await expect(
      sendSchemaPushFailureEmail({ errorText: "push failed" }),
    ).resolves.toBe(false);
  });

  it("does not attempt delivery when SMTP_HOST and RESEND_API_KEY are absent", async () => {
    setMissingTransport();
    await sendSchemaPushFailureEmail({ errorText: "push failed" });
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("returns false without throwing when both admin email and transport are absent", async () => {
    delete process.env.PLATFORM_ADMIN_EMAIL;
    delete process.env.SMTP_HOST;
    delete process.env.RESEND_API_KEY;
    await expect(
      sendSchemaPushFailureEmail({ errorText: "push failed" }),
    ).resolves.toBe(false);
  });

  it("returns true (sends) when both admin email and transport are configured", async () => {
    setFullEnv();
    await expect(
      sendSchemaPushFailureEmail({ errorText: "push failed" }),
    ).resolves.toBe(true);
  });
});

// ── sendDriftFailureEmail ──────────────────────────────────────────────────────

describe("sendDriftFailureEmail — misconfigured transport", () => {
  it("returns false without throwing when PLATFORM_ADMIN_EMAIL is absent", async () => {
    setMissingAdminEmail();
    await expect(
      sendDriftFailureEmail({ errorText: "drift detected" }),
    ).resolves.toBe(false);
  });

  it("does not attempt delivery when PLATFORM_ADMIN_EMAIL is absent", async () => {
    setMissingAdminEmail();
    await sendDriftFailureEmail({ errorText: "drift detected" });
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("returns false without throwing when SMTP_HOST and RESEND_API_KEY are absent", async () => {
    setMissingTransport();
    await expect(
      sendDriftFailureEmail({ errorText: "drift detected" }),
    ).resolves.toBe(false);
  });

  it("does not attempt delivery when SMTP_HOST and RESEND_API_KEY are absent", async () => {
    setMissingTransport();
    await sendDriftFailureEmail({ errorText: "drift detected" });
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("returns false without throwing when both admin email and transport are absent", async () => {
    delete process.env.PLATFORM_ADMIN_EMAIL;
    delete process.env.SMTP_HOST;
    delete process.env.RESEND_API_KEY;
    await expect(
      sendDriftFailureEmail({ errorText: "drift detected" }),
    ).resolves.toBe(false);
  });

  it("returns true (sends) when both admin email and transport are configured", async () => {
    setFullEnv();
    await expect(
      sendDriftFailureEmail({ errorText: "drift detected" }),
    ).resolves.toBe(true);
  });
});

// ── sendOrphanSweepErrorNotification ──────────────────────────────────────────

describe("sendOrphanSweepErrorNotification — misconfigured transport", () => {
  it("resolves to void without throwing when PLATFORM_ADMIN_EMAIL is absent", async () => {
    setMissingAdminEmail();
    const result = await sendOrphanSweepErrorNotification({ errors: 3, failedPaths: ["a/b/c.jpg"] });
    expect(result).toBeUndefined();
  });

  it("does not attempt delivery when PLATFORM_ADMIN_EMAIL is absent", async () => {
    setMissingAdminEmail();
    await sendOrphanSweepErrorNotification({ errors: 3, failedPaths: ["a/b/c.jpg"] });
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("resolves to void without throwing when SMTP_HOST and RESEND_API_KEY are absent", async () => {
    setMissingTransport();
    const result = await sendOrphanSweepErrorNotification({ errors: 1, failedPaths: [] });
    expect(result).toBeUndefined();
  });

  it("does not attempt delivery when SMTP_HOST and RESEND_API_KEY are absent", async () => {
    setMissingTransport();
    await sendOrphanSweepErrorNotification({ errors: 1, failedPaths: [] });
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("resolves to void without throwing when both admin email and transport are absent", async () => {
    delete process.env.PLATFORM_ADMIN_EMAIL;
    delete process.env.SMTP_HOST;
    delete process.env.RESEND_API_KEY;
    const result = await sendOrphanSweepErrorNotification({ errors: 2, failedPaths: ["x.jpg"] });
    expect(result).toBeUndefined();
  });

  it("attempts delivery when both admin email and transport are configured", async () => {
    setFullEnv();
    await sendOrphanSweepErrorNotification({ errors: 1, failedPaths: ["x.jpg"] });
    expect(mockSendMail).toHaveBeenCalledOnce();
  });
});

// ── sendBillingAlertNotification ───────────────────────────────────────────────

const BILLING_BASE = {
  stripeEventId: "evt_test_001",
  eventType: "customer.subscription.deleted",
  reason: "No tenant found for customer",
};

describe("sendBillingAlertNotification — misconfigured transport", () => {
  it("resolves to void without throwing when PLATFORM_ADMIN_EMAIL is absent", async () => {
    setMissingAdminEmail();
    const result = await sendBillingAlertNotification(BILLING_BASE);
    expect(result).toBeUndefined();
  });

  it("does not attempt delivery when PLATFORM_ADMIN_EMAIL is absent", async () => {
    setMissingAdminEmail();
    await sendBillingAlertNotification(BILLING_BASE);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("resolves to void without throwing when SMTP_HOST and RESEND_API_KEY are absent", async () => {
    setMissingTransport();
    const result = await sendBillingAlertNotification(BILLING_BASE);
    expect(result).toBeUndefined();
  });

  it("does not attempt delivery when SMTP_HOST and RESEND_API_KEY are absent", async () => {
    setMissingTransport();
    await sendBillingAlertNotification(BILLING_BASE);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("resolves to void without throwing when both admin email and transport are absent", async () => {
    delete process.env.PLATFORM_ADMIN_EMAIL;
    delete process.env.SMTP_HOST;
    delete process.env.RESEND_API_KEY;
    const result = await sendBillingAlertNotification(BILLING_BASE);
    expect(result).toBeUndefined();
  });

  it("attempts delivery when both admin email and transport are configured", async () => {
    setFullEnv();
    await sendBillingAlertNotification(BILLING_BASE);
    expect(mockSendMail).toHaveBeenCalledOnce();
  });
});
