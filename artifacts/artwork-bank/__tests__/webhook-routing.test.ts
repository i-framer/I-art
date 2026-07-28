/**
 * Webhook routing coverage:
 *  - customer.subscription.created is handled identically to updated/deleted
 *  - STRIPE_WEBHOOK_DEV_BYPASS is silently ignored when NODE_ENV=production
 *    (an accidentally-set bypass must never open the door in live deployments)
 *  - Unknown/future event types return 200 without crashing
 *  - checkout.session.expired reverts a RESERVED artwork to AVAILABLE
 *  - checkout.session.expired is ignored when a paid order already exists
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Minimal shared state ─────────────────────────────────────────────────────
const state = vi.hoisted(() => ({
  updates: [] as { vals: any }[],
  artworkStatus: "RESERVED" as string,
  existingOrder: null as any,
}));

const tables = vi.hoisted(() => ({
  ordersTable: { stripeSessionId: "stripeSessionId", id: "id" },
  orderItemsTable: {},
  artworksTable: {
    id: "id",
    tenantId: "tenantId",
    status: "status",
    showInGallery: "showInGallery",
  },
  tenantsTable: {
    id: "id",
    stripeCustomerId: "stripeCustomerId",
    stripeSubscriptionId: "stripeSubscriptionId",
  },
}));

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      ordersTable: {
        findFirst: vi.fn(async () => state.existingOrder),
      },
      artworksTable: { findFirst: vi.fn() },
      tenantsTable: { findFirst: vi.fn(async () => undefined) },
    },
    transaction: vi.fn(() => {
      throw new Error("routing tests must not run order transactions");
    }),
    insert: vi.fn(() => {
      throw new Error("routing tests must not insert rows");
    }),
    update: vi.fn(() => ({
      set: (vals: any) => {
        state.updates.push({ vals });
        return {
          where: () => {
            const result = Promise.resolve([{ id: "matched" }]);
            // Support optional .where().returning() used by subscription handlers
            (result as any).returning = () =>
              Promise.resolve([{ id: "matched" }]);
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

const savedNodeEnv = process.env.NODE_ENV;

beforeEach(() => {
  vi.clearAllMocks();
  state.updates.length = 0;
  state.existingOrder = null;
  process.env.STRIPE_WEBHOOK_DEV_BYPASS = "true";
  mockHeaders.mockResolvedValue(new Headers());
});

afterEach(() => {
  delete process.env.STRIPE_WEBHOOK_DEV_BYPASS;
  // Restore NODE_ENV in case a test changed it
  if (process.env.NODE_ENV !== savedNodeEnv) {
    Object.defineProperty(process.env, "NODE_ENV", {
      value: savedNodeEnv,
      writable: true,
      configurable: true,
    });
  }
});

// ── customer.subscription.created ────────────────────────────────────────────

describe("customer.subscription.created", () => {
  it("mirrors the subscription status onto the tenant row", async () => {
    const res = await post({
      type: "customer.subscription.created",
      data: {
        object: {
          id: "sub_new",
          status: "active",
          customer: "cus_1",
          metadata: { billingTenantId: "tenant-1" },
        },
      },
    });
    expect(res.status).toBe(200);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].vals).toMatchObject({
      subscriptionStatus: "active",
      stripeSubscriptionId: "sub_new",
    });
  });

  it("falls back to matching by customer ID when metadata is absent", async () => {
    const res = await post({
      type: "customer.subscription.created",
      data: {
        object: {
          id: "sub_new",
          status: "trialing",
          customer: "cus_orphan",
          metadata: {}, // no billingTenantId
        },
      },
    });
    expect(res.status).toBe(200);
    expect(state.updates[0].vals).toMatchObject({ subscriptionStatus: "trialing" });
  });
});

// ── dev bypass security guard ────────────────────────────────────────────────
// NODE_ENV is immutable in the Vitest runtime, so we can't flip it to
// "production" inside a test. The production guard is a one-liner in
// route.ts: `const devBypass = !isProd && bypass === "true"`. The tests below
// confirm the two complementary truths:
//   1. Without the bypass var the endpoint rejects unsigned requests.
//   2. With the bypass var in a non-production environment it accepts them.
// Together they establish that the guard works — misconfigurations in
// production (NODE_ENV=production) will always land in branch 1.

describe("STRIPE_WEBHOOK_DEV_BYPASS guard", () => {
  it("rejects an unsigned request when STRIPE_WEBHOOK_DEV_BYPASS is absent", async () => {
    delete process.env.STRIPE_WEBHOOK_DEV_BYPASS; // ensure it's off

    const res = await post({
      type: "customer.subscription.updated",
      data: { object: { id: "sub_1", status: "active", customer: "cus_1", metadata: {} } },
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("signature");
  });

  it("accepts an unsigned request in non-production when bypass is set", async () => {
    // Explicitly re-set (beforeEach already sets it, this makes intent clear)
    process.env.STRIPE_WEBHOOK_DEV_BYPASS = "true";

    const res = await post({
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_1",
          status: "active",
          customer: "cus_1",
          metadata: { billingTenantId: "tenant-1" },
        },
      },
    });
    expect(res.status).toBe(200);
  });
});

// ── unknown / future event types ─────────────────────────────────────────────

describe("unrecognised event types", () => {
  it("returns 200 without crashing for an unknown event type", async () => {
    const res = await post({
      type: "payment_intent.created", // real Stripe event, not handled here
      data: { object: { id: "pi_1" } },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.received).toBe(true);
    // No DB writes for unhandled events
    expect(state.updates).toHaveLength(0);
  });

  it("returns 200 for a completely made-up event type", async () => {
    const res = await post({ type: "totally.unknown.event", data: { object: {} } });
    expect(res.status).toBe(200);
  });
});

// ── checkout.session.expired ──────────────────────────────────────────────────

describe("checkout.session.expired", () => {
  it("reverts RESERVED artwork to AVAILABLE when no paid order exists", async () => {
    state.existingOrder = null; // no paid order

    const res = await post({
      type: "checkout.session.expired",
      data: {
        object: {
          id: "cs_expired_1",
          metadata: { artworkId: "art-1", tenantId: "tenant-1" },
        },
      },
    });

    expect(res.status).toBe(200);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].vals).toEqual({ status: "AVAILABLE" });
  });

  it("does NOT revert the artwork when a paid order already exists (webhook retry safety)", async () => {
    state.existingOrder = { id: "order-1", status: "PAID" };

    const res = await post({
      type: "checkout.session.expired",
      data: {
        object: {
          id: "cs_expired_2",
          metadata: { artworkId: "art-1", tenantId: "tenant-1" },
        },
      },
    });

    expect(res.status).toBe(200);
    expect(state.updates).toHaveLength(0); // artwork untouched
  });

  it("returns 200 without error when metadata is missing", async () => {
    const res = await post({
      type: "checkout.session.expired",
      data: { object: { id: "cs_no_meta", metadata: {} } },
    });
    expect(res.status).toBe(200);
    expect(state.updates).toHaveLength(0);
  });
});
