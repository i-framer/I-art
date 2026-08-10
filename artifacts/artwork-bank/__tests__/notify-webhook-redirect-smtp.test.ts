/**
 * Integration tests for the SMTP-failure path in sendWebhookRedirectEmail
 * (lib/email.ts ~line 994).
 *
 * When SMTP is configured but the mail-server rejects the connection (bad
 * credentials, wrong host, etc.) the function must:
 *
 *  1. Return false so the caller knows the email was not delivered.
 *  2. Append a structured warning block to GITHUB_STEP_SUMMARY so the CI
 *     workflow-run summary flags the broken transport — even if the operator
 *     does not monitor raw stderr.
 *
 * Mirrors the existing notify-smoke-failure-smtp.test.ts pattern.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, readFileSync, unlinkSync, rmdirSync } from "fs";

// ── nodemailer mock ───────────────────────────────────────────────────────────
const sendMailMock = vi.fn();
const createTransportMock = vi.fn(() => ({ sendMail: sendMailMock }));

vi.mock("nodemailer", () => ({
  default: { createTransport: createTransportMock },
}));

// ── base-url mock (transitively required by email.ts helpers) ─────────────────
vi.mock("@/lib/base-url", () => ({
  getPlatformBaseUrl: () => "https://platform.test",
  getTenantUrl: () => "https://tenant.test",
}));

import { sendWebhookRedirectEmail } from "@/lib/email";

// ── Env keys managed across tests ─────────────────────────────────────────────
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
  "EMAIL_FROM_INQUIRIES",
  "GITHUB_STEP_SUMMARY",
] as const;
const savedEnv: Record<string, string | undefined> = {};

const ARGS = {
  webhookUrl: "https://i-art.com.au/api/stripe/webhook",
  httpCode: "308",
  location: "https://www.i-art.com.au/api/stripe/webhook",
  workflowRunUrl: "https://github.com/owner/repo/actions/runs/99999",
};

// Temporary file used as a GITHUB_STEP_SUMMARY target during tests.
let summaryFile: string;
let tmpDir: string;

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }

  sendMailMock.mockReset().mockResolvedValue({ messageId: "smtp-webhook-redirect-test" });
  createTransportMock.mockClear();

  // Create a fresh temp file for GITHUB_STEP_SUMMARY each test.
  tmpDir = mkdtempSync(join(tmpdir(), "gha-summary-"));
  summaryFile = join(tmpDir, "step_summary.md");
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.restoreAllMocks();

  // Clean up temp files.
  try { unlinkSync(summaryFile); } catch { /* already gone */ }
  try { rmdirSync(tmpDir); } catch { /* already gone */ }
});

// ── Guard: no transport / no admin email ─────────────────────────────────────

describe("sendWebhookRedirectEmail — early-exit guards", () => {
  it("returns false without calling any transport when neither SMTP_HOST nor RESEND_API_KEY is set", async () => {
    process.env.PLATFORM_ADMIN_EMAIL = "admin@example.com";
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await sendWebhookRedirectEmail(ARGS);

    expect(result).toBe(false);
    expect(sendMailMock).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns false without calling any transport when SMTP_HOST is set but PLATFORM_ADMIN_EMAIL is not", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.EMAIL_FROM = "noreply@example.com";
    // PLATFORM_ADMIN_EMAIL intentionally absent.
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await sendWebhookRedirectEmail(ARGS);

    expect(result).toBe(false);
    expect(sendMailMock).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── Happy path: SMTP delivers successfully ────────────────────────────────────

describe("sendWebhookRedirectEmail — successful SMTP delivery", () => {
  it("returns true and calls nodemailer when SMTP_HOST and PLATFORM_ADMIN_EMAIL are set", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.EMAIL_FROM = "noreply@example.com";
    process.env.PLATFORM_ADMIN_EMAIL = "admin@example.com";

    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await sendWebhookRedirectEmail(ARGS);

    expect(result).toBe(true);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("addresses the email to PLATFORM_ADMIN_EMAIL with a subject containing the HTTP code", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.EMAIL_FROM = "noreply@example.com";
    process.env.PLATFORM_ADMIN_EMAIL = "admin@example.com";

    await sendWebhookRedirectEmail(ARGS);

    const payload = sendMailMock.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.to).toBe("admin@example.com");
    expect(String(payload.subject)).toContain("308");
  });
});

// ── Broken SMTP: GITHUB_STEP_SUMMARY warning ─────────────────────────────────

describe("sendWebhookRedirectEmail — broken SMTP writes warning to GITHUB_STEP_SUMMARY", () => {
  it("returns false and writes the warning block to GITHUB_STEP_SUMMARY when SMTP rejects", async () => {
    // Simulate a broken SMTP server — nodemailer throws on sendMail.
    const smtpError = new Error("Connection refused — ECONNREFUSED 127.0.0.1:587");
    sendMailMock.mockRejectedValue(smtpError);

    process.env.SMTP_HOST = "broken.smtp.example.com";
    process.env.EMAIL_FROM = "noreply@example.com";
    process.env.PLATFORM_ADMIN_EMAIL = "admin@example.com";
    process.env.GITHUB_STEP_SUMMARY = summaryFile;

    const result = await sendWebhookRedirectEmail(ARGS);

    expect(result).toBe(false);

    // The warning block must have been appended to the summary file.
    const summaryContent = readFileSync(summaryFile, "utf8");

    expect(summaryContent).toContain(
      "### ⚠️ Email transport failure — operator NOT notified by email",
    );
    expect(summaryContent).toContain("webhook-redirect alert email");
    expect(summaryContent).toContain("**Delivery error:**");
    // The SMTP error message should appear (possibly truncated to 300 chars).
    expect(summaryContent).toContain("ECONNREFUSED");
    // Fix instructions must be present.
    expect(summaryContent).toContain("SMTP_HOST");
  });

  it("includes the SMTP error text in the Delivery error line", async () => {
    const uniqueError = "AUTH_FAILED credentials rejected by smtp.example.com:587";
    sendMailMock.mockRejectedValue(new Error(uniqueError));

    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_USER = "user@example.com";
    process.env.SMTP_PASS = "wrong-password";
    process.env.EMAIL_FROM = "noreply@example.com";
    process.env.PLATFORM_ADMIN_EMAIL = "admin@example.com";
    process.env.GITHUB_STEP_SUMMARY = summaryFile;

    await sendWebhookRedirectEmail(ARGS);

    const summaryContent = readFileSync(summaryFile, "utf8");
    expect(summaryContent).toContain(uniqueError);
  });

  it("does not write to GITHUB_STEP_SUMMARY when SMTP succeeds", async () => {
    // sendMailMock is already set to resolve successfully via beforeEach.
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.EMAIL_FROM = "noreply@example.com";
    process.env.PLATFORM_ADMIN_EMAIL = "admin@example.com";
    process.env.GITHUB_STEP_SUMMARY = summaryFile;

    const result = await sendWebhookRedirectEmail(ARGS);

    expect(result).toBe(true);

    // Summary file should not exist (no appendFileSync called on success).
    let summaryExists = true;
    try { readFileSync(summaryFile, "utf8"); } catch { summaryExists = false; }
    expect(summaryExists).toBe(false);
  });

  it("returns false and does not throw when GITHUB_STEP_SUMMARY is not set and SMTP fails", async () => {
    sendMailMock.mockRejectedValue(new Error("Connection timed out"));

    process.env.SMTP_HOST = "smtp.example.com";
    process.env.EMAIL_FROM = "noreply@example.com";
    process.env.PLATFORM_ADMIN_EMAIL = "admin@example.com";
    // GITHUB_STEP_SUMMARY intentionally absent — not running in CI.

    await expect(sendWebhookRedirectEmail(ARGS)).resolves.toBe(false);
  });
});

// ── nodemailer mock-intercept canary ──────────────────────────────────────────
//
// WHY THIS TEST EXISTS
// --------------------
// email.ts imports nodemailer with a dynamic import and accesses the default
// export: `(await import("nodemailer")).default.createTransport(...)`.
// The vi.mock() factory at the top of this file mirrors that shape:
//   { default: { createTransport: createTransportMock } }
//
// If nodemailer is upgraded and its export shape changes the factory would
// silently stop intercepting calls.  This canary asserts that
// createTransportMock is actually reached, so any export-shape mismatch
// surfaces immediately as a test failure rather than an incorrect green build.
describe("nodemailer mock-intercept canary", () => {
  it("createTransportMock is invoked by sendWebhookRedirectEmail — failure here means the vi.mock() wiring is broken", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.EMAIL_FROM = "noreply@example.com";
    process.env.PLATFORM_ADMIN_EMAIL = "admin@example.com";
    // RESEND_API_KEY deliberately absent so the SMTP branch is taken.

    await sendWebhookRedirectEmail(ARGS);

    // createTransportMock MUST have been called.
    expect(createTransportMock).toHaveBeenCalledTimes(1);
    // sendMailMock MUST also have been called — verifies the full chain is live.
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });
});
