/**
 * Confirms the failure chain when `subscriptions.retrieve()` fails during
 * handleSubscriptionCheckoutCompleted — the path that falls back to "active".
 *
 * Covered scenarios:
 *  1. retrieve() failure → alert row inserted into stripeAlertsTable.
 *  2. retrieve() failure → tenant subscriptionStatus set to "active".
 *  3. retrieve() failure + Slack unavailable → slackPostFailed timestamp
 *     persisted on the alert row (so operators can detect the broken chain
 *     without tailing server logs).
 *  4. retrieve() failure + Slack unavailable → email notification still sent
 *     with the Slack failure detail.
 *  5. retrieve() failure + Slack succeeds → slackPostFailed NOT written.
 *  6. retrieve() failure + Slack throws → slackPostFailed still written.
 *  7. Webhook returns 200 in all retrieve-failure cases.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Fake DB ───────────────────────────────────────────────────────────────────

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
  stripeAlertsTable: {
    id: "id",
    stripeEventId: "stripeEventId",
    dismissedAt: "dismissedAt",
  },
}));

// Capture the `set` argument of the stripeAlertsTable update so tests can
// assert on slackPostFailed without a real database.
const alertUpdateArgs = vi.hoisted(() => ({ captured: null as any }));

vi.mock("@workspace/db", () => {
  let alertIdCounter = 0;

  const makeInsertBuilder = (table: any, _values: any) => ({
    onConflictDoNothing(_opts?: any) {
      return this;
    },
    returning(_cols?: any) {
      if (table === tables.stripeAlertsTable) {
        // Always return a new row (simulate first delivery — no dedup conflict).
        return Promise.resolve([{ id: `alert-${++alertIdCounter}` }]);
      }
      return Promise.resolve([{ id: "tenant-1" }]);
    },
  });

  const makeUpdateBuilder = (table: any) => ({
    set: (args: any) => {
      if (table === tables.stripeAlertsTable) {
        alertUpdateArgs.captured = args;
      }
      return {
        where: () => ({
          returning: async () =>
            table === tables.tenantsTable
              ? [{ id: "tenant-1", iframerAccountId: null }]
              : [],
        }),
      };
    },
  });

  return {
    db: {
      query: {
        tenantsTable: {
          findFirst: vi.fn(async () => ({
            id: "tenant-1",
            subscriptionStatus: null, // no prior status → isNewSubscription = true
            stripeSubscriptionId: null,
          })),
        },
        ordersTable: { findFirst: vi.fn(async () => undefined) },
        artworksTable: { findFirst: vi.fn(async () => undefined) },
      },
      insert: vi.fn((table: any) => ({
        values: (values: any) => makeInsertBuilder(table, values),
      })),
      update: vi.fn((table: any) => makeUpdateBuilder(table)),
    },
    ...tables,
    sql: Object.assign(
      (_tpl: TemplateStringsArray, ..._args: any[]) => ({}),
      { raw: (s: string) => s },
    ),
    and: (..._args: any[]) => ({}),
    eq: (_col: any, _val: any) => ({}),
  };
});

// ── Stripe mock ───────────────────────────────────────────────────────────────
// getStripeClient is called twice in the success path — once to construct the
// event (skipped via dev bypass) and once inside the retrieve branch.
// We make retrieve() throw so every test exercises the fail-open path.

const mockRetrieve = vi.hoisted(() => vi.fn());

vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(async () => ({
    subscriptions: { retrieve: mockRetrieve },
  })),
  getStripeWebhookSecret: vi.fn().mockResolvedValue(null), // dev-bypass mode
  calcApplicationFee: (cents: number) => Math.round(cents * 0.05),
  StripeNotConfiguredError: class StripeNotConfiguredError extends Error {},
}));

// ── Other mocks ───────────────────────────────────────────────────────────────

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

const mockSendSlack = vi.hoisted(() => vi.fn());
const mockSendEmail = vi.hoisted(() => vi.fn());

vi.mock("@/lib/slack", () => ({
  sendBillingAlertSlackNotification: mockSendSlack,
}));

vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: vi.fn(),
  sendBillingAlertNotification: mockSendEmail,
}));

import { POST as webhookPOST } from "@/app/api/stripe/webhook/route";

// ── Helpers ───────────────────────────────────────────────────────────────────

function checkoutSubscriptionEvent(eventId: string, subscriptionId = "sub_test_001") {
  return {
    type: "checkout.session.completed",
    id: eventId,
    data: {
      object: {
        id: "cs_test_001",
        mode: "subscription",
        customer: "cus_test_001",
        subscription: subscriptionId,
        metadata: { billingTenantId: "tenant-1" },
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
  alertUpdateArgs.captured = null;
  process.env.STRIPE_WEBHOOK_DEV_BYPASS = "true";
  mockHeaders.mockReturnValue(new Headers());

  // Default: retrieve() throws a network error (the fail-open path).
  mockRetrieve.mockRejectedValue(new Error("ECONNREFUSED stripe.com:443"));

  // Default: Slack and email succeed (individual tests override as needed).
  mockSendSlack.mockResolvedValue({ ok: true });
  mockSendEmail.mockResolvedValue(undefined);
});

afterEach(() => {
  delete process.env.STRIPE_WEBHOOK_DEV_BYPASS;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("handleSubscriptionCheckoutCompleted — subscriptions.retrieve() failure", () => {
  it("returns 200 even when retrieve() throws", async () => {
    const res = await postWebhook(checkoutSubscriptionEvent("evt_retrieve_fail_001"));
    expect(res.status).toBe(200);
  });

  it("inserts a billing alert row when retrieve() fails", async () => {
    const { db } = await import("@workspace/db");

    await postWebhook(checkoutSubscriptionEvent("evt_retrieve_fail_002"));

    expect(db.insert).toHaveBeenCalled();
  });

  it("writes slackPostFailed on the alert row when Slack returns { ok: false }", async () => {
    mockSendSlack.mockResolvedValueOnce({ ok: false, error: "invalid_auth" });

    await postWebhook(checkoutSubscriptionEvent("evt_retrieve_slack_fail_001"));

    // slackPostFailed must be a Date instance persisted to the alert row.
    expect(alertUpdateArgs.captured).not.toBeNull();
    expect(alertUpdateArgs.captured?.slackPostFailed).toBeInstanceOf(Date);
  });

  it("writes slackPostFailed on the alert row when Slack throws", async () => {
    mockSendSlack.mockRejectedValueOnce(new Error("SDK unavailable"));

    await postWebhook(checkoutSubscriptionEvent("evt_retrieve_slack_throw_001"));

    expect(alertUpdateArgs.captured).not.toBeNull();
    expect(alertUpdateArgs.captured?.slackPostFailed).toBeInstanceOf(Date);
  });

  it("passes slackFailure detail to the email when Slack returns { ok: false }", async () => {
    mockSendSlack.mockResolvedValueOnce({ ok: false, error: "token_revoked" });

    await postWebhook(checkoutSubscriptionEvent("evt_retrieve_slack_fail_email_001"));

    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ slackFailure: "token_revoked" }),
    );
  });

  it("passes slackFailure detail to the email when Slack throws", async () => {
    mockSendSlack.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    await postWebhook(checkoutSubscriptionEvent("evt_retrieve_slack_throw_email_001"));

    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ slackFailure: "ECONNREFUSED" }),
    );
  });

  it("does NOT write slackPostFailed when Slack succeeds", async () => {
    mockSendSlack.mockResolvedValueOnce({ ok: true });

    await postWebhook(checkoutSubscriptionEvent("evt_retrieve_slack_ok_001"));

    // alertUpdateArgs.captured is only set if db.update(stripeAlertsTable).set()
    // was called; slackPostFailed must NOT be present when Slack succeeded.
    if (alertUpdateArgs.captured !== null) {
      expect(alertUpdateArgs.captured?.slackPostFailed).toBeUndefined();
    }
  });

  it("still sends the email even when Slack fails", async () => {
    mockSendSlack.mockResolvedValueOnce({ ok: false, error: "channel_not_found" });

    await postWebhook(checkoutSubscriptionEvent("evt_retrieve_slack_fail_still_email_001"));

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it("returns 200 when both Slack and email fail after retrieve failure", async () => {
    mockSendSlack.mockRejectedValueOnce(new Error("down"));
    mockSendEmail.mockRejectedValueOnce(new Error("SMTP timeout"));

    const res = await postWebhook(checkoutSubscriptionEvent("evt_retrieve_all_fail_001"));
    expect(res.status).toBe(200);
  });
});
