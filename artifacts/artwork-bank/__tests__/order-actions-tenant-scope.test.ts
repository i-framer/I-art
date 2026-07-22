/**
 * Regression tests: order admin actions (markFulfilled, markCancelled,
 * resendConfirmationEmail, saveTrackingNote) must scope order lookups by
 * the session's tenantId so a gallery can never modify another gallery's
 * orders. A cross-tenant order id is rejected and nothing is updated or
 * emailed.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Billing is validated separately (billing-access.test.ts); tenant-scope tests
// run with the subscription guard stubbed out.
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
  hasActiveAccess: () => true,
}));

const state = vi.hoisted(() => ({
  updates: [] as { vals: any; where: any }[],
  orderFindWhere: null as any,
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
      ordersTable: {
        findFirst: (opts: any) => {
          state.orderFindWhere = opts?.where;
          return orderFindFirst(opts);
        },
      },
      orderItemsTable: { findFirst: (opts: any) => itemFindFirst(opts) },
      tenantsTable: { findFirst: (opts: any) => tenantFindFirst(opts) },
    },
    update: vi.fn(() => ({
      set: (vals: any) => ({
        where: (where: any) => {
          state.updates.push({ vals, where });
          return Promise.resolve();
        },
      }),
    })),
  },
  ...tables,
}));

const getSession = vi.hoisted(() =>
  vi.fn(async () => ({ userId: "user-1", tenantId: "tenant-A" })),
);
vi.mock("@/lib/auth", () => ({
  getSession: () => getSession(),
}));

const sendOrderConfirmation = vi.hoisted(() => vi.fn());
const sendOrderStatusUpdate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: (...args: any[]) => sendOrderConfirmation(...args),
  sendOrderStatusUpdate: (...args: any[]) => sendOrderStatusUpdate(...args),
}));

vi.mock("@/lib/base-url", () => ({
  getTenantUrl: vi.fn(() => "https://gallery-a.example.com/orders"),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

import {
  markFulfilled,
  markCancelled,
  resendConfirmationEmail,
  saveTrackingNote,
} from "@/app/(admin)/(gated)/orders/[id]/actions";
import { and, eq } from "drizzle-orm";

function formData(entries: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

const orderA = {
  id: "order-1",
  tenantId: "tenant-A",
  status: "PAID",
  buyerEmail: "buyer@example.com",
  buyerName: "Buyer",
  fulfillmentType: "SHIPPING",
  trackingNote: null,
};

const scopedWhere = (tenantId: string) =>
  and(
    eq(tables.ordersTable.id as any, "order-1"),
    eq(tables.ordersTable.tenantId as any, tenantId),
  );

beforeEach(() => {
  vi.clearAllMocks();
  state.updates.length = 0;
  state.orderFindWhere = null;
  getSession.mockResolvedValue({ userId: "user-1", tenantId: "tenant-A" });
  tenantFindFirst.mockResolvedValue({
    id: "tenant-A",
    businessName: "Gallery A",
  });
  itemFindFirst.mockResolvedValue({ artworkTitle: "Sunset" });
  // Simulate real tenant scoping: only return the order if the where
  // clause matches the tenant-scoped condition for tenant-A + order-1,
  // or the plain id lookup used after ownership is established.
  orderFindFirst.mockImplementation(async (opts: any) => {
    const scoped = JSON.stringify(scopedWhere("tenant-A"));
    const byId = JSON.stringify(eq(tables.ordersTable.id as any, "order-1"));
    const w = JSON.stringify(opts?.where);
    return w === scoped || w === byId ? orderA : undefined;
  });
  sendOrderConfirmation.mockResolvedValue(undefined);
  sendOrderStatusUpdate.mockResolvedValue(undefined);
});

describe("cross-tenant order ids are rejected with no side effects", () => {
  const asTenantB = () =>
    getSession.mockResolvedValue({ userId: "user-2", tenantId: "tenant-B" });

  it("markFulfilled throws 'Order not found.' and updates/emails nothing", async () => {
    asTenantB();
    await expect(
      markFulfilled(formData({ orderId: "order-1" })),
    ).rejects.toThrow("Order not found.");
    expect(state.updates).toEqual([]);
    expect(sendOrderStatusUpdate).not.toHaveBeenCalled();
  });

  it("markCancelled throws 'Order not found.' and updates nothing", async () => {
    asTenantB();
    await expect(
      markCancelled(formData({ orderId: "order-1" })),
    ).rejects.toThrow("Order not found.");
    expect(state.updates).toEqual([]);
  });

  it("resendConfirmationEmail throws 'Order not found.' and emails nothing", async () => {
    asTenantB();
    await expect(
      resendConfirmationEmail(formData({ orderId: "order-1" })),
    ).rejects.toThrow("Order not found.");
    expect(sendOrderConfirmation).not.toHaveBeenCalled();
    expect(state.updates).toEqual([]);
  });

  it("saveTrackingNote throws 'Order not found.' and updates/emails nothing", async () => {
    asTenantB();
    await expect(
      saveTrackingNote(formData({ orderId: "order-1", note: "shipped" })),
    ).rejects.toThrow("Order not found.");
    expect(state.updates).toEqual([]);
    expect(sendOrderStatusUpdate).not.toHaveBeenCalled();
  });

  it("nonexistent order ids are also rejected", async () => {
    await expect(
      markFulfilled(formData({ orderId: "no-such-order" })),
    ).rejects.toThrow("Order not found.");
    expect(state.updates).toEqual([]);
  });
});

describe("ownership lookups always include the session tenantId", () => {
  it("markCancelled scopes the ownership lookup by tenantId", async () => {
    await markCancelled(formData({ orderId: "order-1" }));
    expect(JSON.stringify(state.orderFindWhere)).toEqual(
      JSON.stringify(scopedWhere("tenant-A")),
    );
    // and the update proceeds for the owning tenant
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].vals).toEqual({ status: "CANCELLED" });
  });

  it("markFulfilled proceeds for the owning tenant and notifies the buyer", async () => {
    await markFulfilled(formData({ orderId: "order-1" }));
    expect(state.updates[0].vals).toEqual({ status: "FULFILLED" });
    expect(sendOrderStatusUpdate).toHaveBeenCalledTimes(1);
  });

  it("saveTrackingNote proceeds for the owning tenant", async () => {
    await saveTrackingNote(formData({ orderId: "order-1", note: "on its way" }));
    expect(
      state.updates.some(
        (u) => JSON.stringify(u.vals) === JSON.stringify({ trackingNote: "on its way" }),
      ),
    ).toBe(true);
  });
});
