/**
 * Subscription billing webhook sync: checkout.session.completed (subscription
 * mode), customer.subscription.* and invoice.payment_failed must mirror the
 * subscription state onto the tenant row — and must never fall through into
 * the artwork-sale order handler.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const state = vi.hoisted(() => ({
  updates: [] as { vals: any }[],
  /** rows returned by db.update().where().returning() — empty = no tenant matched */
  updateResult: [{ id: "matched" }] as any[],
}));

const tables = vi.hoisted(() => ({
  ordersTable: {},
  orderItemsTable: {},
  artworksTable: {},
  tenantsTable: {
    id: "id",
    stripeCustomerId: "stripeCustomerId",
    stripeSubscriptionId: "stripeSubscriptionId",
  },
}));

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      ordersTable: { findFirst: vi.fn() },
      artworksTable: { findFirst: vi.fn() },
      tenantsTable: { findFirst: vi.fn() },
    },
    transaction: vi.fn(() => {
      throw new Error("subscription events must not create orders");
    }),
    insert: vi.fn(() => {
      throw new Error("subscription events must not insert rows");
    }),
    update: vi.fn(() => ({
      set: (vals: any) => {
        state.updates.push({ vals });
        return {
          where: () => {
            const result = Promise.resolve(state.updateResult);
            // Support optional .returning() chained after .where()
            (result as any).returning = () =>
              Promise.resolve(state.updateResult);
            return result;
          },
        };
      },
    })),
  },
  ...tables,
}));

vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(),
  getStripeWebhookSecret: vi.fn().mockResolvedValue(null),
  calcApplicationFee: (cents: number) => Math.round(cents * 0.05),
  StripeNotConfiguredError: class StripeNotConfiguredError extends Error {},
}));

vi.mock("@/lib/email", () => ({ sendOrderConfirmation: vi.fn() }));
vi.mock("@/lib/iframer", () => ({
  createIFramerJob: vi.fn(),
  IFramerError: class IFramerError extends Error {},
}));

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

import { db } from "@workspace/db";

beforeEach(() => {
  vi.clearAllMocks();
  state.updates.length = 0;
  // Default: update matches one tenant row (happy path)
  state.updateResult = [{ id: "matched" }];
  process.env.STRIPE_WEBHOOK_DEV_BYPASS = "true";
  mockHeaders.mockResolvedValue(new Headers());
  // Default: tenant exists with no prior subscription state (matches tests that
  // use billingTenantId: "tenant-1" in metadata; tests that need a different
  // state override this with their own mockResolvedValue call).
  vi.mocked(db.query.tenantsTable.findFirst).mockResolvedValue({
    id: "tenant-1",
    subscriptionStatus: null,
    stripeSubscriptionId: null,
  } as any);
});

afterEach(() => {
  delete process.env.STRIPE_WEBHOOK_DEV_BYPASS;
});

describe("subscription webhook events", () => {
  it("subscription-mode checkout marks the tenant active and stores IDs", async () => {
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
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].vals).toMatchObject({
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      subscriptionStatus: "active",
    });
  });

  it("subscription-mode checkout never runs the artwork order handler", async () => {
    const res = await post({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_sub_2",
          mode: "subscription",
          customer: "cus_1",
          subscription: "sub_1",
          // even with sale-looking metadata present
          metadata: {
            billingTenantId: "tenant-1",
            artworkId: "art-1",
            tenantId: "tenant-1",
            fulfillmentType: "SHIP",
          },
        },
      },
    });
    // db.transaction throws if called — a 200 proves it wasn't
    expect(res.status).toBe(200);
  });

  it("customer.subscription.updated mirrors the status", async () => {
    const res = await post({
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_1",
          status: "past_due",
          customer: "cus_1",
          metadata: { billingTenantId: "tenant-1" },
        },
      },
    });
    expect(res.status).toBe(200);
    expect(state.updates[0].vals).toMatchObject({
      subscriptionStatus: "past_due",
      stripeSubscriptionId: "sub_1",
    });
  });

  it("customer.subscription.deleted marks the tenant canceled", async () => {
    const res = await post({
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_1",
          status: "canceled",
          customer: "cus_1",
          metadata: { billingTenantId: "tenant-1" },
        },
      },
    });
    expect(res.status).toBe(200);
    expect(state.updates[0].vals).toMatchObject({
      subscriptionStatus: "canceled",
    });
  });

  it("out-of-order checkout.completed does not re-activate a canceled subscription", async () => {
    // subscription.deleted already wrote canceled for the SAME subscription
    vi.mocked(db.query.tenantsTable.findFirst).mockResolvedValue({
      subscriptionStatus: "canceled",
      stripeSubscriptionId: "sub_1",
    } as any);
    const res = await post({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_sub_old",
          mode: "subscription",
          customer: "cus_1",
          subscription: "sub_1",
          metadata: { billingTenantId: "tenant-1" },
        },
      },
    });
    expect(res.status).toBe(200);
    expect(state.updates[0].vals.subscriptionStatus).toBeUndefined();
  });

  it("a NEW subscription re-activates a previously canceled tenant", async () => {
    vi.mocked(db.query.tenantsTable.findFirst).mockResolvedValue({
      subscriptionStatus: "canceled",
      stripeSubscriptionId: "sub_old",
    } as any);
    const res = await post({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_sub_new",
          mode: "subscription",
          customer: "cus_1",
          subscription: "sub_new",
          metadata: { billingTenantId: "tenant-1" },
        },
      },
    });
    expect(res.status).toBe(200);
    expect(state.updates[0].vals).toMatchObject({
      subscriptionStatus: "active",
      stripeSubscriptionId: "sub_new",
    });
  });

  it("invoice.payment_failed flags the tenant past_due by customer ID", async () => {
    const res = await post({
      type: "invoice.payment_failed",
      data: { object: { id: "in_1", customer: "cus_1" } },
    });
    expect(res.status).toBe(200);
    expect(state.updates[0].vals).toEqual({ subscriptionStatus: "past_due" });
  });

  it("logs an ERROR when a subscription event matches no tenant", async () => {
    state.updateResult = []; // no tenant matched the update
    // Override: second findFirst call (cancel-guard check) must also return
    // undefined so the handler takes the "truly unmatched" error path.
    vi.mocked(db.query.tenantsTable.findFirst).mockResolvedValue(
      undefined as any,
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await post({
      id: "evt_nomatch_sub",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_orphan",
          status: "canceled",
          customer: "cus_unknown",
          metadata: {},
        },
      },
    });

    expect(res.status).toBe(200);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unmatched subscription event"),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("evt_nomatch_sub"),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("cus_unknown"),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("sub_orphan"),
    );
    errorSpy.mockRestore();
  });

  it("logs an ERROR when invoice.payment_failed matches no tenant", async () => {
    state.updateResult = []; // no tenant matched
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await post({
      id: "evt_nomatch_inv",
      type: "invoice.payment_failed",
      data: { object: { id: "in_orphan", customer: "cus_unknown" } },
    });

    expect(res.status).toBe(200);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unmatched invoice.payment_failed"),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("evt_nomatch_inv"),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("cus_unknown"),
    );
    errorSpy.mockRestore();
  });
});
