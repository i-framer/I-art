/**
 * Confirms that the checkout.session.completed webhook handler sets
 * subscriptionStatus to "trialing" (not hardcoded "active") when the real
 * Stripe subscription is in a trial period.
 *
 * This covers the 30-day free trial path introduced for new subscriptions:
 * the handler calls subscriptions.retrieve() on the live Stripe object and
 * mirrors whatever status it finds onto the tenant row.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Hoisted state ─────────────────────────────────────────────────────────────

const state = vi.hoisted(() => ({
  updates: [] as { vals: any }[],
  subscriptionStatus: "trialing" as string,
}));

// ── DB mock ───────────────────────────────────────────────────────────────────

const tenantFindFirst = vi.hoisted(() =>
  vi.fn(async () => ({
    id: "tenant-1",
    subscriptionStatus: null,
    stripeSubscriptionId: null,
  })),
);

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      ordersTable: { findFirst: vi.fn() },
      artworksTable: { findFirst: vi.fn() },
      tenantsTable: { findFirst: tenantFindFirst },
    },
    transaction: vi.fn(() => {
      throw new Error("trialing tests must not create orders");
    }),
    insert: vi.fn(() => {
      throw new Error("trialing tests must not insert rows");
    }),
    update: vi.fn(() => ({
      set: (vals: any) => {
        state.updates.push({ vals });
        return {
          where: () => {
            const result = Promise.resolve([{ id: "tenant-1" }]);
            (result as any).returning = () =>
              Promise.resolve([{ id: "tenant-1" }]);
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
  },
}));

// ── Stripe mock: subscriptions.retrieve returns the configured status ──────────

const subscriptionsRetrieve = vi.hoisted(() =>
  vi.fn(async () => ({ status: state.subscriptionStatus })),
);

vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(async () => ({
    subscriptions: { retrieve: subscriptionsRetrieve },
  })),
  getStripeWebhookSecret: vi.fn().mockResolvedValue(null),
  calcApplicationFee: (cents: number) => Math.round(cents * 0.05),
  StripeNotConfiguredError: class StripeNotConfiguredError extends Error {},
}));

vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: vi.fn(),
  sendBillingAlertNotification: vi.fn(),
}));
vi.mock("@/lib/slack", () => ({
  sendBillingAlertSlackNotification: vi
    .fn()
    .mockResolvedValue({ ok: true }),
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
  state.updates.length = 0;
  state.subscriptionStatus = "trialing";
  process.env.STRIPE_WEBHOOK_DEV_BYPASS = "true";
  mockHeaders.mockResolvedValue(new Headers());
  tenantFindFirst.mockResolvedValue({
    id: "tenant-1",
    subscriptionStatus: null,
    stripeSubscriptionId: null,
  });
  subscriptionsRetrieve.mockImplementation(
    async () => ({ status: state.subscriptionStatus }),
  );
});

afterEach(() => {
  delete process.env.STRIPE_WEBHOOK_DEV_BYPASS;
});

// ── Trial status tests ────────────────────────────────────────────────────────

describe("checkout.session.completed — 30-day trial status sync", () => {
  it("sets subscriptionStatus to 'trialing' when Stripe subscription is trialing", async () => {
    state.subscriptionStatus = "trialing";

    const res = await post({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_trial_1",
          mode: "subscription",
          customer: "cus_trial",
          subscription: "sub_trial_1",
          metadata: { billingTenantId: "tenant-1" },
        },
      },
    });

    expect(res.status).toBe(200);
    expect(subscriptionsRetrieve).toHaveBeenCalledWith("sub_trial_1");
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].vals).toMatchObject({
      stripeCustomerId: "cus_trial",
      stripeSubscriptionId: "sub_trial_1",
      subscriptionStatus: "trialing",
    });
  });

  it("sets subscriptionStatus to 'active' when Stripe subscription is active (non-trial)", async () => {
    state.subscriptionStatus = "active";

    const res = await post({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_active_1",
          mode: "subscription",
          customer: "cus_active",
          subscription: "sub_active_1",
          metadata: { billingTenantId: "tenant-1" },
        },
      },
    });

    expect(res.status).toBe(200);
    expect(subscriptionsRetrieve).toHaveBeenCalledWith("sub_active_1");
    expect(state.updates[0].vals).toMatchObject({
      subscriptionStatus: "active",
    });
  });

  it("falls back to 'active' when subscriptions.retrieve throws (stale key mismatch)", async () => {
    subscriptionsRetrieve.mockRejectedValueOnce(
      new Error("No such subscription: sub_stale"),
    );

    const res = await post({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_fallback_1",
          mode: "subscription",
          customer: "cus_fallback",
          subscription: "sub_stale",
          metadata: { billingTenantId: "tenant-1" },
        },
      },
    });

    expect(res.status).toBe(200);
    expect(state.updates[0].vals).toMatchObject({
      subscriptionStatus: "active",
    });
  });

  it("does NOT call subscriptions.retrieve for a same-subscription re-delivery (no-op case)", async () => {
    // Tenant already has this subscription active — isNewSubscription → false
    tenantFindFirst.mockResolvedValue({
      id: "tenant-1",
      subscriptionStatus: "active",
      stripeSubscriptionId: "sub_existing",
    } as any);

    const res = await post({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_redeliver_1",
          mode: "subscription",
          customer: "cus_1",
          subscription: "sub_existing",
          metadata: { billingTenantId: "tenant-1" },
        },
      },
    });

    expect(res.status).toBe(200);
    // subscriptions.retrieve must NOT be called for a no-op re-delivery
    expect(subscriptionsRetrieve).not.toHaveBeenCalled();
    // The update must not include subscriptionStatus (no-op)
    if (state.updates.length > 0) {
      expect(state.updates[0].vals.subscriptionStatus).toBeUndefined();
    }
  });

  it("trial→active transition is mirrored when customer.subscription.updated fires after trial ends", async () => {
    const res = await post({
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_trial_ended",
          status: "active",
          customer: "cus_trial_ended",
          metadata: { billingTenantId: "tenant-1" },
        },
      },
    });

    expect(res.status).toBe(200);
    expect(state.updates[0].vals).toMatchObject({
      subscriptionStatus: "active",
      stripeSubscriptionId: "sub_trial_ended",
    });
  });
});
