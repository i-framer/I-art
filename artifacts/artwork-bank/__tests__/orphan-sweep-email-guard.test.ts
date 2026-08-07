/**
 * Unit tests for the PLATFORM_ADMIN_EMAIL guard in
 * sendOrphanSweepErrorNotification (lib/email.ts).
 *
 * Coverage:
 *  - No PLATFORM_ADMIN_EMAIL + no transport → resolves silently, fetch/nodemailer not called
 *  - RESEND_API_KEY set but no PLATFORM_ADMIN_EMAIL → same silent skip
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

import { sendOrphanSweepErrorNotification } from "@/lib/email";

// ── Env keys managed across tests ────────────────────────────────────────────
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
] as const;
const savedEnv: Record<string, string | undefined> = {};

const ARGS = {
  errors: 3,
  failedPaths: ["uploads/img1.jpg", "uploads/img2.jpg", "uploads/img3.jpg"],
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

describe("sendOrphanSweepErrorNotification — PLATFORM_ADMIN_EMAIL guard", () => {
  it("resolves silently without calling fetch or nodemailer when neither PLATFORM_ADMIN_EMAIL nor a transport is set", async () => {
    // No env vars set at all — bare minimum: function must bail out silently
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(
      sendOrphanSweepErrorNotification(ARGS),
    ).resolves.toBeUndefined();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("resolves silently without calling fetch or nodemailer when RESEND_API_KEY is set but PLATFORM_ADMIN_EMAIL is not", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    // PLATFORM_ADMIN_EMAIL intentionally omitted

    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(
      sendOrphanSweepErrorNotification(ARGS),
    ).resolves.toBeUndefined();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});
