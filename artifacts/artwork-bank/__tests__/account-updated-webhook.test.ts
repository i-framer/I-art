/**
 * account.updated webhook handler:
 *  - persists charges_enabled / payouts_enabled onto the matching tenant row
 *  - returns 200 (not an error) when no tenant owns the account ID
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Shared state ──────────────────────────────────────────────────────────────
const state = vi.hoisted(() => ({
  updates: [] as { vals: any }[],
  /** Control whether the mock DB finds a matching tenant */
  tenantMatched: true,
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
    stripeAccountId: "stripeAccountId",
    stripeCustomerId: "stripeCustomerId",
    stripeSubscriptionId: "stripeSubscriptionId",
    subscriptionStatus: "subscriptionStatus",
  },
}));

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      ordersTable: { findFirst: vi.fn(async () => undefined) },
      artworksTable: { findFirst: vi.fn(async () => undefined) },
      tenantsTable: {
        findFirst: vi.fn(async () =>
          state.tenantMatched ? { id: "tenant-1" } : undefined,
        ),
      },
    },
    transaction: vi.fn(() => {
      throw new Error("account.updated tests must not run transactions");
    }),
    insert: vi.fn(() => {
      throw new Error("account.updated tests must not insert rows");
    }),
    update: vi.fn(() => ({
      set: (vals: any) => {
        state.updates.push({ vals });
        return {
          where: () => ({
            returning: () =>
              Promise.resolve(
                state.tenantMatched ? [{ id: "tenant-1" }] : [],
              ),
          }),
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

vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: vi.fn(),
  sendBillingAlertNotification: vi.fn(),
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
  state.tenantMatched = true;
  process.env.STRIPE_WEBHOOK_DEV_BYPASS = "true";
  mockHeaders.mockResolvedValue(new Headers());
});

afterEach(() => {
  delete process.env.STRIPE_WEBHOOK_DEV_BYPASS;
});

// ── account.updated ───────────────────────────────────────────────────────────

describe("account.updated webhook handler", () => {
  it("writes charges_enabled and payouts_enabled onto the tenant row", async () => {
    const res = await post({
      type: "account.updated",
      data: {
        object: {
          id: "acct_test_1",
          charges_enabled: true,
          payouts_enabled: true,
        },
      },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });

    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]!.vals).toEqual({
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    });
  });

  it("writes false (not null) when Stripe reports charges/payouts disabled", async () => {
    const res = await post({
      type: "account.updated",
      data: {
        object: {
          id: "acct_test_2",
          charges_enabled: false,
          payouts_enabled: false,
        },
      },
    });

    expect(res.status).toBe(200);
    expect(state.updates[0]!.vals).toEqual({
      stripeChargesEnabled: false,
      stripePayoutsEnabled: false,
    });
  });

  it("returns 200 (not an error) when no tenant owns the account ID", async () => {
    // Stripe should not keep retrying for an unrecognised account — return 200.
    state.tenantMatched = false;

    const res = await post({
      type: "account.updated",
      data: {
        object: {
          id: "acct_unknown",
          charges_enabled: true,
          payouts_enabled: false,
        },
      },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    // The update was attempted but matched nothing — no further writes.
    expect(state.updates).toHaveLength(1);
  });
});
