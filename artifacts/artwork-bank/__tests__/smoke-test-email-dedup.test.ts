/**
 * Unit tests for the RESEND_ALREADY_SENT deduplication guard in
 * sendSmokeTestFailureEmail (lib/email.ts).
 *
 * Coverage:
 *  - RESEND_ALREADY_SENT=1 + no SMTP → returns true without calling Resend fetch
 *  - RESEND_ALREADY_SENT=1 + SMTP configured → SMTP is still attempted (guard must not block it)
 *  - RESEND_ALREADY_SENT unset + Resend key present → normal Resend fetch path is taken
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── nodemailer mock (for the SMTP path) ─────────────────────────────────────
const sendMailMock = vi.fn();
const createTransportMock = vi.fn(() => ({ sendMail: sendMailMock }));

vi.mock("nodemailer", () => ({
  default: { createTransport: createTransportMock },
}));

// ── base-url mock (imported transitively by email.ts helpers) ────────────────
vi.mock("@/lib/base-url", () => ({
  getPlatformBaseUrl: () => "https://platform.test",
  getTenantUrl: () => "https://tenant.test",
}));

import { sendSmokeTestFailureEmail } from "@/lib/email";

// ── Env keys managed across tests ────────────────────────────────────────────
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
  probeResponseBody: '{"ok":false,"error":"not_authed"}',
  workflowRunUrl: "https://github.com/owner/repo/actions/runs/12345",
};

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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("sendSmokeTestFailureEmail — RESEND_ALREADY_SENT guard", () => {
  it("returns true without calling Resend when RESEND_ALREADY_SENT=1 and no SMTP_HOST", async () => {
    process.env.RESEND_ALREADY_SENT = "1";
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.PLATFORM_ADMIN_EMAIL = "admin@example.com";

    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await sendSmokeTestFailureEmail(ARGS);

    expect(result).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still attempts SMTP when RESEND_ALREADY_SENT=1 and SMTP_HOST is configured", async () => {
    process.env.RESEND_ALREADY_SENT = "1";
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.EMAIL_FROM = "noreply@example.com";
    process.env.PLATFORM_ADMIN_EMAIL = "admin@example.com";

    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await sendSmokeTestFailureEmail(ARGS);

    expect(result).toBe(true);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("calls Resend normally when RESEND_ALREADY_SENT is not set", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.PLATFORM_ADMIN_EMAIL = "admin@example.com";

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "resend-msg-1" }), { status: 200 }),
    );

    const result = await sendSmokeTestFailureEmail(ARGS);

    expect(result).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("resend.com");
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});
