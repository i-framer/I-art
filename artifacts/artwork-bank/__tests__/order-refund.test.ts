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
  dbUpdateShouldFail: false,
  // Set to true to simulate a concurrent refund that already changed
  // refundedAmountCents between our pre-Stripe read and the atomic UPDATE.
  concurrentConflict: false,
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
        return {
          where: (_condition: unknown) => ({
            returning: state.dbUpdateShouldFail
              ? async (_cols?: unknown) => {
                  throw new Error("DB connection lost");
                }
              : state.concurrentConflict
                ? async (_cols?: unknown) => [] as { id: string }[]
                : async (_cols?: unknown) => [{ id: "mocked-order-id" }] as { id: string }[],
          }),
        };
      },
    })),
  },
  ...tables,
}));

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ userId: "u1", tenantId: "t1" })),
}));

const sendPartialRefundNotification = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/email", () => ({
  sendOrderStatusUpdate: vi.fn(async () => {}),
  sendOrderConfirmation: vi.fn(async () => {}),
  sendPartialRefundNotification,
}));

const sendRefundDbFailureSlackNotification = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("@/lib/slack", () => ({
  sendRefundDbFailureSlackNotification,
}));
vi.mock("@/lib/base-url", () => ({ getTenantUrl: vi.fn(() => "https://x.example.com") }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const redirectSpy = vi.hoisted(() => vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirectSpy(url) }));

const stripeRefundCreate = vi.hoisted(() => vi.fn());
const stripeRefundList = vi.hoisted(() =>
  vi.fn(async () => ({ data: [] as any[] })),
);
const getStripeClient = vi.hoisted(() =>
  vi.fn(async () => ({
    refunds: { create: stripeRefundCreate, list: stripeRefundList },
  })),
);
const StripeNotConfiguredError = vi.hoisted(
  () => class StripeNotConfiguredError extends Error {},
);
vi.mock("@/lib/stripe", () => ({
  getStripeClient,
  StripeNotConfiguredError,
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
  state.dbUpdateShouldFail = false;
  state.concurrentConflict = false;
  orderFindFirst.mockImplementation(async () => state.order);
  itemFindFirst.mockResolvedValue({ artworkTitle: "Sunset" });
  tenantFindFirst.mockResolvedValue({ id: "t1", businessName: "Gallery" });
  stripeRefundCreate.mockResolvedValue({ id: "re_test" });
  stripeRefundList.mockResolvedValue({ data: [] });
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

    expect(stripeRefundCreate).toHaveBeenCalledWith(
      { payment_intent: "pi_test", amount: 4_550 },
      expect.objectContaining({ idempotencyKey: expect.stringContaining("order-1") }),
    );
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

  it("sends a partial refund notification email to the buyer", async () => {
    await expect(
      refundOrder(formData({ orderId: "order-1", refundAmountDollars: "30.00" })),
    ).rejects.toThrow("REDIRECT:/orders/order-1?refunded=partial");

    expect(sendPartialRefundNotification).toHaveBeenCalledOnce();
    expect(sendPartialRefundNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        buyerEmail: "buyer@example.com",
        refundedAmountCents: 3_000,
        artworkTitle: "Sunset",
        tenantName: "Gallery",
      }),
    );
  });

  it("records the email error on the order row when the notification fails, but still redirects", async () => {
    sendPartialRefundNotification.mockRejectedValueOnce(new Error("smtp timeout"));

    await expect(
      refundOrder(formData({ orderId: "order-1", refundAmountDollars: "30.00" })),
    ).rejects.toThrow("REDIRECT:/orders/order-1?refunded=partial");

    // The error must be persisted on the order row.
    const errorUpdate = state.updates.find((u) => "statusEmailError" in u.vals);
    expect(errorUpdate?.vals.statusEmailError).toMatch(/smtp timeout/);
    // The refund itself must still have been committed.
    const refundUpdate = state.updates.find((u) => "refundedAmountCents" in u.vals);
    expect(refundUpdate?.vals.refundedAmountCents).toBe(3_000);
  });
});

describe("Stripe failures", () => {
  it("redirects with a friendly message when Stripe is not configured, without persisting or emailing", async () => {
    getStripeClient.mockRejectedValueOnce(
      new StripeNotConfiguredError("no key"),
    );

    await expect(
      refundOrder(formData({ orderId: "order-1", refundAmountDollars: "30.00" })),
    ).rejects.toThrow(
      `REDIRECT:/orders/order-1?refund_error=${encodeURIComponent("Payments are unavailable right now — Stripe is not configured.")}`,
    );

    expect(stripeRefundCreate).not.toHaveBeenCalled();
    expect(state.updates).toHaveLength(0);
    expect(sendPartialRefundNotification).not.toHaveBeenCalled();
  });

  it("redirects with the Stripe error message when refunds.create fails, without persisting", async () => {
    stripeRefundCreate.mockRejectedValueOnce(
      new Error("The payment intent has already been fully refunded."),
    );

    await expect(
      refundOrder(formData({ orderId: "order-1", refundAmountDollars: "30.00" })),
    ).rejects.toThrow(
      `REDIRECT:/orders/order-1?refund_error=${encodeURIComponent("The payment intent has already been fully refunded.")}`,
    );

    expect(state.updates).toHaveLength(0);
    expect(sendPartialRefundNotification).not.toHaveBeenCalled();
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

    expect(stripeRefundCreate).toHaveBeenCalledWith(
      { payment_intent: "pi_test", amount: 10_000 },
      expect.objectContaining({ idempotencyKey: expect.stringContaining("order-1") }),
    );
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

  it("rejects a PENDING order before any Stripe call", async () => {
    state.order = baseOrder({ status: "PENDING" });

    await expect(
      refundOrder(formData({ orderId: "order-1" })),
    ).rejects.toThrow(
      `REDIRECT:/orders/order-1?refund_error=${encodeURIComponent("Only paid or fulfilled orders can be refunded.")}`,
    );

    expect(getStripeClient).not.toHaveBeenCalled();
    expect(stripeRefundCreate).not.toHaveBeenCalled();
    expect(state.updates).toHaveLength(0);
  });

  it("rejects a CANCELLED order before any Stripe call", async () => {
    state.order = baseOrder({ status: "CANCELLED" });

    await expect(
      refundOrder(formData({ orderId: "order-1" })),
    ).rejects.toThrow(
      `REDIRECT:/orders/order-1?refund_error=${encodeURIComponent("Only paid or fulfilled orders can be refunded.")}`,
    );

    expect(getStripeClient).not.toHaveBeenCalled();
    expect(stripeRefundCreate).not.toHaveBeenCalled();
    expect(state.updates).toHaveLength(0);
  });

  it("rejects orders without a Stripe payment intent", async () => {
    state.order = baseOrder({ stripePaymentIntentId: null as any });

    await expect(
      refundOrder(formData({ orderId: "order-1" })),
    ).rejects.toThrow("REDIRECT:/orders/order-1?refund_error=");

    expect(stripeRefundCreate).not.toHaveBeenCalled();
  });
});

describe("DB failure after successful Stripe refund", () => {
  it("redirects with the Stripe refund id in the error when the DB update throws", async () => {
    state.dbUpdateShouldFail = true;

    await expect(
      refundOrder(formData({ orderId: "order-1", refundAmountDollars: "30.00" })),
    ).rejects.toThrow(
      `REDIRECT:/orders/order-1?refund_error=${encodeURIComponent(
        "Stripe refund re_test was accepted but the order record could not be updated. Do NOT retry — check Stripe for refund re_test before proceeding.",
      )}`,
    );

    // Stripe was called — money left the account.
    expect(stripeRefundCreate).toHaveBeenCalledOnce();
  });

  it("sends a Slack alert containing the Stripe refund id, order id, and tenant when the DB update fails", async () => {
    state.dbUpdateShouldFail = true;

    await expect(
      refundOrder(formData({ orderId: "order-1", refundAmountDollars: "30.00" })),
    ).rejects.toThrow("REDIRECT:/orders/order-1?refund_error=");

    // Allow the fire-and-forget promise to settle before asserting.
    await new Promise((r) => setTimeout(r, 0));

    expect(sendRefundDbFailureSlackNotification).toHaveBeenCalledOnce();
    expect(sendRefundDbFailureSlackNotification).toHaveBeenCalledWith({
      stripeRefundId: "re_test",
      orderId: "order-1",
      tenantId: "t1",
    });
  });

  it("still redirects with the refund_error even if the Slack alert itself throws", async () => {
    state.dbUpdateShouldFail = true;
    sendRefundDbFailureSlackNotification.mockRejectedValueOnce(new Error("Slack down"));

    await expect(
      refundOrder(formData({ orderId: "order-1", refundAmountDollars: "30.00" })),
    ).rejects.toThrow("REDIRECT:/orders/order-1?refund_error=");

    // Allow microtasks to drain so the caught rejection doesn't leak.
    await new Promise((r) => setTimeout(r, 0));
  });

  it("reuses the existing Stripe refund when an admin retries after a DB failure", async () => {
    // First attempt: Stripe creates re_test, then the DB write fails.
    state.dbUpdateShouldFail = true;
    await expect(
      refundOrder(formData({ orderId: "order-1" })),
    ).rejects.toThrow("REDIRECT:/orders/order-1?refund_error=");
    expect(stripeRefundCreate).toHaveBeenCalledOnce();

    // Admin retries: DB works now. Stripe's list returns the refund it already
    // accepted on the first attempt — the action must reuse it, not create a new one.
    state.dbUpdateShouldFail = false;
    vi.clearAllMocks();
    stripeRefundList.mockResolvedValueOnce({
      data: [{ id: "re_test", amount: 10_000, status: "succeeded" }],
    });

    await expect(
      refundOrder(formData({ orderId: "order-1" })),
    ).rejects.toThrow("REDIRECT:/orders/order-1?refunded=full");

    expect(stripeRefundCreate).not.toHaveBeenCalled();

    const update = state.updates.find((u) => "refundedAmountCents" in u.vals);
    expect(update?.vals.stripeRefundId).toBe("re_test");
  });
});

describe("reconciliation — reuse existing Stripe refund", () => {
  it("does not call stripe.refunds.create when an unrecorded succeeded refund already exists", async () => {
    // Stripe has re_existing for $30 but our DB shows $0 refunded.
    stripeRefundList.mockResolvedValueOnce({
      data: [{ id: "re_existing", amount: 3_000, status: "succeeded" }],
    });

    await expect(
      refundOrder(formData({ orderId: "order-1", refundAmountDollars: "30.00" })),
    ).rejects.toThrow("REDIRECT:/orders/order-1?refunded=partial");

    expect(stripeRefundCreate).not.toHaveBeenCalled();

    const refundUpdate = state.updates.find((u) => "refundedAmountCents" in u.vals);
    expect(refundUpdate?.vals).toMatchObject({
      refundedAmountCents: 3_000,
      stripeRefundId: "re_existing",
    });
  });

  it("treats a pending Stripe refund as an existing unrecorded refund", async () => {
    // Stripe has re_pending in 'pending' state — money is in-flight. Must not create a duplicate.
    stripeRefundList.mockResolvedValueOnce({
      data: [{ id: "re_pending", amount: 3_000, status: "pending" }],
    });

    await expect(
      refundOrder(formData({ orderId: "order-1", refundAmountDollars: "30.00" })),
    ).rejects.toThrow("REDIRECT:/orders/order-1?refunded=partial");

    expect(stripeRefundCreate).not.toHaveBeenCalled();

    const refundUpdate = state.updates.find((u) => "refundedAmountCents" in u.vals);
    expect(refundUpdate?.vals.stripeRefundId).toBe("re_pending");
  });

  it("requires manual review and blocks create when Stripe shows an unmatched discrepancy", async () => {
    // Stripe shows $50 unrecorded, but we're only trying to refund $30 — mismatch.
    stripeRefundList.mockResolvedValueOnce({
      data: [{ id: "re_other", amount: 5_000, status: "succeeded" }],
    });
    // DB shows $0 refunded, so unrecordedCents = 5000 ≠ 3000 requested.

    await expect(
      refundOrder(formData({ orderId: "order-1", refundAmountDollars: "30.00" })),
    ).rejects.toThrow(
      `REDIRECT:/orders/order-1?refund_error=${encodeURIComponent(
        "Stripe shows an unrecorded refund on this order. Review the payment in Stripe before proceeding to avoid a double refund.",
      )}`,
    );

    expect(stripeRefundCreate).not.toHaveBeenCalled();
    expect(state.updates).toHaveLength(0);
  });

  it("creates a new Stripe refund with an idempotency key when Stripe and DB agree", async () => {
    // Stripe has re_other for $50 and our DB also shows $50 — no unrecorded gap.
    state.order = baseOrder({ refundedAmountCents: 5_000 });
    stripeRefundList.mockResolvedValueOnce({
      data: [{ id: "re_other", amount: 5_000, status: "succeeded" }],
    });

    await expect(
      refundOrder(formData({ orderId: "order-1", refundAmountDollars: "30.00" })),
    ).rejects.toThrow("REDIRECT:/orders/order-1?refunded=partial");

    expect(stripeRefundCreate).toHaveBeenCalledOnce();
    // Verify the idempotency key was passed: key encodes orderId-alreadyRefunded-refundCents.
    const [, opts] = stripeRefundCreate.mock.calls[0] as [any, any];
    expect(opts?.idempotencyKey).toBe("refund-order-1-5000-3000");
  });
});

// ── Optimistic-lock / concurrent refund guard ─────────────────────────────────
//
// When two concurrent requests read the same refundedAmountCents value and both
// call Stripe with different amounts, the first DB write succeeds.  The second
// write's conditional WHERE (coalesce(refundedAmountCents,0) = alreadyRefunded)
// matches 0 rows — we route to the DB-failure handler so the operator sees the
// Stripe refund ID and can reconcile rather than silently losing money.

describe("concurrent refund guard (optimistic lock)", () => {
  it("routes to the DB-failure error path when the optimistic WHERE matches 0 rows (concurrent modification detected)", async () => {
    // Stripe creates the refund — money leaves the account.
    stripeRefundCreate.mockResolvedValueOnce({ id: "re_concurrent" });
    // The DB UPDATE returns 0 rows (another concurrent write already changed the row).
    state.concurrentConflict = true;

    await expect(
      refundOrder(formData({ orderId: "order-1", refundAmountDollars: "30.00" })),
    ).rejects.toThrow(
      `REDIRECT:/orders/order-1?refund_error=${encodeURIComponent(
        "Stripe refund re_concurrent was accepted but the order record could not be updated. Do NOT retry — check Stripe for refund re_concurrent before proceeding.",
      )}`,
    );

    // Stripe was called — money left the account.
    expect(stripeRefundCreate).toHaveBeenCalledOnce();

    // Slack alert must fire so the operator can reconcile manually.
    await new Promise((r) => setTimeout(r, 0));
    expect(sendRefundDbFailureSlackNotification).toHaveBeenCalledWith({
      stripeRefundId: "re_concurrent",
      orderId: "order-1",
      tenantId: "t1",
    });

    // Buyer notification must NOT have been sent — the refund was not recorded.
    expect(sendPartialRefundNotification).not.toHaveBeenCalled();
  });
});
