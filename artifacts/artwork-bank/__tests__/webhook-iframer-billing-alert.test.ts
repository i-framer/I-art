/**
 * Verifies that when a matched i-Framer-linked tenant loses billing access
 * via a Stripe webhook event, the operator receives a durable Slack notification
 * that identifies the affected tenant as an i-Framer Premium account.
 *
 * Coverage:
 *  - customer.subscription.* (past_due, canceled, unpaid) → stripe_alert row
 *    inserted and Slack notification fires when iframerAccountId is set.
 *  - customer.subscription.* (active, trialing) → no alert (not a billing loss).
 *  - invoice.payment_failed → alert inserted and Slack fires when iframerAccountId is set.
 *  - Neither event fires when iframerAccountId is null/unset.
 *  - Slack failure ({ ok: false }) → slackPostFailed persisted on the alert row.
 *  - Stripe redelivery (same event ID) → conflict suppresses second Slack call.
 *  - iframerAccountId is embedded in the alert row's reason field.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Shared state ───────────────────────────────────────────────────────────────

const state = vi.hoisted(() => ({
  /** Rows returned by tenantsTable UPDATE .returning(). Empty = no tenant matched. */
  updateResult: [] as any[],
  /** Stripe event IDs already inserted into stripe_alerts (idempotency store). */
  alertEventIds: new Set<string>(),
  /** Values passed to db.insert(...).values() for stripeAlertsTable. */
  alertInserts: [] as { stripeEventId: string; reason: string }[],
  /** Event IDs for which slackPostFailed was written on the alert row. */
  slackFailedMarked: [] as string[],
  /** Last stripeEventId seen in a stripe_alert insert (used by slackPostFailed updater). */
  lastAlertEventId: null as string | null,
}));

const tables = vi.hoisted(() => ({
  ordersTable: {},
  orderItemsTable: {},
  artworksTable: {},
  tenantsTable: {
    id: "id",
    stripeCustomerId: "stripeCustomerId",
    stripeSubscriptionId: "stripeSubscriptionId",
    iframerAccountId: "iframerAccountId",
    subscriptionStatus: "subscriptionStatus",
  },
  stripeAlertsTable: {
    id: "id",
    stripeEventId: "stripeEventId",
    dismissedAt: "dismissedAt",
    slackPostFailed: "slackPostFailed",
  },
}));

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      ordersTable: { findFirst: vi.fn(async () => undefined) },
      artworksTable: { findFirst: vi.fn(async () => undefined) },
      // Return undefined so the unmatched fallback path (which we don't test
      // here) is a clean no-op.
      tenantsTable: { findFirst: vi.fn(async () => undefined) },
    },
    transaction: vi.fn(() => {
      throw new Error("subscription events must not create orders");
    }),

    insert: vi.fn((table: any) => ({
      values: (values: any) => {
        if (table !== tables.stripeAlertsTable) {
          return {
            onConflictDoNothing: () => ({ returning: async () => [] }),
          };
        }

        // Track the insert attempt and simulate idempotency.
        state.alertInserts.push({
          stripeEventId: values.stripeEventId,
          reason: values.reason ?? "",
        });
        state.lastAlertEventId = values.stripeEventId;

        const isNew = !state.alertEventIds.has(values.stripeEventId);
        if (isNew) state.alertEventIds.add(values.stripeEventId);

        return {
          onConflictDoNothing: () => ({
            returning: () =>
              Promise.resolve(
                isNew ? [{ id: `alert-${state.alertInserts.length}` }] : [],
              ),
          }),
        };
      },
    })),

    update: vi.fn((table: any) => ({
      set: (vals: any) => {
        // Track slackPostFailed writes here (where() is always called; .returning()
        // is NOT called by the slackPostFailed branch so tracking must happen here).
        const isSlackFailed =
          table === tables.stripeAlertsTable && vals.slackPostFailed;

        return {
          where: (_condition?: any) => {
            if (isSlackFailed && state.lastAlertEventId) {
              state.slackFailedMarked.push(state.lastAlertEventId);
            }
            return {
              returning: () =>
                Promise.resolve(
                  table === tables.tenantsTable ? state.updateResult : [],
                ),
            };
          },
        };
      },
    })),
  },
  ...tables,
  sql: Object.assign((_tpl: TemplateStringsArray, ..._args: any[]) => ({}), {
    raw: (s: string) => s,
  }),
  eq: (..._args: any[]) => ({}),
  and: (..._args: any[]) => ({}),
}));

vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(),
  getStripeWebhookSecret: vi.fn().mockResolvedValue(null),
  calcApplicationFee: (cents: number) => Math.round(cents * 0.05),
  StripeNotConfiguredError: class StripeNotConfiguredError extends Error {},
}));

vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: vi.fn(),
  sendBillingAlertNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/slack", () => ({
  sendBillingAlertSlackNotification: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@/lib/iframer", () => ({
  createIFramerJob: vi.fn(),
  IFramerError: class IFramerError extends Error {},
}));

vi.mock("@/lib/base-url", () => ({
  getPlatformBaseUrl: vi.fn().mockReturnValue("https://example.com"),
  getTenantUrl: vi.fn(() => "http://localhost"),
}));

const mockHeaders = vi.hoisted(() => vi.fn());
vi.mock("next/headers", () => ({ headers: () => mockHeaders() }));

import { POST as webhookPOST } from "@/app/api/stripe/webhook/route";
import { sendBillingAlertSlackNotification } from "@/lib/slack";

// ── Helpers ───────────────────────────────────────────────────────────────────

function post(event: object) {
  return webhookPOST(
    new Request("http://localhost/api/stripe/webhook", {
      method: "POST",
      body: JSON.stringify(event),
    }),
  );
}

let _seq = 0;
function uid() {
  return `evt_${++_seq}_${Math.random().toString(36).slice(2)}`;
}

function subscriptionEvent(
  status: string,
  eventType = "customer.subscription.updated",
  eventId = uid(),
) {
  return {
    type: eventType,
    id: eventId,
    data: {
      object: {
        id: "sub_test_001",
        status,
        customer: "cus_test_001",
        trial_end: null,
        metadata: { billingTenantId: "tenant-1" },
      },
    },
  };
}

function invoiceEvent(eventId = uid()) {
  return {
    type: "invoice.payment_failed",
    id: eventId,
    data: {
      object: {
        id: "in_test_001",
        customer: "cus_test_001",
        subscription: "sub_test_001",
      },
    },
  };
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  state.updateResult = [];
  state.alertEventIds.clear();
  state.alertInserts.length = 0;
  state.slackFailedMarked.length = 0;
  state.lastAlertEventId = null;
  process.env.STRIPE_WEBHOOK_DEV_BYPASS = "true";
  mockHeaders.mockReturnValue(new Headers());
});

afterEach(() => {
  delete process.env.STRIPE_WEBHOOK_DEV_BYPASS;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("i-Framer billing alert — customer.subscription.* events", () => {
  it("inserts a stripe_alert row and fires Slack when iframerAccountId is set and status is past_due", async () => {
    state.updateResult = [{ id: "tenant-1", iframerAccountId: "acct_iframer_42" }];

    const res = await post(subscriptionEvent("past_due"));
    expect(res.status).toBe(200);

    // A durable alert row must have been inserted.
    const iframerInsert = state.alertInserts.find((i) =>
      i.reason.includes("acct_iframer_42"),
    );
    expect(iframerInsert).toBeDefined();

    // Slack must be notified with the account ID.
    expect(sendBillingAlertSlackNotification).toHaveBeenCalledWith(
      expect.objectContaining({ iframerAccountId: "acct_iframer_42" }),
    );
  });

  it("fires when status is canceled (customer.subscription.deleted)", async () => {
    state.updateResult = [{ id: "tenant-1", iframerAccountId: "acct_iframer_42" }];

    await post(subscriptionEvent("canceled", "customer.subscription.deleted"));

    expect(
      state.alertInserts.some((i) => i.reason.includes("acct_iframer_42")),
    ).toBe(true);
    expect(sendBillingAlertSlackNotification).toHaveBeenCalledWith(
      expect.objectContaining({ iframerAccountId: "acct_iframer_42" }),
    );
  });

  it("fires when status is unpaid", async () => {
    state.updateResult = [{ id: "tenant-1", iframerAccountId: "acct_iframer_42" }];

    await post(subscriptionEvent("unpaid"));

    expect(
      state.alertInserts.some((i) => i.reason.includes("acct_iframer_42")),
    ).toBe(true);
    expect(sendBillingAlertSlackNotification).toHaveBeenCalledWith(
      expect.objectContaining({ iframerAccountId: "acct_iframer_42" }),
    );
  });

  it("does NOT insert an i-Framer alert or fire Slack when iframerAccountId is null", async () => {
    state.updateResult = [{ id: "tenant-1", iframerAccountId: null }];

    await post(subscriptionEvent("past_due"));

    // No insert targeting the i-Framer account.
    expect(
      state.alertInserts.some((i) => i.reason?.includes("iframer")),
    ).toBe(false);
    expect(sendBillingAlertSlackNotification).not.toHaveBeenCalled();
  });

  it("does NOT insert an alert or fire Slack when status is active (not a billing loss)", async () => {
    state.updateResult = [{ id: "tenant-1", iframerAccountId: "acct_iframer_42" }];

    await post(subscriptionEvent("active"));

    expect(state.alertInserts).toHaveLength(0);
    expect(sendBillingAlertSlackNotification).not.toHaveBeenCalled();
  });

  it("does NOT insert an alert or fire Slack when status is trialing (not a billing loss)", async () => {
    state.updateResult = [{ id: "tenant-1", iframerAccountId: "acct_iframer_42" }];

    await post(subscriptionEvent("trialing"));

    expect(state.alertInserts).toHaveLength(0);
    expect(sendBillingAlertSlackNotification).not.toHaveBeenCalled();
  });

  it("preserves the iframerAccountId in the alert row reason field", async () => {
    state.updateResult = [{ id: "tenant-1", iframerAccountId: "acct_iframer_99" }];

    await post(subscriptionEvent("canceled", "customer.subscription.deleted"));

    const insert = state.alertInserts.find((i) =>
      i.reason.includes("acct_iframer_99"),
    );
    expect(insert).toBeDefined();
    expect(insert!.reason).toContain("acct_iframer_99");
  });

  it("persists slackPostFailed on the alert row when Slack returns { ok: false }", async () => {
    state.updateResult = [{ id: "tenant-1", iframerAccountId: "acct_iframer_42" }];
    vi.mocked(sendBillingAlertSlackNotification).mockResolvedValueOnce({
      ok: false,
      error: "channel_not_found",
    });

    await post(subscriptionEvent("past_due"));

    expect(state.slackFailedMarked).toHaveLength(1);
    // The alert row itself must still have been inserted.
    expect(
      state.alertInserts.some((i) => i.reason.includes("acct_iframer_42")),
    ).toBe(true);
  });

  it("does NOT fire Slack on Stripe redelivery of the same event (idempotency)", async () => {
    state.updateResult = [{ id: "tenant-1", iframerAccountId: "acct_iframer_42" }];
    const eventId = uid();
    const event = subscriptionEvent(
      "past_due",
      "customer.subscription.updated",
      eventId,
    );

    // First delivery — new alert row, Slack fires.
    await post(event);
    const firstSlackCalls = vi.mocked(sendBillingAlertSlackNotification).mock
      .calls.length;
    expect(firstSlackCalls).toBeGreaterThan(0);

    vi.mocked(sendBillingAlertSlackNotification).mockClear();

    // Second delivery (same event ID) — conflict, Slack must NOT fire again.
    await post(event);
    expect(sendBillingAlertSlackNotification).not.toHaveBeenCalled();
  });
});

describe("i-Framer billing alert — invoice.payment_failed events", () => {
  it("inserts a stripe_alert row and fires Slack when iframerAccountId is set", async () => {
    state.updateResult = [{ id: "tenant-1", iframerAccountId: "acct_iframer_42" }];

    const res = await post(invoiceEvent());
    expect(res.status).toBe(200);

    const iframerInsert = state.alertInserts.find((i) =>
      i.reason.includes("acct_iframer_42"),
    );
    expect(iframerInsert).toBeDefined();

    expect(sendBillingAlertSlackNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "invoice.payment_failed",
        iframerAccountId: "acct_iframer_42",
      }),
    );
  });

  it("does NOT insert an i-Framer alert or fire Slack when iframerAccountId is null", async () => {
    state.updateResult = [{ id: "tenant-1", iframerAccountId: null }];

    await post(invoiceEvent());

    expect(
      state.alertInserts.some((i) => i.reason?.includes("iframer")),
    ).toBe(false);
    expect(sendBillingAlertSlackNotification).not.toHaveBeenCalled();
  });

  it("persists slackPostFailed on the alert row when Slack returns { ok: false }", async () => {
    state.updateResult = [{ id: "tenant-1", iframerAccountId: "acct_iframer_42" }];
    vi.mocked(sendBillingAlertSlackNotification).mockResolvedValueOnce({
      ok: false,
      error: "not_authed",
    });

    await post(invoiceEvent());

    expect(state.slackFailedMarked).toHaveLength(1);
    // Alert row was still inserted despite Slack failure.
    expect(
      state.alertInserts.some((i) => i.reason.includes("acct_iframer_42")),
    ).toBe(true);
  });

  it("does NOT fire Slack on Stripe redelivery of the same event (idempotency)", async () => {
    state.updateResult = [{ id: "tenant-1", iframerAccountId: "acct_iframer_42" }];
    const eventId = uid();
    const event = invoiceEvent(eventId);

    // First delivery — new alert row, Slack fires.
    await post(event);
    expect(sendBillingAlertSlackNotification).toHaveBeenCalledTimes(1);

    vi.mocked(sendBillingAlertSlackNotification).mockClear();

    // Second delivery — conflict, Slack must NOT fire again.
    await post(event);
    expect(sendBillingAlertSlackNotification).not.toHaveBeenCalled();
  });

  it("preserves the iframerAccountId in the alert row reason field", async () => {
    state.updateResult = [{ id: "tenant-1", iframerAccountId: "acct_iframer_77" }];

    await post(invoiceEvent());

    const insert = state.alertInserts.find((i) =>
      i.reason.includes("acct_iframer_77"),
    );
    expect(insert).toBeDefined();
    expect(insert!.reason).toContain("acct_iframer_77");
  });
});
