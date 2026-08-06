/**
 * Trial countdown clearing on trial-to-paid conversion.
 *
 * The billing page shows "X days remaining" from the tenant's trialEnd column.
 * When a trial converts to active (status → "active", trial_end → null on the
 * Stripe subscription), the webhook must null out trialEnd so no stale
 * countdown lingers. This file covers:
 *
 *  1. customer.subscription.created with trial_end → trialEnd stored
 *  2. customer.subscription.updated with trial_end=null + status=active
 *     → trialEnd cleared (written as null)
 *  3. Out-of-order cancel-guard path → does NOT resurrect a stale trialEnd
 *     for a subscription that is already recorded as canceled
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Hoisted state ─────────────────────────────────────────────────────────────

const state = vi.hoisted(() => ({
  updates: [] as { vals: any }[],
  /** rows returned by .returning() — empty array simulates "no tenant matched" */
  updateResult: [{ id: "tenant-trial" }] as any[],
}));

// ── DB mock ───────────────────────────────────────────────────────────────────

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      ordersTable: { findFirst: vi.fn() },
      artworksTable: { findFirst: vi.fn() },
      tenantsTable: { findFirst: vi.fn() },
    },
    transaction: vi.fn(() => {
      throw new Error("trial-countdown tests must not create orders");
    }),
    insert: vi.fn(() => {
      throw new Error("trial-countdown tests must not insert rows");
    }),
    update: vi.fn(() => ({
      set: (vals: any) => {
        state.updates.push({ vals });
        return {
          where: () => {
            const result = Promise.resolve(state.updateResult);
            (result as any).returning = () =>
              Promise.resolve(state.updateResult);
            return result;
          },
        };
      },
    })),
  },
  ordersTable: {},
  orderItemsTable: {},
  artworksTable: {},
  tenantsTable: {
    id: "id",
    stripeCustomerId: "stripeCustomerId",
    stripeSubscriptionId: "stripeSubscriptionId",
    subscriptionStatus: "subscriptionStatus",
  },
}));

// ── Stripe mock ───────────────────────────────────────────────────────────────

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
vi.mock("@/lib/base-url", () => ({ getTenantUrl: vi.fn() }));

const mockHeaders = vi.hoisted(() => vi.fn());
vi.mock("next/headers", () => ({ headers: () => mockHeaders() }));

// ── Route handler ─────────────────────────────────────────────────────────────

import { POST as webhookPOST } from "@/app/api/stripe/webhook/route";
import { db } from "@workspace/db";

function post(event: any) {
  return webhookPOST(
    new Request("http://localhost/api/stripe/webhook", {
      method: "POST",
      body: JSON.stringify(event),
    }),
  );
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Unix timestamp ~30 days from epoch — any non-null value works for the test. */
const TRIAL_END_TS = 30 * 24 * 60 * 60; // 2592000
const TRIAL_END_DATE = new Date(TRIAL_END_TS * 1000);

beforeEach(() => {
  vi.clearAllMocks();
  state.updates.length = 0;
  state.updateResult = [{ id: "tenant-trial" }];
  process.env.STRIPE_WEBHOOK_DEV_BYPASS = "true";
  mockHeaders.mockResolvedValue(new Headers());

  // Default: tenant exists with a live trial
  vi.mocked(db.query.tenantsTable.findFirst).mockResolvedValue({
    id: "tenant-trial",
    subscriptionStatus: "trialing",
    stripeSubscriptionId: "sub_trial",
  } as any);
});

afterEach(() => {
  delete process.env.STRIPE_WEBHOOK_DEV_BYPASS;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("trial countdown — trialEnd stored and cleared", () => {
  it("customer.subscription.created with trial_end stores trialEnd on the tenant", async () => {
    const res = await post({
      id: "evt_sub_created",
      type: "customer.subscription.created",
      data: {
        object: {
          id: "sub_trial",
          status: "trialing",
          customer: "cus_trial",
          trial_end: TRIAL_END_TS,
          metadata: { billingTenantId: "tenant-trial" },
        },
      },
    });

    expect(res.status).toBe(200);
    expect(state.updates).toHaveLength(1);

    const { vals } = state.updates[0];
    expect(vals.subscriptionStatus).toBe("trialing");
    expect(vals.trialEnd).toBeInstanceOf(Date);
    expect((vals.trialEnd as Date).getTime()).toBe(TRIAL_END_DATE.getTime());
  });

  it("customer.subscription.updated with trial_end=null and status=active clears trialEnd", async () => {
    // Simulate trial conversion: Stripe sends trial_end=null, status=active
    const res = await post({
      id: "evt_sub_converted",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_trial",
          status: "active",
          customer: "cus_trial",
          trial_end: null,
          metadata: { billingTenantId: "tenant-trial" },
        },
      },
    });

    expect(res.status).toBe(200);
    expect(state.updates).toHaveLength(1);

    const { vals } = state.updates[0];
    // Status must flip to active
    expect(vals.subscriptionStatus).toBe("active");
    // trialEnd must be explicitly set to null — not omitted, not a Date
    expect(vals).toHaveProperty("trialEnd");
    expect(vals.trialEnd).toBeNull();
  });

  it("full sequence: created (trialEnd set) then updated (trialEnd cleared) produces correct final state", async () => {
    // Step 1 — subscription.created while trialing
    await post({
      id: "evt_seq_created",
      type: "customer.subscription.created",
      data: {
        object: {
          id: "sub_seq",
          status: "trialing",
          customer: "cus_seq",
          trial_end: TRIAL_END_TS,
          metadata: { billingTenantId: "tenant-trial" },
        },
      },
    });

    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].vals.trialEnd).toBeInstanceOf(Date);
    expect(state.updates[0].vals.subscriptionStatus).toBe("trialing");

    // Step 2 — subscription.updated when trial converts to paid
    await post({
      id: "evt_seq_converted",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_seq",
          status: "active",
          customer: "cus_seq",
          trial_end: null,
          metadata: { billingTenantId: "tenant-trial" },
        },
      },
    });

    expect(state.updates).toHaveLength(2);
    const convertVals = state.updates[1].vals;
    expect(convertVals.subscriptionStatus).toBe("active");
    // trialEnd must be null — no stale countdown remains
    expect(convertVals).toHaveProperty("trialEnd");
    expect(convertVals.trialEnd).toBeNull();
  });

  it("out-of-order cancel-guard: stale subscription.updated does not resurrect trialEnd for a canceled subscription", async () => {
    // The cancel-guard UPDATE returns 0 rows (guard blocked the write).
    state.updateResult = [];

    // The follow-up findFirst (cancel-guard diagnostic check) returns a
    // tenant whose status is already 'canceled' for the same subscription.
    // This is the "guard blocked a stale event" path — a no-op, not an error.
    vi.mocked(db.query.tenantsTable.findFirst).mockResolvedValue({
      id: "tenant-trial",
      subscriptionStatus: "canceled",
      stripeSubscriptionId: "sub_trial",
    } as any);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const res = await post({
      id: "evt_stale_update",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_trial",
          // Stale event arrives with a trial_end value that must NOT be written
          status: "trialing",
          customer: "cus_trial",
          trial_end: TRIAL_END_TS,
          metadata: { billingTenantId: "tenant-trial" },
        },
      },
    });

    expect(res.status).toBe(200);

    // The update was attempted (1 call) but returned 0 rows — guard blocked it.
    expect(state.updates).toHaveLength(1);

    // Handler must log the "stale out-of-order" message, not an error.
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Stale out-of-order event ignored"),
    );

    logSpy.mockRestore();
  });

  it("subscription.updated with non-null trial_end preserves the trialEnd date (partial trial remaining)", async () => {
    // Stripe may send an updated event while still trialing (e.g. plan change)
    // — trialEnd must still be written as a Date, not cleared.
    const updatedTrialEnd = TRIAL_END_TS + 86400; // one extra day
    const updatedTrialDate = new Date(updatedTrialEnd * 1000);

    const res = await post({
      id: "evt_still_trialing",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_trial",
          status: "trialing",
          customer: "cus_trial",
          trial_end: updatedTrialEnd,
          metadata: { billingTenantId: "tenant-trial" },
        },
      },
    });

    expect(res.status).toBe(200);
    expect(state.updates).toHaveLength(1);

    const { vals } = state.updates[0];
    expect(vals.subscriptionStatus).toBe("trialing");
    expect(vals.trialEnd).toBeInstanceOf(Date);
    expect((vals.trialEnd as Date).getTime()).toBe(updatedTrialDate.getTime());
  });
});
