/**
 * Stripe webhook — payment_intent.* events are safely ignored.
 *
 * The webhook handler explicitly processes checkout.session.* and
 * customer.subscription.* events; payment_intent.* events are not handled.
 * These tests verify that payment_intent events:
 *  - do not trigger any order mutation
 *  - return a 2xx response (not an error) to prevent Stripe retries
 *
 * Uses the same STRIPE_WEBHOOK_DEV_BYPASS pattern as the existing
 * webhook tests to skip signature verification.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Suppress STRIPE_WEBHOOK_DEV_BYPASS from env (set it explicitly per test) ──
const originalDevBypass = process.env.STRIPE_WEBHOOK_DEV_BYPASS;
delete process.env.STRIPE_WEBHOOK_DEV_BYPASS;

// ── Stripe client mock ────────────────────────────────────────────────────────
// getStripeWebhookSecret returns null so the route enters the devBypass path,
// not the signature-verification path.
vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(),
  getStripeWebhookSecret: vi.fn().mockResolvedValue(null),
  StripeNotConfiguredError: class extends Error {},
  calcApplicationFee: vi.fn().mockReturnValue(0),
}));

// ── DB mock ────────────────────────────────────────────────────────────────────
vi.mock("@workspace/db", () => ({
  db: {
    query: {
      ordersTable: { findFirst: vi.fn().mockResolvedValue(null) },
      tenantsTable: { findFirst: vi.fn().mockResolvedValue(null) },
    },
    update: vi.fn(() => ({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn().mockResolvedValue(undefined),
    })),
  },
  ordersTable: {},
  tenantsTable: {},
  orderItemsTable: {},
  eq: vi.fn(),
  and: vi.fn(),
}));

// ── next/server mock ──────────────────────────────────────────────────────────
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
  },
}));

// ── next/headers mock ─────────────────────────────────────────────────────────
const mockHeaders = vi.hoisted(() => vi.fn());
vi.mock("next/headers", () => ({ headers: () => mockHeaders() }));

// ── email/billing/object-storage mocks ────────────────────────────────────────
vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: vi.fn(),
  sendBillingAlertNotification: vi.fn(),
}));
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/object-storage", () => ({
  getObjectUrl: vi.fn().mockResolvedValue("https://storage.test/img.jpg"),
}));
vi.mock("@/lib/base-url", () => ({
  getTenantUrl: vi.fn().mockReturnValue("https://tenant.test"),
}));

import { POST } from "@/app/api/stripe/webhook/route";
import { db } from "@workspace/db";

function makeWebhookRequest(eventType: string): Request {
  const event = {
    type: eventType,
    data: { object: { id: "pi_test_123", amount: 5000, currency: "aud" } },
  };
  return new Request("http://localhost/api/stripe/webhook", {
    method: "POST",
    body: JSON.stringify(event),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // No stripe-signature → webhookSecret is null → devBypass path is used
  mockHeaders.mockReturnValue({ get: () => null });
  process.env.STRIPE_WEBHOOK_DEV_BYPASS = "true";
});

afterEach(() => {
  delete process.env.STRIPE_WEBHOOK_DEV_BYPASS;
  if (originalDevBypass !== undefined) {
    process.env.STRIPE_WEBHOOK_DEV_BYPASS = originalDevBypass;
  }
});

describe("Stripe webhook — payment_intent events are safely ignored", () => {
  const paymentIntentEvents = [
    "payment_intent.succeeded",
    "payment_intent.payment_failed",
    "payment_intent.created",
    "payment_intent.canceled",
    "payment_intent.processing",
    "payment_intent.requires_action",
  ];

  for (const eventType of paymentIntentEvents) {
    it(`returns 2xx for ${eventType} without mutating any order`, async () => {
      const req = makeWebhookRequest(eventType);

      const res = await POST(req);

      // Must respond 2xx so Stripe does not retry
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);

      // Must not have triggered any DB update (no order mutation)
      expect(db.update).not.toHaveBeenCalled();
    });
  }

  it("does not call any email sender for payment_intent events", async () => {
    const { sendOrderConfirmation, sendBillingAlertNotification } = await import("@/lib/email");

    const req = makeWebhookRequest("payment_intent.succeeded");
    await POST(req);

    expect(sendOrderConfirmation).not.toHaveBeenCalled();
    expect(sendBillingAlertNotification).not.toHaveBeenCalled();
  });
});
