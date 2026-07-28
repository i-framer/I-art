/**
 * Unit-tests sendBillingAlertNotification directly (not through the webhook).
 *
 * Coverage:
 *  - RESEND_API_KEY not set → resolves without throwing
 *  - PLATFORM_ADMIN_EMAIL not set → resolves without throwing
 *  - Both vars set → fetch called with correct URL, recipient, and subject
 *  - Resend returns non-2xx → resolves without throwing (non-fatal by design)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// base-url is imported lazily inside sendBillingAlertNotification; mock it so
// the test environment doesn't need a real Next.js server URL.
vi.mock("@/lib/base-url", () => ({
  getPlatformBaseUrl: () => "https://platform.test",
  getTenantUrl: () => "https://tenant.test/orders",
}));

import { sendBillingAlertNotification } from "@/lib/email";

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
});

afterEach(() => {
  delete process.env.RESEND_API_KEY;
  delete process.env.PLATFORM_ADMIN_EMAIL;
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

  it("resolves without throwing when Resend returns a non-2xx status", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.PLATFORM_ADMIN_EMAIL = "operator@example.com";

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }));

    // Must not throw — the webhook already committed the alert row and must
    // return 200 to Stripe regardless of the notification outcome.
    await expect(
      sendBillingAlertNotification(alertArgs),
    ).resolves.toBeUndefined();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("resolves without throwing when fetch itself rejects (network failure)", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.PLATFORM_ADMIN_EMAIL = "operator@example.com";

    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new Error("ECONNREFUSED"),
    );

    await expect(
      sendBillingAlertNotification(alertArgs),
    ).resolves.toBeUndefined();
  });
});
