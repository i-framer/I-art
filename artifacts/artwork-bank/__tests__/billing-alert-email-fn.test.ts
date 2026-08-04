/**
 * Unit-tests sendBillingAlertNotification directly (not through the webhook).
 *
 * Coverage:
 *  - RESEND_API_KEY not set → resolves without throwing
 *  - PLATFORM_ADMIN_EMAIL not set → resolves without throwing
 *  - Both vars set → fetch called with correct URL, recipient, and subject
 *  - Resend returns non-2xx → resolves without throwing (non-fatal by design)
 *  - Sender address precedence: EMAIL_FROM_ORDERS > EMAIL_FROM > sandbox default
 *    (catches a rotated sender domain that hasn't been verified with Resend)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// base-url is imported lazily inside sendBillingAlertNotification; mock it so
// the test environment doesn't need a real Next.js server URL.
vi.mock("@/lib/base-url", () => ({
  getPlatformBaseUrl: () => "https://platform.test",
  getTenantUrl: () => "https://tenant.test/orders",
}));

import { sendBillingAlertNotification } from "@/lib/email";

// SMTP vars must be cleared in every test so a developer's or CI environment
// that sets SMTP_HOST doesn't silently switch the transport under these tests.
const SMTP_VARS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_SECURE"] as const;
const savedSmtp: Record<string, string | undefined> = {};

const alertArgs = {
  stripeEventId: "evt_test_001",
  eventType: "customer.subscription.deleted",
  customerId: "cus_test_1",
  subscriptionId: "sub_test_1",
  reason: "No tenant matched by metadata, customer ID, or subscription ID",
};

beforeEach(() => {
  delete process.env.RESEND_API_KEY;
  delete process.env.PLATFORM_ADMIN_EMAIL;
  for (const k of SMTP_VARS) {
    savedSmtp[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  delete process.env.RESEND_API_KEY;
  delete process.env.PLATFORM_ADMIN_EMAIL;
  for (const k of SMTP_VARS) {
    if (savedSmtp[k] === undefined) delete process.env[k];
    else process.env[k] = savedSmtp[k];
  }
  vi.restoreAllMocks();
});

describe("sendBillingAlertNotification: env-var guard", () => {
  it("resolves without throwing when RESEND_API_KEY is not set", async () => {
    process.env.PLATFORM_ADMIN_EMAIL = "admin@example.com";
    // No RESEND_API_KEY set

    const result = sendBillingAlertNotification(alertArgs);
    // Must be a Promise (async function)
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
  });

  it("resolves without throwing when PLATFORM_ADMIN_EMAIL is not set", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    // No PLATFORM_ADMIN_EMAIL set

    const result = sendBillingAlertNotification(alertArgs);
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
  });

  it("POSTs to the Resend API with the correct recipient and subject when both vars are set", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.PLATFORM_ADMIN_EMAIL = "operator@example.com";

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    await sendBillingAlertNotification(alertArgs);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");

    const payload = JSON.parse(init.body as string);
    expect(payload.to).toBe("operator@example.com");
    // Subject should identify this as a billing alert and include the event type
    expect(payload.subject).toMatch(/billing alert/i);
    expect(payload.subject).toContain("customer.subscription.deleted");
    // HTML body should include the event ID and reason
    expect(payload.html).toContain("evt_test_001");
    expect(payload.html).toContain(
      "No tenant matched by metadata, customer ID, or subscription ID",
    );
  });

  it("re-throws when Resend returns a non-2xx status so the caller is not silently misled", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.PLATFORM_ADMIN_EMAIL = "operator@example.com";

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }));

    // The webhook callers already wrap this in try-catch; the function must
    // re-throw so those callers know the notification attempt failed.
    await expect(
      sendBillingAlertNotification(alertArgs),
    ).rejects.toThrow();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("re-throws when fetch itself rejects (transient network failure)", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.PLATFORM_ADMIN_EMAIL = "operator@example.com";

    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new Error("ECONNREFUSED"),
    );

    await expect(
      sendBillingAlertNotification(alertArgs),
    ).rejects.toThrow("ECONNREFUSED");
  });
});

describe("sendBillingAlertNotification: slackFailure escalation in email body", () => {
  beforeEach(() => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.PLATFORM_ADMIN_EMAIL = "operator@example.com";
  });

  it("includes the Slack error detail in the HTML body when slackFailure is provided", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    await sendBillingAlertNotification({ ...alertArgs, slackFailure: "invalid_auth" });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(init.body as string);

    expect(payload.html).toContain("Slack notification failed");
    expect(payload.html).toContain("invalid_auth");
  });

  it("does NOT include a Slack failure section when slackFailure is omitted", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    await sendBillingAlertNotification(alertArgs);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(init.body as string);

    expect(payload.html).not.toContain("Slack notification failed");
  });

  it("truncates a very long slackFailure string to 300 chars in the email body", async () => {
    const longError = "x".repeat(500);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    await sendBillingAlertNotification({ ...alertArgs, slackFailure: longError });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(init.body as string);

    // The truncated error (300 x's) must appear; the full 500 x's must not be present
    expect(payload.html).toContain("x".repeat(300));
    expect(payload.html).not.toContain("x".repeat(301));
  });
});

describe("sendBillingAlertNotification: sender address (domain-rotation safety)", () => {
  afterEach(() => {
    delete process.env.RESEND_API_KEY;
    delete process.env.PLATFORM_ADMIN_EMAIL;
    delete process.env.EMAIL_FROM_ORDERS;
    delete process.env.EMAIL_FROM;
    // SMTP vars are restored by the top-level afterEach; explicitly clear them
    // here too so they cannot leak between tests within this describe block.
    for (const k of SMTP_VARS) delete process.env[k];
    vi.restoreAllMocks();
  });

  it("uses EMAIL_FROM_ORDERS as the from address when it is set", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.PLATFORM_ADMIN_EMAIL = "operator@example.com";
    process.env.EMAIL_FROM_ORDERS = "billing@custom-domain.com";

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    await sendBillingAlertNotification(alertArgs);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(init.body as string);
    expect(payload.from).toBe("billing@custom-domain.com");
  });

  it("falls back to EMAIL_FROM when EMAIL_FROM_ORDERS is not set", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.PLATFORM_ADMIN_EMAIL = "operator@example.com";
    process.env.EMAIL_FROM = "no-reply@shared-domain.com";
    // EMAIL_FROM_ORDERS intentionally absent

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    await sendBillingAlertNotification(alertArgs);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(init.body as string);
    expect(payload.from).toBe("no-reply@shared-domain.com");
  });

  it("falls back to the Resend sandbox sender when neither env var is set", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.PLATFORM_ADMIN_EMAIL = "operator@example.com";
    // No EMAIL_FROM_ORDERS, no EMAIL_FROM

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    await sendBillingAlertNotification(alertArgs);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(init.body as string);
    expect(payload.from).toBe("onboarding@resend.dev");
  });

  it("EMAIL_FROM_ORDERS takes precedence over EMAIL_FROM", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.PLATFORM_ADMIN_EMAIL = "operator@example.com";
    process.env.EMAIL_FROM_ORDERS = "orders@primary-domain.com";
    process.env.EMAIL_FROM = "noreply@fallback-domain.com";

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    await sendBillingAlertNotification(alertArgs);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(init.body as string);
    expect(payload.from).toBe("orders@primary-domain.com");
  });
});
