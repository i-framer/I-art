/**
 * Verifies that a Slack auth failure during billing-alert dispatch is escalated
 * to the operator via the alert email — so the operator does not need to tail
 * server logs to discover a broken Slack connector.
 *
 * Coverage:
 *  - When sendBillingAlertSlackNotification returns { ok: false }, the email
 *    notification includes the Slack error detail (subscription event path)
 *  - When sendBillingAlertSlackNotification returns { ok: false }, the email
 *    notification includes the Slack error detail (invoice.payment_failed path)
 *  - When Slack succeeds ({ ok: true }), the email does NOT include a Slack
 *    failure warning
 *  - When Slack throws an unexpected exception, the failure is still propagated
 *    to the email
 *  - sendBillingAlertNotification receives slackFailure when Slack reports an
 *    HTTP-level error (non-ok status)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Fake DB ───────────────────────────────────────────────────────────────────
// Minimal DB mock: always inserts a new row so the notification path is taken.

const tables = vi.hoisted(() => ({
  ordersTable: { stripeSessionId: "stripeSessionId", id: "id" },
  orderItemsTable: {},
  artworksTable: { id: "id", tenantId: "tenantId", status: "status" },
  tenantsTable: {
    id: "id",
    stripeCustomerId: "stripeCustomerId",
    stripeSubscriptionId: "stripeSubscriptionId",
    subscriptionStatus: "subscriptionStatus",
  },
  stripeAlertsTable: { id: "id", stripeEventId: "stripeEventId", dismissedAt: "dismissedAt" },
}));

vi.mock("@workspace/db", () => {
  let alertIdCounter = 0;

  const makeInsertBuilder = (table: any, _values: any) => ({
    onConflictDoNothing(_opts?: any) {
      return this;
    },
    returning(_cols?: any) {
      if (table === tables.stripeAlertsTable) {
        // Always return a new row (no dedup in these tests)
        return Promise.resolve([{ id: `alert-${++alertIdCounter}` }]);
      }
      return Promise.resolve([]);
    },
  });

  return {
    db: {
      query: {
        tenantsTable: { findFirst: vi.fn(async () => undefined) },
        ordersTable: { findFirst: vi.fn(async () => undefined) },
        artworksTable: { findFirst: vi.fn(async () => undefined) },
      },
      insert: vi.fn((table: any) => ({
        values: (values: any) => makeInsertBuilder(table, values),
      })),
      update: vi.fn(() => ({
        set: () => ({
          where: () => ({ returning: async () => [] }),
        }),
      })),
    },
    ...tables,
    sql: Object.assign((_tpl: TemplateStringsArray, ..._args: any[]) => ({}), {
      raw: (s: string) => s,
    }),
  };
});

vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(),
  getStripeWebhookSecret: vi.fn().mockResolvedValue(null),
  calcApplicationFee: (cents: number) => Math.round(cents * 0.05),
  StripeNotConfiguredError: class StripeNotConfiguredError extends Error {},
}));

vi.mock("@/lib/base-url", () => ({
  getPlatformBaseUrl: vi.fn().mockReturnValue("https://example.com"),
  getTenantUrl: vi.fn(() => "http://localhost"),
}));

vi.mock("@/lib/iframer", () => ({
  createIFramerJob: vi.fn(),
  IFramerError: class IFramerError extends Error {},
}));

const mockHeaders = vi.hoisted(() => vi.fn());
vi.mock("next/headers", () => ({
  headers: () => mockHeaders(),
}));

// Mocks for the two notification helpers — we control Slack's return value per
// test and spy on the email call to assert what arguments it received.
const mockSendBillingAlertSlack = vi.hoisted(() => vi.fn());
const mockSendBillingAlertEmail = vi.hoisted(() => vi.fn());

vi.mock("@/lib/slack", () => ({
  sendBillingAlertSlackNotification: mockSendBillingAlertSlack,
}));

vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: vi.fn(),
  sendBillingAlertNotification: mockSendBillingAlertEmail,
}));

import { POST as webhookPOST } from "@/app/api/stripe/webhook/route";

// ── Helpers ───────────────────────────────────────────────────────────────────

function subscriptionEvent(eventId: string, type = "customer.subscription.updated") {
  return {
    type,
    id: eventId,
    data: {
      object: {
        id: "sub_unmatched_001",
        status: "active",
        customer: "cus_unmatched_001",
        metadata: {},
      },
    },
  };
}

function invoiceEvent(eventId: string) {
  return {
    type: "invoice.payment_failed",
    id: eventId,
    data: {
      object: {
        id: "in_unmatched_001",
        customer: "cus_unmatched_invoice",
        subscription: "sub_invoice_001",
      },
    },
  };
}

async function postWebhook(payload: object) {
  return webhookPOST(
    new Request("http://localhost/api/stripe/webhook", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  );
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_WEBHOOK_DEV_BYPASS = "true";
  mockHeaders.mockReturnValue(new Headers());
  mockSendBillingAlertEmail.mockResolvedValue(undefined);
});

afterEach(() => {
  delete process.env.STRIPE_WEBHOOK_DEV_BYPASS;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Slack auth failure escalation — subscription events", () => {
  it("passes slackFailure to sendBillingAlertNotification when Slack returns { ok: false }", async () => {
    mockSendBillingAlertSlack.mockResolvedValueOnce({
      ok: false,
      error: "invalid_auth",
    });

    const res = await postWebhook(subscriptionEvent("evt_slack_fail_sub_001"));
    expect(res.status).toBe(200);

    expect(mockSendBillingAlertEmail).toHaveBeenCalledTimes(1);
    expect(mockSendBillingAlertEmail).toHaveBeenCalledWith(
      expect.objectContaining({ slackFailure: "invalid_auth" }),
    );
  });

  it("passes slackFailure when Slack returns a non-auth HTTP error", async () => {
    mockSendBillingAlertSlack.mockResolvedValueOnce({
      ok: false,
      error: "HTTP 503",
    });

    await postWebhook(subscriptionEvent("evt_slack_fail_sub_503"));

    expect(mockSendBillingAlertEmail).toHaveBeenCalledWith(
      expect.objectContaining({ slackFailure: "HTTP 503" }),
    );
  });

  it("passes slackFailure to the email when Slack throws an unexpected exception", async () => {
    mockSendBillingAlertSlack.mockRejectedValueOnce(new Error("SDK unavailable"));

    const res = await postWebhook(subscriptionEvent("evt_slack_throw_sub_001"));
    expect(res.status).toBe(200);

    expect(mockSendBillingAlertEmail).toHaveBeenCalledWith(
      expect.objectContaining({ slackFailure: "SDK unavailable" }),
    );
  });

  it("does NOT pass slackFailure to the email when Slack succeeds", async () => {
    mockSendBillingAlertSlack.mockResolvedValueOnce({ ok: true });

    await postWebhook(subscriptionEvent("evt_slack_ok_sub_001"));

    expect(mockSendBillingAlertEmail).toHaveBeenCalledTimes(1);
    // slackFailure must be absent (or undefined) when Slack succeeded
    const callArgs = mockSendBillingAlertEmail.mock.calls[0][0];
    expect(callArgs.slackFailure).toBeUndefined();
  });
});

describe("Slack auth failure escalation — invoice.payment_failed events", () => {
  it("passes slackFailure to sendBillingAlertNotification when Slack returns { ok: false }", async () => {
    mockSendBillingAlertSlack.mockResolvedValueOnce({
      ok: false,
      error: "token_revoked",
    });

    const res = await postWebhook(invoiceEvent("evt_slack_fail_inv_001"));
    expect(res.status).toBe(200);

    expect(mockSendBillingAlertEmail).toHaveBeenCalledTimes(1);
    expect(mockSendBillingAlertEmail).toHaveBeenCalledWith(
      expect.objectContaining({ slackFailure: "token_revoked" }),
    );
  });

  it("passes slackFailure to the email when Slack throws during invoice.payment_failed", async () => {
    mockSendBillingAlertSlack.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    await postWebhook(invoiceEvent("evt_slack_throw_inv_001"));

    expect(mockSendBillingAlertEmail).toHaveBeenCalledWith(
      expect.objectContaining({ slackFailure: "ECONNREFUSED" }),
    );
  });

  it("does NOT pass slackFailure when Slack succeeds for invoice.payment_failed", async () => {
    mockSendBillingAlertSlack.mockResolvedValueOnce({ ok: true });

    await postWebhook(invoiceEvent("evt_slack_ok_inv_001"));

    const callArgs = mockSendBillingAlertEmail.mock.calls[0][0];
    expect(callArgs.slackFailure).toBeUndefined();
  });
});

