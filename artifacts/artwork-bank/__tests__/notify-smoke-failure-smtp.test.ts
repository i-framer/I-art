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

// ── Nodemailer mock-intercept canary ──────────────────────────────────────────
//
// WHY THIS TEST EXISTS
// --------------------
// email.ts imports nodemailer with a dynamic import and accesses the default
// export: `(await import("nodemailer")).default.createTransport(...)`.
// The vi.mock() factory at the top of this file mirrors that shape:
//   { default: { createTransport: createTransportMock } }
//
// If nodemailer is upgraded and its export shape changes — e.g. switching to
// named exports so callers use `import { createTransport } from "nodemailer"`
// — the factory above would silently stop intercepting calls.  The other tests
// would then either call the real nodemailer (network I/O in CI) or a no-op,
// and could still pass.
//
// This canary asserts that createTransportMock is actually reached when
// sendSmokeTestFailureEmail falls back to SMTP, so any export-shape mismatch
// surfaces immediately as a test failure rather than an incorrect green build.
describe("nodemailer mock-intercept canary", () => {
  it("createTransportMock is invoked by sendSmokeTestFailureEmail — failure here means the vi.mock() wiring is broken", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.EMAIL_FROM = "noreply@example.com";
    process.env.PLATFORM_ADMIN_EMAIL = "admin@example.com";
    // RESEND_API_KEY deliberately absent so the SMTP branch is taken.

    await sendSmokeTestFailureEmail(ARGS);

    // createTransportMock MUST have been called.  If it was not, the mock
    // factory is not matching the import path that email.ts uses.  Fix the
    // factory shape at the top of this file to match the nodemailer export.
    expect(createTransportMock).toHaveBeenCalledTimes(1);

    // sendMailMock MUST also have been called — verifies the full chain is
    // live and the transporter returned by createTransportMock is being used.
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });
});
