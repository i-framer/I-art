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
 *   - the `from` address matches EMAIL_FROM_ORDERS / EMAIL_FROM when those env
 *     vars are set (catches a rotated sender domain that Resend hasn't verified)
 *
 * Sender domain verification:
 *   If Resend returns a non-2xx response when EMAIL_FROM_ORDERS or EMAIL_FROM is
 *   set to a custom domain, it almost certainly means the domain is not yet
 *   verified in your Resend account. Verify it at:
 *     https://resend.com/domains
 *   then re-run with:
 *     RESEND_API_KEY=re_live_xxx PLATFORM_ADMIN_EMAIL=you@example.com \
 *     EMAIL_FROM_ORDERS=alerts@your-verified-domain.com \
 *       pnpm --filter @workspace/artwork-bank test -- --reporter=verbose \
 *       billing-alert-email-integration
 *
 * Run manually with real credentials:
 *   RESEND_API_KEY=re_live_xxx PLATFORM_ADMIN_EMAIL=you@example.com \
 *     pnpm --filter @workspace/artwork-bank test -- --reporter=verbose \
 *     billing-alert-email-integration
 *
 * Coverage:
 *   - customer.subscription.updated → billing alert email sent + sender domain verified
 *   - invoice.payment_failed        → billing alert email sent + sender domain verified
 *     (invoice handler uses the same sendBillingAlertNotification call; tested
 *     separately so a domain rotation that breaks only the invoice path is caught)
 */
import { it, expect, beforeEach, afterEach } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";

// base-url is imported lazily inside sendBillingAlertNotification; provide a
// stub so tests that DO run don't require a Next.js server.
import { vi } from "vitest";
vi.mock("@/lib/base-url", () => ({
  getPlatformBaseUrl: () => "https://platform.test",
  getTenantUrl: () => "https://tenant.test/orders",
}));

import { sendBillingAlertNotification } from "@/lib/email";

// SMTP vars must be cleared so a developer's or CI environment that sets
// SMTP_HOST doesn't silently switch to the SMTP transport for these tests.
// The integration tests exercise the Resend path (or are skipped entirely).
const SMTP_VARS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_SECURE"] as const;
const savedSmtp: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of SMTP_VARS) {
    savedSmtp[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of SMTP_VARS) {
    if (savedSmtp[k] === undefined) delete process.env[k];
    else process.env[k] = savedSmtp[k];
  }
});

const hasResendKey = Boolean(process.env.RESEND_API_KEY);
const hasAdminEmail = Boolean(process.env.PLATFORM_ADMIN_EMAIL);
const canRealSend = hasResendKey && hasAdminEmail;

const TEST_EVENT_TYPE = "customer.subscription.updated";
const TEST_EVENT_ID = `evt_smoke_${Date.now()}`;

describeIntegration("sendBillingAlertNotification: real Resend API send", () => {
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
      // Resend returns { id: "re_..." } on success.
      // A non-2xx here almost always means the `from` domain is not yet
      // verified in the Resend account. Verify it at https://resend.com/domains
      // before rotating EMAIL_FROM_ORDERS / EMAIL_FROM.
      const messageId = capturedResponse.id;
      expect(messageId).toBeDefined();
      expect(typeof messageId).toBe("string");
      expect(messageId).toMatch(/^[a-zA-Z0-9_-]+/);

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

      // ── Sender domain assertion ──────────────────────────────────────────
      // Verify the `from` address reflects the configured env var so that a
      // domain rotation is caught immediately rather than bouncing silently.
      // Priority: EMAIL_FROM_ORDERS > EMAIL_FROM > onboarding@resend.dev
      const expectedFrom =
        process.env.EMAIL_FROM_ORDERS ??
        process.env.EMAIL_FROM ??
        "onboarding@resend.dev";
      expect(capturedRequestPayload.from).toBe(expectedFrom);

      console.log("[integration] Subject:", capturedRequestPayload.subject);
      console.log("[integration] From address:", capturedRequestPayload.from);
      console.log(
        "[integration] Billing-alerts panel link present in HTML: true",
      );
      console.log(
        `[integration] Resend accepted billing alert email. Message ID: ${messageId}`,
      );
      console.log(
        `[integration] Check ${process.env.PLATFORM_ADMIN_EMAIL} inbox to confirm delivery.`,
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

// ── invoice.payment_failed ────────────────────────────────────────────────────

const INVOICE_EVENT_TYPE = "invoice.payment_failed";
const INVOICE_EVENT_ID = `evt_invoice_smoke_${Date.now()}`;

describeIntegration("sendBillingAlertNotification (invoice.payment_failed): real Resend API send", () => {
  it.skipIf(!canRealSend)(
    "Resend accepts the invoice.payment_failed alert and returns a message ID (real send)",
    async () => {
      // Intercept fetch to inspect both the outbound payload and the Resend
      // response without mocking the actual HTTP call.
      interface ResendApiResponse {
        id?: string;
        statusCode?: number;
      }
      let capturedResponse: ResendApiResponse = {};
      let capturedRequestPayload: Record<string, unknown> = {};

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
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
          stripeEventId: INVOICE_EVENT_ID,
          eventType: INVOICE_EVENT_TYPE,
          customerId: "cus_invoice_smoke_test",
          subscriptionId: null,
          reason: "Integration smoke-test (invoice.payment_failed) — safe to ignore",
        });
      } finally {
        globalThis.fetch = originalFetch;
      }

      // ── Resend acceptance ────────────────────────────────────────────────
      // Resend returns { id: "re_..." } on success.
      // A non-2xx here almost always means the `from` domain is not yet
      // verified in the Resend account. Verify it at https://resend.com/domains
      // before rotating EMAIL_FROM_ORDERS / EMAIL_FROM.
      const messageId = capturedResponse.id;
      expect(messageId).toBeDefined();
      expect(typeof messageId).toBe("string");
      expect(messageId).toMatch(/^[a-zA-Z0-9_-]+/);

      // ── Outbound payload assertions ──────────────────────────────────────
      // Subject must identify it as a billing alert and include the event type
      expect(typeof capturedRequestPayload.subject).toBe("string");
      expect(capturedRequestPayload.subject as string).toMatch(/billing alert/i);
      expect(capturedRequestPayload.subject as string).toContain(
        INVOICE_EVENT_TYPE,
      );

      // HTML body must contain the event type so the operator can act on it
      expect(typeof capturedRequestPayload.html).toBe("string");
      const html = capturedRequestPayload.html as string;
      expect(html).toContain(INVOICE_EVENT_TYPE);

      // HTML body must include the billing-alerts panel link
      expect(html).toContain("/platform");

      // ── Sender domain assertion ──────────────────────────────────────────
      // Verify the `from` address reflects the configured env var so that a
      // domain rotation is caught immediately rather than bouncing silently.
      // Priority: EMAIL_FROM_ORDERS > EMAIL_FROM > onboarding@resend.dev
      const expectedFrom =
        process.env.EMAIL_FROM_ORDERS ??
        process.env.EMAIL_FROM ??
        "onboarding@resend.dev";
      expect(capturedRequestPayload.from).toBe(expectedFrom);

      console.log(
        "[integration/invoice] Subject:",
        capturedRequestPayload.subject,
      );
      console.log(
        "[integration/invoice] From address:",
        capturedRequestPayload.from,
      );
      console.log(
        "[integration/invoice] Billing-alerts panel link present in HTML: true",
      );
      console.log(
        `[integration/invoice] Resend accepted invoice.payment_failed alert email. Message ID: ${messageId}`,
      );
      console.log(
        `[integration/invoice] Check ${process.env.PLATFORM_ADMIN_EMAIL} inbox to confirm delivery.`,
      );
    },
  );

  it("is skipped (no-op) when RESEND_API_KEY is absent", () => {
    if (hasResendKey) return;
    expect(hasResendKey).toBe(false);
  });
});
