/**
 * Task #570 — Confirm the orphan-sweep email warning appears in CI when
 * SMTP is broken.
 *
 * When sendOrphanSweepErrorNotification is called with a valid SMTP_HOST and
 * PLATFORM_ADMIN_EMAIL but nodemailer throws (e.g. wrong password, unreachable
 * host), the catch block must append a warning block to GITHUB_STEP_SUMMARY so
 * the operator sees the transport failure in the Actions workflow UI.
 *
 * This test simulates the CI environment by pointing GITHUB_STEP_SUMMARY at a
 * real temporary file, then asserts both that the file was written and that its
 * content matches the expected Markdown warning block.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── nodemailer mock ────────────────────────────────────────────────────────────
const mockSendMail = vi.fn();

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn().mockReturnValue({ sendMail: mockSendMail }),
  },
}));

// ── Environment keys managed across tests ─────────────────────────────────────
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
let tmpDir: string;
let summaryFile: string;

beforeEach(() => {
  // Save and clear all relevant env vars.
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }

  // Create a fresh temp file for GITHUB_STEP_SUMMARY each test.
  tmpDir = mkdtempSync(join(tmpdir(), "orphan-sweep-summary-test-"));
  summaryFile = join(tmpDir, "step_summary.md");

  mockSendMail.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  // Restore env vars.
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  // Clean up temp file.
  try {
    unlinkSync(summaryFile);
  } catch {
    /* already removed or never created */
  }
  try {
    rmdirSync(tmpDir);
  } catch {
    /* ignore */
  }
  vi.restoreAllMocks();
});

import { sendOrphanSweepErrorNotification } from "@/lib/email";

// ── Helper ────────────────────────────────────────────────────────────────────

/** Set up a broken-SMTP environment: host configured, sendMail throws. */
function setBrokenSmtp(smtpError = "SMTP connection refused") {
  process.env.SMTP_HOST = "smtp.broken.local";
  process.env.SMTP_USER = "alerts@broken.local";
  process.env.SMTP_PASS = "wrong-password";
  process.env.SMTP_PORT = "587";
  process.env.PLATFORM_ADMIN_EMAIL = "admin@broken.local";
  delete process.env.RESEND_API_KEY;

  const err = new Error(smtpError);
  (err as any).code = "ECONNREFUSED";
  mockSendMail.mockRejectedValue(err);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("sendOrphanSweepErrorNotification — GITHUB_STEP_SUMMARY written on broken SMTP", () => {
  it("appends the warning block to GITHUB_STEP_SUMMARY when SMTP throws", async () => {
    setBrokenSmtp("SMTP connection refused");
    process.env.GITHUB_STEP_SUMMARY = summaryFile;

    await expect(
      sendOrphanSweepErrorNotification({ errors: 2, failedPaths: ["a/b.jpg", "c/d.png"] }),
    ).rejects.toThrow();

    const written = readFileSync(summaryFile, "utf8");
    expect(written).toContain(
      "### ⚠️ Email transport failure — operator NOT notified by email",
    );
    expect(written).toContain("orphan-sweep error alert email could **not** be delivered");
    expect(written).toContain("**Delivery error:**");
    expect(written).toContain("SMTP error");
    expect(written).toContain("SMTP connection refused");
  });

  it("includes the fix instructions for SMTP secrets in the summary", async () => {
    setBrokenSmtp("Authentication credentials invalid");
    process.env.GITHUB_STEP_SUMMARY = summaryFile;

    await expect(
      sendOrphanSweepErrorNotification({ errors: 1, failedPaths: ["x/y.jpg"] }),
    ).rejects.toThrow();

    const written = readFileSync(summaryFile, "utf8");
    expect(written).toContain("SMTP_HOST");
    expect(written).toContain("SMTP_PORT");
    expect(written).toContain("SMTP_USER");
    expect(written).toContain("SMTP_PASS");
  });

  it("does not write to GITHUB_STEP_SUMMARY when the env var is not set", async () => {
    setBrokenSmtp("SMTP connection refused");
    // GITHUB_STEP_SUMMARY intentionally absent — outside CI.
    delete process.env.GITHUB_STEP_SUMMARY;

    await expect(
      sendOrphanSweepErrorNotification({ errors: 1, failedPaths: ["z.jpg"] }),
    ).rejects.toThrow();

    // The summary file must not have been created by the function.
    expect(() => readFileSync(summaryFile, "utf8")).toThrow();
  });

  it("still re-throws after writing the step summary so callers are not misled", async () => {
    setBrokenSmtp("Connection timed out");
    process.env.GITHUB_STEP_SUMMARY = summaryFile;

    await expect(
      sendOrphanSweepErrorNotification({ errors: 3, failedPaths: ["p/q.jpg"] }),
    ).rejects.toThrow(/SMTP error.*Connection timed out/i);
  });

  it("includes the RESEND_API_KEY alternative in the step summary", async () => {
    setBrokenSmtp("SMTP connection refused");
    process.env.GITHUB_STEP_SUMMARY = summaryFile;

    await expect(
      sendOrphanSweepErrorNotification({ errors: 1, failedPaths: [] }),
    ).rejects.toThrow();

    const written = readFileSync(summaryFile, "utf8");
    expect(written).toContain("RESEND_API_KEY");
  });
});
