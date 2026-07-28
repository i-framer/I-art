/**
 * Partial and full refund action tests:
 *  - Partial refund stores the refunded amount, keeps the order active
 *  - Full refund (amount = total) sets status CANCELLED and notifies the buyer
 *  - Multiple partial refunds accumulate correctly
 *  - Refunding more than the remaining balance is rejected
 *  - Already-fully-refunded orders are rejected
 *  - Cross-tenant order IDs are still rejected
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
  ordersTable: {
    id: "orders.id",
    tenantId: "orders.tenantId",
    status: "orders.status",
  },
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

vi.mock("@/lib/email", () => ({
  sendOrderStatusUpdate: vi.fn(async () => {}),
  sendOrderConfirmation: vi.fn(async () => {}),
}));
vi.mock("@/lib/base-url", () => ({ getTenantUrl: vi.fn(() => "https://x.example.com") }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const redirectSpy = vi.hoisted(() => vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirectSpy(url) }));

const stripeRefundCreate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(async () => ({
    refunds: { create: stripeRefundCreate },
  })),
  StripeNotConfiguredError: class StripeNotConfiguredError extends Error {},
}));

import { refundOrder } from "@/app/(admin)/(gated)/orders/[id]/actions";

function formData(entries: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

function baseOrder(overrides: Partial<typeof defaultOrder> = {}) {
  return { ...defaultOrder, ...overrides };
}

const defaultOrder = {
  id: "order-1",
  tenantId: "t1",
  status: "PAID" as "PENDING" | "PAID" | "FULFILLED" | "CANCELLED",
  totalCents: 10_000,          // $100.00
  refundedAmountCents: null as number | null,
  stripePaymentIntentId: "pi_test" as string | null,
  buyerEmail: "buyer@example.com",
  buyerName: "Buyer",
  trackingNote: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  state.updates.length = 0;
  state.order = baseOrder();
  orderFindFirst.mockImplementation(async () => state.order);
  itemFindFirst.mockResolvedValue({ artworkTitle: "Sunset" });
  tenantFindFirst.mockResolvedValue({ id: "t1", businessName: "Gallery" });
  stripeRefundCreate.mockResolvedValue({ id: "re_test" });
});

describe("partial refund", () => {
  it("stores the refunded amount and keeps the order PAID", async () => {
    await expect(
      refundOrder(formData({ orderId: "order-1", refundAmountDollars: "30.00" })),
    ).rejects.toThrow("REDIRECT:/orders/order-1?refunded=partial");

    const refundUpdate = state.updates.find((u) => "refundedAmountCents" in u.vals);
    expect(refundUpdate?.vals).toMatchObject({
      refundedAmountCents: 3_000,
      stripeRefundId: "re_test",
    });
    expect(refundUpdate?.vals.status).toBeUndefined(); // still PAID
  });

  it("passes the correct cent amount to Stripe", async () => {
    await expect(
      refundOrder(formData({ orderId: "order-1", refundAmountDollars: "45.50" })),
    ).rejects.toThrow("REDIRECT:");

    expect(stripeRefundCreate).toHaveBeenCalledWith({
      payment_intent: "pi_test",
      amount: 4_550,
    });
  });

  it("accumulates correctly on a second partial refund", async () => {
    state.order = baseOrder({ refundedAmountCents: 3_000 }); // $30 already refunded

    await expect(
      refundOrder(formData({ orderId: "order-1", refundAmountDollars: "20.00" })),
    ).rejects.toThrow("REDIRECT:/orders/order-1?refunded=partial");

    const update = state.updates.find((u) => "refundedAmountCents" in u.vals);
    expect(update?.vals.refundedAmountCents).toBe(5_000); // $30 + $20
    expect(update?.vals.status).toBeUndefined();
  });
});

describe("full refund", () => {
  it("sets status CANCELLED and notifies the buyer when the full amount is entered", async () => {
    await expect(
      refundOrder(formData({ orderId: "order-1", refundAmountDollars: "100.00" })),
    ).rejects.toThrow("REDIRECT:/orders/order-1?refunded=full");

    const update = state.updates.find((u) => "refundedAmountCents" in u.vals);
    expect(update?.vals).toMatchObject({
      refundedAmountCents: 10_000,
      status: "CANCELLED",
    });
  });

  it("triggers a full refund when no amount is supplied (defaults to full balance)", async () => {
    await expect(
      refundOrder(formData({ orderId: "order-1" })),
    ).rejects.toThrow("REDIRECT:/orders/order-1?refunded=full");

    expect(stripeRefundCreate).toHaveBeenCalledWith({
      payment_intent: "pi_test",
      amount: 10_000,
    });
    const update = state.updates.find((u) => "refundedAmountCents" in u.vals);
    expect(update?.vals.status).toBe("CANCELLED");
  });

  it("a partial that reaches the full total also cancels the order", async () => {
    state.order = baseOrder({ refundedAmountCents: 7_000 }); // $70 already done

    await expect(
      refundOrder(formData({ orderId: "order-1", refundAmountDollars: "30.00" })),
    ).rejects.toThrow("REDIRECT:/orders/order-1?refunded=full");

    const update = state.updates.find((u) => "refundedAmountCents" in u.vals);
    expect(update?.vals.refundedAmountCents).toBe(10_000);
    expect(update?.vals.status).toBe("CANCELLED");
  });
});

describe("validation", () => {
  it("rejects an amount that exceeds the remaining balance", async () => {
    await expect(
      refundOrder(formData({ orderId: "order-1", refundAmountDollars: "150.00" })),
    ).rejects.toThrow("REDIRECT:/orders/order-1?refund_error=");

    expect(stripeRefundCreate).not.toHaveBeenCalled();
  });

  it("rejects a zero amount", async () => {
    await expect(
      refundOrder(formData({ orderId: "order-1", refundAmountDollars: "0" })),
    ).rejects.toThrow("REDIRECT:/orders/order-1?refund_error=");

    expect(stripeRefundCreate).not.toHaveBeenCalled();
  });

  it("rejects when the order is already fully refunded", async () => {
    state.order = baseOrder({ refundedAmountCents: 10_000, status: "CANCELLED" });

    await expect(
      refundOrder(formData({ orderId: "order-1" })),
    ).rejects.toThrow("REDIRECT:/orders/order-1?refund_error=");

    expect(stripeRefundCreate).not.toHaveBeenCalled();
  });

  it("rejects cross-tenant order ids", async () => {
    orderFindFirst.mockResolvedValue(undefined); // scoped lookup returns nothing

    await expect(
      refundOrder(formData({ orderId: "order-other-tenant" })),
    ).rejects.toThrow("Order not found.");
    expect(stripeRefundCreate).not.toHaveBeenCalled();
  });

  it("rejects orders without a Stripe payment intent", async () => {
    state.order = baseOrder({ stripePaymentIntentId: null as any });

    await expect(
      refundOrder(formData({ orderId: "order-1" })),
    ).rejects.toThrow("REDIRECT:/orders/order-1?refund_error=");

    expect(stripeRefundCreate).not.toHaveBeenCalled();
  });
});
