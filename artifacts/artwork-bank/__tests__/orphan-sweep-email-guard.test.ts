/**
 * Unit tests for the PLATFORM_ADMIN_EMAIL guard in
 * sendOrphanSweepErrorNotification (lib/email.ts).
 *
 * Coverage:
 *  - No PLATFORM_ADMIN_EMAIL + no transport → resolves silently, fetch/nodemailer not called
 *  - RESEND_API_KEY set but no PLATFORM_ADMIN_EMAIL → same silent skip
 *  - RESEND_API_KEY + PLATFORM_ADMIN_EMAIL → fetch called once with correct subject & body
 *  - SMTP_HOST + PLATFORM_ADMIN_EMAIL → nodemailer sendMail called once with correct subject
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

describe("sendOrphanSweepErrorNotification — delivery when configured", () => {
  it("calls fetch once with the correct subject when RESEND_API_KEY and PLATFORM_ADMIN_EMAIL are both set", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.PLATFORM_ADMIN_EMAIL = "admin@example.com";

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "resend-test-id" }), { status: 200 }),
    );

    await sendOrphanSweepErrorNotification(ARGS);

    expect(fetchSpy).toHaveBeenCalledOnce();

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");

    const body = JSON.parse(init.body as string);
    expect(body.to).toBe("admin@example.com");
    // Subject mentions the error count
    expect(body.subject).toContain("3");
    // HTML body lists at least the first failed path
    expect(body.html).toContain("uploads/img1.jpg");
  });

  it("still calls fetch and includes the Slack error text in the HTML body when slackFailure is provided", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.PLATFORM_ADMIN_EMAIL = "admin@example.com";

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "resend-test-id" }), { status: 200 }),
    );

    await sendOrphanSweepErrorNotification({
      ...ARGS,
      slackFailure: "Slack connector timed out: connection refused",
    });

    expect(fetchSpy).toHaveBeenCalledOnce();

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);

    // Email must still be delivered even though Slack also failed
    expect(body.to).toBe("admin@example.com");
    // HTML body must contain the Slack error message verbatim
    expect(body.html).toContain("Slack connector timed out: connection refused");
    // The red-banner warning text must be present
    expect(body.html).toContain("Slack notification also failed");
  });

  it("calls nodemailer sendMail once with the correct subject when SMTP_HOST and PLATFORM_ADMIN_EMAIL are both set", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.PLATFORM_ADMIN_EMAIL = "admin@example.com";

    await sendOrphanSweepErrorNotification(ARGS);

    expect(sendMailMock).toHaveBeenCalledOnce();

    const mailArgs = sendMailMock.mock.calls[0][0] as {
      to: string;
      subject: string;
      html: string;
    };
    expect(mailArgs.to).toBe("admin@example.com");
    // Subject mentions the error count
    expect(mailArgs.subject).toContain("3");
    // HTML body lists at least the first failed path
    expect(mailArgs.html).toContain("uploads/img1.jpg");
  });

  it("still calls nodemailer sendMail and includes the Slack error text in the HTML body when SMTP_HOST + slackFailure are both set", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.PLATFORM_ADMIN_EMAIL = "admin@example.com";

    await sendOrphanSweepErrorNotification({
      ...ARGS,
      slackFailure: "Slack connector timed out: connection refused",
    });

    expect(sendMailMock).toHaveBeenCalledOnce();

    const mailArgs = sendMailMock.mock.calls[0][0] as {
      to: string;
      subject: string;
      html: string;
    };

    // Email must still be delivered even though Slack also failed
    expect(mailArgs.to).toBe("admin@example.com");
    // HTML body must contain the Slack error message verbatim
    expect(mailArgs.html).toContain("Slack connector timed out: connection refused");
    // The red-banner warning text must be present
    expect(mailArgs.html).toContain("Slack notification also failed");
  });
});
