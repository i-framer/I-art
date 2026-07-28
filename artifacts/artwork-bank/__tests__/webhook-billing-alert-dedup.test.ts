/**
 * Idempotency tests for duplicate Stripe event redelivery on the billing-alert
 * path.
 *
 * The webhook uses `onConflictDoNothing({ target: stripeEventId }) + returning`
 * to gate whether sendBillingAlertNotification is called. These tests verify:
 *
 * 1. The first delivery inserts a new alert row → sendBillingAlertNotification
 *    is called exactly once.
 * 2. A second delivery of the same event ID hits the conflict path (returning
 *    returns []) → sendBillingAlertNotification is NOT called again.
 * 3. Both deliveries return 200 { received: true }.
 *
 * Covers handleSubscriptionEvent (customer.subscription.updated with no tenant
 * match) and handleInvoicePaymentFailed (with no customer match).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Hoisted shared state ─────────────────────────────────────────────────────
// Simulates a real Postgres unique constraint on stripe_event_id.
// The first insert for a given eventId succeeds (returns a row); every
// subsequent insert for the same eventId is a conflict (returns []).
const alertsStore = vi.hoisted(() => new Set<string>());

// Track every call to the alert insert so we can assert call counts.
const alertInsertSpy = vi.hoisted(() => vi.fn());

// ── DB mock ──────────────────────────────────────────────────────────────────
vi.mock("@workspace/db", () => {
  const tenantsTable = {
    id: "id",
    stripeCustomerId: "stripeCustomerId",
    stripeSubscriptionId: "stripeSubscriptionId",
    subscriptionStatus: "subscriptionStatus",
  };

  const stripeAlertsTable = {
    stripeEventId: "stripeEventId",
  };

  // Simulates onConflictDoNothing + returning: returns a row the first time,
  // [] on any subsequent call with the same stripeEventId.
  function makeInsertChain(vals: any) {
    return {
      onConflictDoNothing: (_opts?: any) => ({
        returning: () => {
          alertInsertSpy(vals);
          const eventId: string = vals.stripeEventId;
          if (alertsStore.has(eventId)) {
            // Conflict — row already exists; return nothing.
            return Promise.resolve([]);
          }
          alertsStore.add(eventId);
          return Promise.resolve([{ id: "alert-1", ...vals }]);
        },
      }),
    };
  }

  return {
    db: {
      query: {
        tenantsTable: {
          // No tenant found → triggers the billing alert path.
          findFirst: vi.fn().mockResolvedValue(undefined),
        },
      },
      // update().set().where().returning() → [] means no tenant matched.
      update: (_table: any) => ({
        set: (_vals: any) => ({
          where: (_cond: any) => ({
            returning: () => Promise.resolve([]),
          }),
        }),
      }),
      insert: (_table: any) => ({
        values: (vals: any) => makeInsertChain(vals),
      }),
    },
    tenantsTable,
    stripeAlertsTable,
    // Provide all table exports the module imports (even if unused in this path).
    ordersTable: {},
    orderItemsTable: {},
    artworksTable: {},
  };
});

// ── Stripe mock — dev bypass so no signature verification ───────────────────
vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(),
  getStripeWebhookSecret: vi.fn().mockResolvedValue(null),
  calcApplicationFee: (cents: number) => Math.round(cents * 0.05),
  StripeNotConfiguredError: class StripeNotConfiguredError extends Error {},
}));

// ── Email spy ────────────────────────────────────────────────────────────────
const sendBillingAlertNotification = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/email", () => ({
  sendBillingAlertNotification: (...args: any[]) =>
    sendBillingAlertNotification(...args),
  sendOrderConfirmation: vi.fn(),
}));

// ── Slack spy ────────────────────────────────────────────────────────────────
const sendBillingAlertSlackNotification = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
vi.mock("@/lib/slack", () => ({
  sendBillingAlertSlackNotification: (...args: any[]) =>
    sendBillingAlertSlackNotification(...args),
}));

// ── Misc Next.js / app mocks ─────────────────────────────────────────────────
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));
vi.mock("@/lib/base-url", () => ({
  getTenantUrl: vi.fn().mockReturnValue("https://example.com/orders"),
  getPlatformBaseUrl: vi.fn().mockReturnValue("https://example.com"),
}));
vi.mock("@/lib/iframer", () => ({
  createIFramerJob: vi.fn(),
  IFramerError: class IFramerError extends Error {},
}));

import { POST as webhookPOST } from "@/app/api/stripe/webhook/route";

// ── Helpers ──────────────────────────────────────────────────────────────────

function subscriptionEvent(eventId: string) {
  return new Request("http://localhost/api/stripe/webhook", {
    method: "POST",
    body: JSON.stringify({
      id: eventId,
      type: "customer.subscription.updated",
      data: {
        object: {
          // No metadata / customer / subscription IDs → no tenant will match.
          id: "sub_unmatched_1",
          status: "active",
          metadata: {},
          customer: "cus_unmatched_1",
        },
      },
    }),
  });
}

function invoicePaymentFailedEvent(eventId: string) {
  return new Request("http://localhost/api/stripe/webhook", {
    method: "POST",
    body: JSON.stringify({
      id: eventId,
      type: "invoice.payment_failed",
      data: {
        object: {
          // customerId does not match any tenant.
          customer: "cus_unmatched_2",
        },
      },
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  alertsStore.clear();
  process.env.STRIPE_WEBHOOK_DEV_BYPASS = "true";
});

afterEach(() => {
  delete process.env.STRIPE_WEBHOOK_DEV_BYPASS;
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("customer.subscription.updated — duplicate event deduplication", () => {
  const EVENT_ID = "evt_sub_dedup_1";

  it("first delivery: inserts a billing alert row and calls sendBillingAlertNotification", async () => {
    const res = await webhookPOST(subscriptionEvent(EVENT_ID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });

    // DB insert was attempted
    expect(alertInsertSpy).toHaveBeenCalledTimes(1);
    expect(alertInsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ stripeEventId: EVENT_ID }),
    );

    // Notification was sent once
    expect(sendBillingAlertNotification).toHaveBeenCalledTimes(1);
    expect(sendBillingAlertNotification).toHaveBeenCalledWith(
      expect.objectContaining({ stripeEventId: EVENT_ID }),
    );
  });

  it("second delivery (redelivery): insert conflicts — sendBillingAlertNotification is NOT called", async () => {
    // Simulate the first delivery having already inserted the row.
    alertsStore.add(EVENT_ID);

    const res = await webhookPOST(subscriptionEvent(EVENT_ID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });

    // DB insert was still attempted (the route always tries), but returned [].
    expect(alertInsertSpy).toHaveBeenCalledTimes(1);

    // No email because the insert returned nothing (conflict path).
    expect(sendBillingAlertNotification).not.toHaveBeenCalled();
  });

  it("sending the same event ID twice: first triggers an email, second does not", async () => {
    const res1 = await webhookPOST(subscriptionEvent(EVENT_ID));
    const res2 = await webhookPOST(subscriptionEvent(EVENT_ID));

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(await res1.json()).toEqual({ received: true });
    expect(await res2.json()).toEqual({ received: true });

    // Insert was attempted twice (once per delivery)…
    expect(alertInsertSpy).toHaveBeenCalledTimes(2);
    // …but the email was sent only once (only the first insert wrote a row).
    expect(sendBillingAlertNotification).toHaveBeenCalledTimes(1);
  });
});

describe("invoice.payment_failed — duplicate event deduplication", () => {
  const EVENT_ID = "evt_inv_dedup_1";

  it("first delivery: inserts a billing alert row and calls sendBillingAlertNotification", async () => {
    const res = await webhookPOST(invoicePaymentFailedEvent(EVENT_ID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });

    expect(alertInsertSpy).toHaveBeenCalledTimes(1);
    expect(alertInsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ stripeEventId: EVENT_ID }),
    );

    expect(sendBillingAlertNotification).toHaveBeenCalledTimes(1);
    expect(sendBillingAlertNotification).toHaveBeenCalledWith(
      expect.objectContaining({ stripeEventId: EVENT_ID }),
    );
  });

  it("second delivery (redelivery): insert conflicts — sendBillingAlertNotification is NOT called", async () => {
    alertsStore.add(EVENT_ID);

    const res = await webhookPOST(invoicePaymentFailedEvent(EVENT_ID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });

    expect(alertInsertSpy).toHaveBeenCalledTimes(1);
    expect(sendBillingAlertNotification).not.toHaveBeenCalled();
  });

  it("sending the same event ID twice: first triggers an email, second does not", async () => {
    const res1 = await webhookPOST(invoicePaymentFailedEvent(EVENT_ID));
    const res2 = await webhookPOST(invoicePaymentFailedEvent(EVENT_ID));

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(await res1.json()).toEqual({ received: true });
    expect(await res2.json()).toEqual({ received: true });

    expect(alertInsertSpy).toHaveBeenCalledTimes(2);
    expect(sendBillingAlertNotification).toHaveBeenCalledTimes(1);
  });
});

describe("distinct event IDs each get their own alert row and email", () => {
  it("two different event IDs produce two inserts and two emails", async () => {
    const res1 = await webhookPOST(subscriptionEvent("evt_sub_distinct_A"));
    const res2 = await webhookPOST(invoicePaymentFailedEvent("evt_inv_distinct_B"));

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    expect(alertInsertSpy).toHaveBeenCalledTimes(2);
    expect(sendBillingAlertNotification).toHaveBeenCalledTimes(2);
  });
});
