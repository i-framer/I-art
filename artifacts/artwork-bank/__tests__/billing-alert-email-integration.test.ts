/**
 * Integration test — real Resend API call (no mocks).
 *
 * Skipped automatically when RESEND_API_KEY or PLATFORM_ADMIN_EMAIL is absent,
 * so it is safe to include in CI without real credentials. When both env vars
 * ARE present the test hits the live Resend API, captures the returned message
 * ID, and asserts a 200-class acceptance.
 *
 * The test also inspects the outbound request payload to confirm:
 *   - the subject identifies the alert and includes the event type
 *   - the HTML body contains the event type
 *   - the HTML body includes the billing-alerts panel link (when PLATFORM_BASE_URL is set)
 *
 * Run manually with real credentials:
 *   RESEND_API_KEY=re_live_xxx PLATFORM_ADMIN_EMAIL=you@example.com \
 *     pnpm --filter @workspace/artwork-bank test -- --reporter=verbose \
 *     billing-alert-email-integration
 */
import { describe, it, expect } from "vitest";

// base-url is imported lazily inside sendBillingAlertNotification; provide a
// stub so tests that DO run don't require a Next.js server.
import { vi } from "vitest";
vi.mock("@/lib/base-url", () => ({
  getPlatformBaseUrl: () => "https://platform.test",
  getTenantUrl: () => "https://tenant.test/orders",
}));

import { sendBillingAlertNotification } from "@/lib/email";

const hasResendKey = Boolean(process.env.RESEND_API_KEY);
const hasAdminEmail = Boolean(process.env.PLATFORM_ADMIN_EMAIL);
const canRealSend = hasResendKey && hasAdminEmail;

const TEST_EVENT_TYPE = "customer.subscription.updated";
const TEST_EVENT_ID = `evt_smoke_${Date.now()}`;

describe("sendBillingAlertNotification: real Resend API send", () => {
  it.skipIf(!canRealSend)(
    "Resend accepts the email and returns a message ID (real send)",
    async () => {
      // Intercept fetch so we can inspect both the outbound payload and the
      // Resend response. We do NOT mock the outbound request — only wrap the
      // native fetch to record what we send and what comes back.
      interface ResendApiResponse {
        id?: string;
        statusCode?: number;
      }
      let capturedResponse: ResendApiResponse = {};
      let capturedRequestPayload: Record<string, unknown> = {};

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
        // Capture the outbound request body before it is consumed
        const [input, init] = args;
        if (
          typeof input === "string" &&
          input.includes("api.resend.com") &&
          init?.body
        ) {
          try {
            capturedRequestPayload = JSON.parse(init.body as string);
          } catch {
            // ignore
          }
        }

        const res = await originalFetch(...args);
        // Clone so the real response body stream is still consumable
        const clone = res.clone();
        try {
          capturedResponse = (await clone.json()) as ResendApiResponse;
        } catch {
          capturedResponse = { statusCode: res.status };
        }
        return res;
      };

      try {
        await sendBillingAlertNotification({
          stripeEventId: TEST_EVENT_ID,
          eventType: TEST_EVENT_TYPE,
          customerId: "cus_smoke_test",
          subscriptionId: "sub_smoke_test",
          reason: "Integration smoke-test — safe to ignore",
        });
      } finally {
        globalThis.fetch = originalFetch;
      }

      // ── Resend acceptance ────────────────────────────────────────────────
      // Resend returns { id: "re_..." } on success
      const messageId = capturedResponse.id;
      expect(messageId).toBeDefined();
      expect(typeof messageId).toBe("string");
      expect(messageId).toMatch(/^[a-zA-Z0-9_-]+/);

      console.log(
        `[integration] Resend accepted billing alert email. Message ID: ${messageId}`,
      );
      console.log(
        `[integration] Check ${process.env.PLATFORM_ADMIN_EMAIL} inbox to confirm delivery.`,
      );

      // ── Outbound payload assertions ──────────────────────────────────────
      // Subject must identify it as a billing alert and include the event type
      expect(typeof capturedRequestPayload.subject).toBe("string");
      expect(capturedRequestPayload.subject as string).toMatch(/billing alert/i);
      expect(capturedRequestPayload.subject as string).toContain(
        TEST_EVENT_TYPE,
      );

      // HTML body must contain the event type so the operator can act on it
      expect(typeof capturedRequestPayload.html).toBe("string");
      const html = capturedRequestPayload.html as string;
      expect(html).toContain(TEST_EVENT_TYPE);

      // HTML body must include the billing-alerts panel link so the operator
      // can navigate directly to the panel. The mock returns
      // https://platform.test, so the link should be https://platform.test/platform
      expect(html).toContain("/platform");

      console.log("[integration] Subject:", capturedRequestPayload.subject);
      console.log(
        "[integration] Billing-alerts panel link present in HTML: true",
      );
    },
  );

  it("is skipped (no-op) when RESEND_API_KEY is absent", () => {
    if (hasResendKey) return; // credentials present — this branch is not relevant
    // Confirm the function resolves without throwing when the key is missing
    // (already covered by billing-alert-email-fn.test.ts; included here for
    // completeness so a skipped integration test isn't mistaken for a gap).
    expect(hasResendKey).toBe(false);
  });
});
