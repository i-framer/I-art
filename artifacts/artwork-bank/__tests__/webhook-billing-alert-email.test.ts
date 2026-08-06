/**
 * Billing-alert email resilience:
 *
 * sendBillingAlertNotification re-throws on transport failure. All three call
 * sites in the webhook handler wrap it in try-catch, but these tests make that
 * guarantee explicit so a future refactor that accidentally drops a catch block
 * will fail here rather than causing Stripe to retry the event indefinitely.
 *
 * Covered paths:
 *  1. retrieve-failure path  — checkout.session.completed (mode=subscription)
 *                              when subscriptions.retrieve throws
 *  2. subscription event     — customer.subscription.* when no tenant matched
 *  3. invoice.payment_failed — when no tenant matched for the customer ID
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Shared mutable state ──────────────────────────────────────────────────────
const state = vi.hoisted(() => ({
  // Controls what db.update().set().where().returning() resolves to.
  // Some calls need [] (no rows touched), others need [{ id }].
  updateReturning: [] as any[],
  // Controls what db.insert().values()...returning() resolves to.
  insertReturning: [] as any[],
  // Controls what db.query.tenantsTable.findFirst resolves to.
  tenantRow: undefined as any,
  // Tracks how many times insert was called.
  insertCalls: 0,
  // Tracks update calls
  updateCalls: 0,
}));

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
  stripeAlertsTable: { id: "id", stripeEventId: "stripeEventId" },
}));

vi.mock("@workspace/db", () => {
  const makeUpdate = () => ({
    set: (_vals: any) => ({
      where: (_cond: any) => {
        state.updateCalls++;
        const result = Promise.resolve(state.updateReturning);
        (result as any).returning = () => {
          return Promise.resolve(state.updateReturning);
        };
        return result;
      },
    }),
  });

  const makeInsert = () => ({
    values: (_vals: any) => ({
      onConflictDoNothing: (_opts: any) => ({
        returning: (_cols: any) => {
          state.insertCalls++;
          return Promise.resolve(state.insertReturning);
        },
      }),
    }),
  });

  return {
    db: {
      query: {
        ordersTable: { findFirst: vi.fn(async () => undefined) },
        artworksTable: { findFirst: vi.fn(async () => undefined) },
        tenantsTable: { findFirst: vi.fn(async () => state.tenantRow) },
      },
      update: vi.fn(() => makeUpdate()),
      insert: vi.fn(() => makeInsert()),
      transaction: vi.fn(() => {
        throw new Error("billing-alert tests must not open transactions");
      }),
    },
    ...tables,
  };
});

// ── Stripe client mock ────────────────────────────────────────────────────────
// retrieveImpl is overridden per-test.
const stripeClientMock = vi.hoisted(() => ({
  retrieveImpl: async (_id: string): Promise<any> => ({ status: "active", trial_end: null }),
}));

vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(async () => ({
    subscriptions: {
      retrieve: (id: string) => stripeClientMock.retrieveImpl(id),
    },
    webhooks: { constructEvent: vi.fn() },
  })),
  getStripeWebhookSecret: vi.fn().mockResolvedValue(null),
  calcApplicationFee: (cents: number) => Math.round(cents * 0.05),
  StripeNotConfiguredError: class StripeNotConfiguredError extends Error {},
}));

// ── Email mocks ───────────────────────────────────────────────────────────────
const emailMock = vi.hoisted(() => ({
  sendBillingAlertNotification: vi.fn(),
  sendOrderConfirmation: vi.fn(),
}));

vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: emailMock.sendOrderConfirmation,
  sendBillingAlertNotification: emailMock.sendBillingAlertNotification,
}));

// ── Slack mock ────────────────────────────────────────────────────────────────
vi.mock("@/lib/slack", () => ({
  sendBillingAlertSlackNotification: vi.fn(async () => ({ ok: true })),
}));

// ── Other mocks ───────────────────────────────────────────────────────────────
vi.mock("@/lib/iframer", () => ({
  createIFramerJob: vi.fn(),
  IFramerError: class IFramerError extends Error {},
}));

vi.mock("@/lib/base-url", () => ({ getTenantUrl: vi.fn(() => "https://example.com") }));

const mockHeaders = vi.hoisted(() => vi.fn());
vi.mock("next/headers", () => ({ headers: () => mockHeaders() }));

import { POST as webhookPOST } from "@/app/api/stripe/webhook/route";

function post(event: any) {
  return webhookPOST(
    new Request("http://localhost/api/stripe/webhook", {
      method: "POST",
      body: JSON.stringify(event),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.updateReturning = [];
  state.insertReturning = [];
  state.tenantRow = undefined;
  state.insertCalls = 0;
  state.updateCalls = 0;

  // Default: billing alert email succeeds (individual tests override to throw)
  emailMock.sendBillingAlertNotification.mockResolvedValue(undefined);

  // Default: Stripe retrieve succeeds
  stripeClientMock.retrieveImpl = async () => ({ status: "active", trial_end: null });

  // Dev bypass so we skip signature verification
  process.env.STRIPE_WEBHOOK_DEV_BYPASS = "true";
  mockHeaders.mockResolvedValue(new Headers());
});

// ── Path 1: retrieve-failure in handleSubscriptionCheckoutCompleted ──────────

describe("billing alert email fails — retrieve-failure path", () => {
  /**
   * checkout.session.completed (mode=subscription) where subscriptions.retrieve
   * throws. The webhook creates a billing-alert row and tries to email the
   * operator. Even when that email throws a network error the webhook MUST
   * still return 200 so Stripe does not retry.
   */
  it("returns 200 when sendBillingAlertNotification throws during retrieve failure", async () => {
    // Tenant exists so the subscription-checkout path can proceed.
    state.tenantRow = {
      id: "tenant-1",
      subscriptionStatus: null,
      stripeSubscriptionId: null,
    };

    // subscriptions.retrieve throws — triggers the retrieve-failure alert path.
    stripeClientMock.retrieveImpl = async () => {
      throw new Error("Network error: could not reach Stripe");
    };

    // db.insert returns a new alert row (not a conflict-skip).
    state.insertReturning = [{ id: "alert-1" }];

    // The final db.update (linking IDs onto the tenant) should succeed.
    state.updateReturning = [{ id: "tenant-1" }];

    // Email throws a network error.
    emailMock.sendBillingAlertNotification.mockRejectedValue(
      new Error("SMTP connection refused"),
    );

    const res = await post({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_sub_1",
          mode: "subscription",
          customer: "cus_1",
          subscription: "sub_1",
          metadata: { billingTenantId: "tenant-1" },
        },
      },
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.received).toBe(true);
    // Confirm the email was actually attempted (not just skipped).
    expect(emailMock.sendBillingAlertNotification).toHaveBeenCalledOnce();
  });

  it("returns 200 when sendBillingAlertNotification throws with a timeout error", async () => {
    state.tenantRow = {
      id: "tenant-1",
      subscriptionStatus: null,
      stripeSubscriptionId: null,
    };
    stripeClientMock.retrieveImpl = async () => {
      throw new Error("ETIMEDOUT");
    };
    state.insertReturning = [{ id: "alert-2" }];
    state.updateReturning = [{ id: "tenant-1" }];
    emailMock.sendBillingAlertNotification.mockRejectedValue(
      new Error("Request timed out"),
    );

    const res = await post({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_sub_2",
          mode: "subscription",
          customer: "cus_1",
          subscription: "sub_1",
          metadata: { billingTenantId: "tenant-1" },
        },
      },
    });

    expect(res.status).toBe(200);
  });
});

// ── Path 2: unmatched subscription event in handleSubscriptionEvent ───────────

describe("billing alert email fails — customer.subscription.* path", () => {
  /**
   * A customer.subscription.* event arrives with no matching tenant. The
   * webhook inserts a billing alert and tries to email the operator. Even when
   * that email throws the webhook MUST return 200.
   */
  it("returns 200 when sendBillingAlertNotification throws for an unmatched subscription event", async () => {
    // db.update returns [] — no tenant row was updated (unmatched event).
    state.updateReturning = [];
    // db.query.tenantsTable.findFirst returns undefined — genuinely no match.
    state.tenantRow = undefined;
    // db.insert creates a fresh alert row.
    state.insertReturning = [{ id: "alert-3" }];

    emailMock.sendBillingAlertNotification.mockRejectedValue(
      new Error("SMTP connection refused"),
    );

    const res = await post({
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_unmatched",
          status: "active",
          customer: "cus_nobody",
          trial_end: null,
          metadata: {}, // no billingTenantId → falls back to customer/sub lookup
        },
      },
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.received).toBe(true);
    expect(emailMock.sendBillingAlertNotification).toHaveBeenCalledOnce();
  });

  it("returns 200 for customer.subscription.deleted with a throwing email", async () => {
    state.updateReturning = [];
    state.tenantRow = undefined;
    state.insertReturning = [{ id: "alert-4" }];
    emailMock.sendBillingAlertNotification.mockRejectedValue(
      new Error("Transport unavailable"),
    );

    const res = await post({
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_deleted",
          status: "canceled",
          customer: "cus_nobody",
          trial_end: null,
          metadata: {},
        },
      },
    });

    expect(res.status).toBe(200);
  });

  it("does NOT call sendBillingAlertNotification when the alert row was already inserted (conflict skip)", async () => {
    // Conflict-skip path: onConflictDoNothing returns [] (duplicate event).
    state.updateReturning = [];
    state.tenantRow = undefined;
    state.insertReturning = []; // conflict → no new row

    emailMock.sendBillingAlertNotification.mockRejectedValue(
      new Error("Should not be called"),
    );

    const res = await post({
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_retry",
          status: "active",
          customer: "cus_nobody",
          trial_end: null,
          metadata: {},
        },
      },
    });

    // Still 200, and email was never attempted (conflict deduplication).
    expect(res.status).toBe(200);
    expect(emailMock.sendBillingAlertNotification).not.toHaveBeenCalled();
  });
});

// ── Path 3: unmatched invoice.payment_failed in handleInvoicePaymentFailed ───

describe("billing alert email fails — invoice.payment_failed path", () => {
  /**
   * invoice.payment_failed arrives with no matching tenant (not the canceled-
   * guard path). The webhook inserts a billing alert and tries to email the
   * operator. Even when that email throws the webhook MUST return 200.
   */
  it("returns 200 when sendBillingAlertNotification throws for an unmatched invoice.payment_failed", async () => {
    // db.update returns [] — no tenant matched the customer ID.
    state.updateReturning = [];
    // findFirst returns undefined — no tenant at all for this customer.
    state.tenantRow = undefined;
    // db.insert creates a fresh alert row.
    state.insertReturning = [{ id: "alert-5" }];

    emailMock.sendBillingAlertNotification.mockRejectedValue(
      new Error("SMTP connection refused"),
    );

    const res = await post({
      type: "invoice.payment_failed",
      data: {
        object: {
          id: "in_1",
          customer: "cus_nobody",
        },
      },
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.received).toBe(true);
    expect(emailMock.sendBillingAlertNotification).toHaveBeenCalledOnce();
  });

  it("returns 200 with a TypeError thrown from sendBillingAlertNotification", async () => {
    state.updateReturning = [];
    state.tenantRow = undefined;
    state.insertReturning = [{ id: "alert-6" }];
    emailMock.sendBillingAlertNotification.mockRejectedValue(
      new TypeError("Failed to fetch"),
    );

    const res = await post({
      type: "invoice.payment_failed",
      data: {
        object: {
          id: "in_2",
          customer: "cus_nobody",
        },
      },
    });

    expect(res.status).toBe(200);
  });

  it("does NOT call sendBillingAlertNotification when the alert row was already inserted (conflict skip)", async () => {
    // Conflict-skip: duplicate invoice.payment_failed retry from Stripe.
    state.updateReturning = [];
    state.tenantRow = undefined;
    state.insertReturning = []; // conflict → no new row

    emailMock.sendBillingAlertNotification.mockRejectedValue(
      new Error("Should not be called"),
    );

    const res = await post({
      type: "invoice.payment_failed",
      data: {
        object: {
          id: "in_retry",
          customer: "cus_nobody",
        },
      },
    });

    expect(res.status).toBe(200);
    expect(emailMock.sendBillingAlertNotification).not.toHaveBeenCalled();
  });
});
