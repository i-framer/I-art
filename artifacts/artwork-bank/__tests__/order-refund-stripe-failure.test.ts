/**
 * Task #322 — Prevent a Stripe refund from being falsely recorded when
 * Stripe rejects it.
 *
 * The refundOrder action calls getStripeClient() then stripe.refunds.create().
 * If either throws, the action redirects with an error message — no DB update
 * and no notification email should be sent.  This guards against accidentally
 * incrementing refundedAmountCents before Stripe confirms the refund.
 *
 * Covers:
 *  - getStripeClient() throws StripeNotConfiguredError → friendly redirect, no DB write, no email
 *  - stripe.refunds.create() throws a Stripe API error → error redirect, no DB write, no email
 *  - stripe.refunds.create() throws a generic Error → error redirect, no DB write
 *  - StripeNotConfiguredError message is replaced with the operator-safe message
 *  - PENDING order is rejected before any Stripe call (no client requested)
 *  - CANCELLED order is rejected before any Stripe call
 *  - No-payment-intent order is rejected before any Stripe call
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
  hasActiveAccess: () => true,
}));

const state = vi.hoisted(() => ({
  updates: [] as { vals: any }[],
  order: null as any,
}));

const tables = vi.hoisted(() => ({
  ordersTable: { id: "orders.id", tenantId: "orders.tenantId", status: "orders.status" },
  orderItemsTable: { orderId: "orderItems.orderId" },
  tenantsTable: { id: "tenants.id" },
}));

const orderFindFirst = vi.hoisted(() => vi.fn());
const itemFindFirst = vi.hoisted(() => vi.fn());
const tenantFindFirst = vi.hoisted(() => vi.fn());

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      ordersTable: { findFirst: (opts: any) => orderFindFirst(opts) },
      orderItemsTable: { findFirst: (opts: any) => itemFindFirst(opts) },
      tenantsTable: { findFirst: (opts: any) => tenantFindFirst(opts) },
    },
    update: vi.fn(() => ({
      set: (vals: any) => {
        state.updates.push({ vals });
        return { where: () => Promise.resolve() };
      },
    })),
  },
  ...tables,
}));

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ userId: "u1", tenantId: "t1" })),
}));

const sendPartialRefundNotification = vi.hoisted(() => vi.fn(async () => {}));
const sendOrderStatusUpdate = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/email", () => ({
  sendOrderStatusUpdate,
  sendOrderConfirmation: vi.fn(async () => {}),
  sendPartialRefundNotification,
}));
vi.mock("@/lib/base-url", () => ({ getTenantUrl: vi.fn(() => "https://x.example.com") }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const redirectSpy = vi.hoisted(() =>
  vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
);
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirectSpy(url) }));

const getStripeClient = vi.hoisted(() => vi.fn());
const stripeRefundCreate = vi.hoisted(() => vi.fn());
const stripeRefundList = vi.hoisted(() => vi.fn(async () => ({ data: [] as any[] })));
const FakeStripeNotConfiguredError = vi.hoisted(
  () =>
    class extends Error {
      constructor(m = "Stripe not configured") {
        super(m);
        this.name = "StripeNotConfiguredError";
      }
    },
);
vi.mock("@/lib/stripe", () => ({
  getStripeClient,
  StripeNotConfiguredError: FakeStripeNotConfiguredError,
}));

import { refundOrder } from "@/app/(admin)/(gated)/orders/[id]/actions";

function formData(entries: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

const defaultOrder = {
  id: "order-1",
  tenantId: "t1",
  status: "PAID" as string,
  totalCents: 10_000,
  refundedAmountCents: null as number | null,
  stripePaymentIntentId: "pi_test",
  buyerEmail: "buyer@example.com",
  buyerName: "Buyer",
  trackingNote: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  state.updates.length = 0;
  state.order = { ...defaultOrder };
  orderFindFirst.mockResolvedValue(state.order);
  itemFindFirst.mockResolvedValue({ artworkTitle: "Sunset" });
  tenantFindFirst.mockResolvedValue({ id: "t1", businessName: "Gallery" });
  // Default: stripe client works normally
  getStripeClient.mockResolvedValue({
    refunds: { create: stripeRefundCreate, list: stripeRefundList },
  });
  stripeRefundCreate.mockResolvedValue({ id: "re_test" });
  stripeRefundList.mockResolvedValue({ data: [] });
});

function getRedirectUrl(): string {
  const calls = redirectSpy.mock.calls;
  if (calls.length === 0) throw new Error("redirect() was not called");
  return calls[calls.length - 1]![0] as string;
}

// ── Stripe not configured ─────────────────────────────────────────────────────

describe("refundOrder — Stripe not configured (Task #322)", () => {
  it("redirects with a friendly error when getStripeClient throws StripeNotConfiguredError", async () => {
    getStripeClient.mockRejectedValueOnce(
      new FakeStripeNotConfiguredError("Stripe is not configured."),
    );

    await expect(
      refundOrder(formData({ orderId: "order-1", refundAmountDollars: "50.00" })),
    ).rejects.toThrow("REDIRECT:");

    const url = getRedirectUrl();
    expect(url).toContain("refund_error=");
    expect(decodeURIComponent(url)).toMatch(/stripe is not configured/i);
  });

  it("does NOT write any DB update when Stripe is not configured", async () => {
    getStripeClient.mockRejectedValueOnce(new FakeStripeNotConfiguredError());

    await expect(
      refundOrder(formData({ orderId: "order-1", refundAmountDollars: "50.00" })),
    ).rejects.toThrow("REDIRECT:");

    // No DB update should have occurred — refundedAmountCents stays unchanged
    const refundUpdate = state.updates.find((u) => "refundedAmountCents" in u.vals);
    expect(refundUpdate).toBeUndefined();
  });

  it("does NOT send any email notification when Stripe is not configured", async () => {
    getStripeClient.mockRejectedValueOnce(new FakeStripeNotConfiguredError());

    await expect(
      refundOrder(formData({ orderId: "order-1", refundAmountDollars: "50.00" })),
    ).rejects.toThrow("REDIRECT:");

    expect(sendPartialRefundNotification).not.toHaveBeenCalled();
    expect(sendOrderStatusUpdate).not.toHaveBeenCalled();
  });
});

// ── Stripe API error during refund creation ───────────────────────────────────

describe("refundOrder — Stripe.refunds.create() failure (Task #322)", () => {
  it("redirects with the Stripe error message", async () => {
    stripeRefundCreate.mockRejectedValueOnce(
      Object.assign(new Error("Your card has insufficient funds."), {
        type: "StripeCardError",
      }),
    );

    await expect(
      refundOrder(formData({ orderId: "order-1", refundAmountDollars: "50.00" })),
    ).rejects.toThrow("REDIRECT:");

    const url = getRedirectUrl();
    expect(url).toContain("refund_error=");
    expect(decodeURIComponent(url)).toContain("insufficient funds");
  });

  it("does NOT write refundedAmountCents when refunds.create throws", async () => {
    stripeRefundCreate.mockRejectedValueOnce(new Error("Payment intent not found."));

    await expect(
      refundOrder(formData({ orderId: "order-1", refundAmountDollars: "50.00" })),
    ).rejects.toThrow("REDIRECT:");

    const refundUpdate = state.updates.find((u) => "refundedAmountCents" in u.vals);
    expect(refundUpdate).toBeUndefined();
  });

  it("does NOT notify the buyer when refunds.create throws", async () => {
    stripeRefundCreate.mockRejectedValueOnce(new Error("Stripe API error"));

    await expect(
      refundOrder(formData({ orderId: "order-1", refundAmountDollars: "50.00" })),
    ).rejects.toThrow("REDIRECT:");

    expect(sendPartialRefundNotification).not.toHaveBeenCalled();
    expect(sendOrderStatusUpdate).not.toHaveBeenCalled();
  });

  it("does not call stripe at all for a generic Error from getStripeClient", async () => {
    getStripeClient.mockRejectedValueOnce(new Error("Network error"));

    await expect(
      refundOrder(formData({ orderId: "order-1", refundAmountDollars: "50.00" })),
    ).rejects.toThrow("REDIRECT:");

    expect(stripeRefundCreate).not.toHaveBeenCalled();
  });
});

// ── Order state validation before Stripe call ────────────────────────────────

describe("refundOrder — invalid order state (Task #322)", () => {
  it("rejects a PENDING order before calling Stripe", async () => {
    state.order = { ...defaultOrder, status: "PENDING" };
    orderFindFirst.mockResolvedValue(state.order);

    await expect(
      refundOrder(formData({ orderId: "order-1", refundAmountDollars: "50.00" })),
    ).rejects.toThrow("REDIRECT:");

    const url = getRedirectUrl();
    expect(url).toContain("refund_error=");
    expect(getStripeClient).not.toHaveBeenCalled();
    expect(state.updates).toHaveLength(0);
  });

  it("rejects a CANCELLED order before calling Stripe", async () => {
    state.order = { ...defaultOrder, status: "CANCELLED" };
    orderFindFirst.mockResolvedValue(state.order);

    await expect(
      refundOrder(formData({ orderId: "order-1", refundAmountDollars: "50.00" })),
    ).rejects.toThrow("REDIRECT:");

    expect(getStripeClient).not.toHaveBeenCalled();
    expect(state.updates).toHaveLength(0);
  });

  it("rejects an order with no stripePaymentIntentId before calling Stripe", async () => {
    state.order = { ...defaultOrder, stripePaymentIntentId: null };
    orderFindFirst.mockResolvedValue(state.order);

    await expect(
      refundOrder(formData({ orderId: "order-1", refundAmountDollars: "50.00" })),
    ).rejects.toThrow("REDIRECT:");

    const url = getRedirectUrl();
    expect(url).toContain("refund_error=");
    expect(getStripeClient).not.toHaveBeenCalled();
    expect(state.updates).toHaveLength(0);
  });
});
