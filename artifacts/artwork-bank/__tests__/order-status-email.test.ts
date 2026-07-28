/**
 * resendStatusEmail action tests:
 *  - Re-queues the status update email for the buyer and attempts an immediate send
 *  - Cross-tenant order IDs are rejected
 *  - The notifyBuyerOfUpdate sequence fires: queue write, then send attempt, then clear-on-success
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
  hasActiveAccess: () => true,
}));

const state = vi.hoisted(() => ({
  updates: [] as { vals: any }[],
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

const sendOrderStatusUpdate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({
  sendOrderStatusUpdate: (...args: any[]) => sendOrderStatusUpdate(...args),
  sendOrderConfirmation: vi.fn(async () => {}),
}));
vi.mock("@/lib/base-url", () => ({ getTenantUrl: vi.fn(() => "https://gallery.example.com") }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

import { resendStatusEmail } from "@/app/(admin)/(gated)/orders/[id]/actions";

function formData(entries: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

const paidOrder = {
  id: "order-1",
  tenantId: "t1",
  status: "PAID",
  buyerEmail: "buyer@example.com",
  buyerName: "Buyer",
  fulfillmentType: "SHIP",
  trackingNote: null,
  statusEmailQueuedAt: null,
  statusEmailError: "connection refused",
  statusEmailAttempts: 3,
};

beforeEach(() => {
  vi.clearAllMocks();
  state.updates.length = 0;

  // First call: ownership check (scoped by tenantId)
  // Second call: after queue write, the full order is re-fetched
  orderFindFirst
    .mockResolvedValueOnce(paidOrder)   // ownership lookup
    .mockResolvedValueOnce(paidOrder);  // post-queue re-fetch inside notifyBuyerOfUpdate

  itemFindFirst.mockResolvedValue({ artworkTitle: "Sunset" });
  tenantFindFirst.mockResolvedValue({ id: "t1", businessName: "Gallery A" });
  sendOrderStatusUpdate.mockResolvedValue(undefined);
});

describe("resendStatusEmail", () => {
  it("queues the status email first (sets statusEmailQueuedAt)", async () => {
    await resendStatusEmail(formData({ orderId: "order-1" }));

    const queueUpdate = state.updates.find((u) => "statusEmailQueuedAt" in u.vals);
    expect(queueUpdate?.vals).toMatchObject({
      statusEmailError: null,
      statusEmailAttempts: 0,
    });
    expect(queueUpdate?.vals.statusEmailQueuedAt).toBeInstanceOf(Date);
  });

  it("attempts an immediate send via sendOrderStatusUpdate", async () => {
    await resendStatusEmail(formData({ orderId: "order-1" }));

    expect(sendOrderStatusUpdate).toHaveBeenCalledTimes(1);
    expect(sendOrderStatusUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        buyerEmail: "buyer@example.com",
        artworkTitle: "Sunset",
        tenantName: "Gallery A",
      }),
    );
  });

  it("clears the queue and records success when send succeeds", async () => {
    await resendStatusEmail(formData({ orderId: "order-1" }));

    const successUpdate = state.updates.find(
      (u) => u.vals.statusEmailQueuedAt === null && "statusEmailAttempts" in u.vals,
    );
    expect(successUpdate?.vals).toMatchObject({
      statusEmailQueuedAt: null,
      statusEmailError: null,
      statusEmailAttempts: 1,
    });
  });

  it("records the error and leaves the queue open when send fails", async () => {
    sendOrderStatusUpdate.mockRejectedValueOnce(new Error("SMTP timeout"));

    await resendStatusEmail(formData({ orderId: "order-1" }));

    const errorUpdate = state.updates.find((u) => "statusEmailError" in u.vals && u.vals.statusEmailError);
    expect(errorUpdate?.vals.statusEmailError).toMatch(/SMTP timeout/);
  });

  it("rejects cross-tenant order ids with 'Order not found.'", async () => {
    orderFindFirst.mockReset();
    orderFindFirst.mockResolvedValue(undefined); // tenant-scoped lookup returns nothing

    await expect(
      resendStatusEmail(formData({ orderId: "order-other" })),
    ).rejects.toThrow("Order not found.");

    expect(sendOrderStatusUpdate).not.toHaveBeenCalled();
    expect(state.updates).toHaveLength(0);
  });
});
