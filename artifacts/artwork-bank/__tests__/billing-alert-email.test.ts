/**
 * Confirms the webhook calls (or skips) sendBillingAlertNotification correctly
 * when an unmatched subscription event arrives.
 *
 * Coverage:
 *  - Unmatched event → alert row inserted AND sendBillingAlertNotification called
 *  - Stripe redelivery (conflict → empty .returning()) → notification NOT re-sent
 *  - Email throws → webhook still returns 200 (non-fatal)
 *  - Out-of-order guard blocks stale event → notification NOT called
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Shared state ──────────────────────────────────────────────────────────────
const state = vi.hoisted(() => ({
  /** Rows returned from stripeAlertsTable insert().returning() */
  alertInsertReturning: [] as any[],
  /** Rows matched by the follow-up findFirst (to distinguish guard vs. miss) */
  tenantFound: null as any,
}));

// ── DB mock ───────────────────────────────────────────────────────────────────
vi.mock("@workspace/db", () => {
  const tenantsTable = {
    id: "id",
    stripeCustomerId: "stripeCustomerId",
    stripeSubscriptionId: "stripeSubscriptionId",
    subscriptionStatus: "subscriptionStatus",
  };
  const stripeAlertsTable = { stripeEventId: "stripeEventId", id: "id" };

  return {
    db: {
      query: {
        tenantsTable: {
          findFirst: vi.fn(async () => state.tenantFound),
        },
      },
      update: vi.fn(() => ({
        set: () => ({
          where: () => ({
            returning: async () => [], // no tenant matched
          }),
        }),
      })),
      insert: vi.fn(() => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: async () => state.alertInsertReturning,
          }),
        }),
      })),
    },
    tenantsTable,
    stripeAlertsTable,
    ordersTable: {},
    orderItemsTable: {},
    artworksTable: {},
    eq: (col: any, val: any) => ({ col, val, op: "eq" }),
    and: (...args: any[]) => ({ op: "and", args }),
    sql: (() => {
      const tag = (strings: any) => strings;
      (tag as any).raw = (s: string) => s;
      return tag;
    })(),
  };
});

// ── Stripe mock ───────────────────────────────────────────────────────────────
vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(),
  getStripeWebhookSecret: vi.fn().mockResolvedValue(null),
  calcApplicationFee: (cents: number) => Math.round(cents * 0.05),
  StripeNotConfiguredError: class StripeNotConfiguredError extends Error {},
}));

// ── Email spy ─────────────────────────────────────────────────────────────────
const sendBillingAlertNotification = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({
  sendBillingAlertNotification: (...args: any[]) =>
    sendBillingAlertNotification(...args),
  sendOrderConfirmation: vi.fn(),
}));

// ── iFramer mock ──────────────────────────────────────────────────────────────
vi.mock("@/lib/iframer", () => ({
  createIFramerJob: vi.fn(),
  IFramerError: class IFramerError extends Error {},
}));

// ── next/headers mock ─────────────────────────────────────────────────────────
const mockHeaders = vi.hoisted(() => vi.fn());
vi.mock("next/headers", () => ({
  headers: () => mockHeaders(),
}));

import { POST as webhookPOST } from "@/app/api/stripe/webhook/route";

// ── Helpers ───────────────────────────────────────────────────────────────────

function unmatchedSubscriptionEvent() {
  return {
    id: "evt_unmatched_001",
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_orphan_1",
        status: "active",
        customer: "cus_orphan_1",
        metadata: {}, // no billingTenantId
      },
    },
  };
}

function postWebhook(body: object) {
  return webhookPOST(
    new Request("http://localhost/api/stripe/webhook", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  state.alertInsertReturning = [{ id: "alert-1" }]; // new alert inserted
  state.tenantFound = null; // no tenant matched by default

  process.env.STRIPE_WEBHOOK_DEV_BYPASS = "true";
  mockHeaders.mockResolvedValue(new Headers());
});

afterEach(() => {
  delete process.env.STRIPE_WEBHOOK_DEV_BYPASS;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("webhook: billing alert email on unmatched subscription event", () => {
  it("calls sendBillingAlertNotification when a new alert row is inserted", async () => {
    sendBillingAlertNotification.mockResolvedValueOnce(undefined);

    const res = await postWebhook(unmatchedSubscriptionEvent());

    expect(res.status).toBe(200);
    expect(sendBillingAlertNotification).toHaveBeenCalledTimes(1);
    expect(sendBillingAlertNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeEventId: "evt_unmatched_001",
        eventType: "customer.subscription.updated",
        customerId: "cus_orphan_1",
        subscriptionId: "sub_orphan_1",
      }),
    );
  });

  it("does NOT call sendBillingAlertNotification on a Stripe redelivery (conflict → empty returning)", async () => {
    state.alertInsertReturning = []; // onConflictDoNothing produced no new row

    const res = await postWebhook(unmatchedSubscriptionEvent());

    expect(res.status).toBe(200);
    expect(sendBillingAlertNotification).not.toHaveBeenCalled();
  });

  it("still returns 200 when the notification email throws (non-fatal)", async () => {
    sendBillingAlertNotification.mockRejectedValueOnce(
      new Error("Resend API down"),
    );

    const res = await postWebhook(unmatchedSubscriptionEvent());

    expect(res.status).toBe(200);
    expect(sendBillingAlertNotification).toHaveBeenCalledTimes(1);
  });

  it("does NOT call sendBillingAlertNotification when the cancel guard blocked a stale event", async () => {
    // update().returning() returns [] (guard blocked write), but findFirst
    // finds the tenant → treated as a stale no-op, not an unmatched alert.
    state.tenantFound = { id: "tenant-existing" };

    const res = await postWebhook(unmatchedSubscriptionEvent());

    expect(res.status).toBe(200);
    expect(sendBillingAlertNotification).not.toHaveBeenCalled();
  });
});
