/**
 * Tests for the SMTP fallback path in sendSmokeTestFailureEmail (lib/email.ts),
 * exercised as it would be by scripts/notify-smoke-failure.ts when Resend is
 * unavailable.
 *
 * The script itself is a thin wrapper — all sending logic lives in
 * sendSmokeTestFailureEmail.  These tests verify that:
 *
 *  1. When RESEND_API_KEY is absent and SMTP_HOST is configured, nodemailer
 *     sendMail is called (SMTP fallback works end-to-end).
 *  2. The message targets PLATFORM_ADMIN_EMAIL and contains the correct subject.
 *  3. RESEND_ALREADY_SENT=1 skips the Resend path but still attempts SMTP when
 *     SMTP_HOST is configured (so the operator gets exactly one email even when
 *     both transports are wired up).
 *  4. When RESEND_ALREADY_SENT=1 and SMTP is NOT configured, the function
 *     returns true immediately without calling either transport.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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

import { sendSmokeTestFailureEmail } from "@/lib/email";

// ── Env keys managed across tests ─────────────────────────────────────────────
const ENV_KEYS = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_SECURE",
  "RESEND_API_KEY",
  "RESEND_ALREADY_SENT",
  "PLATFORM_ADMIN_EMAIL",
  "EMAIL_FROM",
  "EMAIL_FROM_ORDERS",
  "EMAIL_FROM_INQUIRIES",
] as const;
const savedEnv: Record<string, string | undefined> = {};

const ARGS = {
  probeResponseBody: '{"ok":false,"billingAlert":false}',
  workflowRunUrl: "https://github.com/owner/repo/actions/runs/99999",
};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  sendMailMock.mockReset().mockResolvedValue({ messageId: "smtp-smoke-test" });
  createTransportMock.mockClear();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.restoreAllMocks();
});

// ── SMTP-only path (RESEND_API_KEY absent) ────────────────────────────────────

describe("sendSmokeTestFailureEmail — SMTP fallback when Resend is unavailable", () => {
  it("sends via SMTP and returns true when RESEND_API_KEY is absent and SMTP_HOST is set", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.EMAIL_FROM = "noreply@example.com";
    process.env.PLATFORM_ADMIN_EMAIL = "admin@example.com";
    // Deliberately do NOT set RESEND_API_KEY — this is the scenario under test.

    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await sendSmokeTestFailureEmail(ARGS);

    expect(result).toBe(true);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("addresses the email to PLATFORM_ADMIN_EMAIL with the correct subject", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.EMAIL_FROM = "noreply@example.com";
    process.env.PLATFORM_ADMIN_EMAIL = "admin@example.com";

    await sendSmokeTestFailureEmail(ARGS);

    const payload = sendMailMock.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.to).toBe("admin@example.com");
    expect(String(payload.subject)).toContain("Slack smoke test failed");
  });

  it("returns false (no SMTP attempt) when RESEND_API_KEY is absent and SMTP_HOST is also absent", async () => {
    process.env.PLATFORM_ADMIN_EMAIL = "admin@example.com";
    // Neither RESEND_API_KEY nor SMTP_HOST — no transport available.

    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await sendSmokeTestFailureEmail(ARGS);

    expect(result).toBe(false);
    expect(sendMailMock).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses SMTP_USER as the from-address when EMAIL_FROM is not set", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_USER = "alerts@example.com";
    process.env.PLATFORM_ADMIN_EMAIL = "admin@example.com";
    // EMAIL_FROM intentionally omitted — SMTP_USER should be the fallback.

    await sendSmokeTestFailureEmail(ARGS);

    const payload = sendMailMock.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.from).toBe("alerts@example.com");
  });
});

// ── RESEND_ALREADY_SENT guard ─────────────────────────────────────────────────

describe("sendSmokeTestFailureEmail — RESEND_ALREADY_SENT=1 still attempts SMTP", () => {
  it("calls SMTP when RESEND_ALREADY_SENT=1 and SMTP_HOST is configured", async () => {
    process.env.RESEND_ALREADY_SENT = "1";
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.EMAIL_FROM = "noreply@example.com";
    process.env.PLATFORM_ADMIN_EMAIL = "admin@example.com";

    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await sendSmokeTestFailureEmail(ARGS);

    // SMTP must still fire even though Resend already ran in the CI step.
    expect(result).toBe(true);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    // Resend fetch must NOT be called — only one email to the operator.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns true without calling any transport when RESEND_ALREADY_SENT=1 and SMTP_HOST is not set", async () => {
    process.env.RESEND_ALREADY_SENT = "1";
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.PLATFORM_ADMIN_EMAIL = "admin@example.com";
    // No SMTP_HOST — the guard short-circuits before touching either transport.

    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await sendSmokeTestFailureEmail(ARGS);

    expect(result).toBe(true);
    expect(sendMailMock).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
