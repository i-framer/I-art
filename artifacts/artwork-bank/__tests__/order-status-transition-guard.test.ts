/**
 * Order status transition guards — markFulfilled and markCancelled.
 *
 * markFulfilled  — only valid from PAID; all other statuses redirect with
 *                  action_error and must NOT update the DB.
 * markCancelled  — invalid from CANCELLED or FULFILLED; redirects with
 *                  action_error and must NOT update the DB.
 *
 * Tenant isolation is covered separately in order-fulfillment-isolation.test.ts.
 * This suite focuses on the status-guard invariants.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Auth ──────────────────────────────────────────────────────────────────────
const getSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ getSession }));

vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn().mockResolvedValue(undefined),
}));

// ── DB ────────────────────────────────────────────────────────────────────────
let orderRow: Record<string, unknown> | null = null;
const dbUpdateSets: Record<string, unknown>[] = [];

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      ordersTable: { findFirst: vi.fn(async () => orderRow) },
      orderItemsTable: {
        findFirst: vi.fn(async () => ({ artworkTitle: "Painting" })),
      },
      tenantsTable: {
        findFirst: vi.fn(async () => ({
          id: "tenant-A",
          businessName: "Gallery A",
          customDomain: null,
          slug: "gallery-a",
        })),
      },
    },
    update: () => ({
      set: (vals: Record<string, unknown>) => {
        dbUpdateSets.push(vals);
        return { where: async () => undefined };
      },
    }),
  },
  ordersTable: {
    id: "orders.id",
    tenantId: "orders.tenantId",
    status: "orders.status",
    statusEmailQueuedAt: "orders.statusEmailQueuedAt",
    statusEmailError: "orders.statusEmailError",
    statusEmailAttempts: "orders.statusEmailAttempts",
  },
  orderItemsTable: { orderId: "orderItems.orderId" },
  tenantsTable: { id: "tenants.id" },
  eq: vi.fn(),
  and: vi.fn(),
}));

vi.mock("@/lib/email", () => ({
  sendOrderStatusUpdate: vi.fn().mockResolvedValue(undefined),
  sendOrderConfirmation: vi.fn().mockResolvedValue(undefined),
  sendPartialRefundNotification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/base-url", () => ({
  getTenantUrl: vi.fn().mockReturnValue("https://gallery-a.test/orders"),
  getPlatformBaseUrl: vi.fn().mockReturnValue("https://platform.test"),
}));
vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(),
  StripeNotConfiguredError: class extends Error {},
}));
vi.mock("@/lib/slack", () => ({
  sendRefundDbFailureSlackNotification: vi.fn().mockResolvedValue(undefined),
}));

const redirectSpy = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
);
vi.mock("next/navigation", () => ({ redirect: (u: string) => redirectSpy(u) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { markFulfilled, markCancelled } from "@/app/(admin)/(gated)/orders/[id]/actions";

function fd(orderId: string) {
  const f = new FormData();
  f.set("orderId", orderId);
  return f;
}

function order(status: string) {
  return {
    id: "order-1",
    tenantId: "tenant-A",
    status,
    buyerEmail: "buyer@example.com",
    buyerName: "Buyer",
    totalCents: 10_000,
    refundedAmountCents: null,
    stripePaymentIntentId: "pi_test",
    trackingNote: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbUpdateSets.length = 0;
  orderRow = null;
  getSession.mockResolvedValue({ userId: "u1", tenantId: "tenant-A" });
});

// ── markFulfilled ─────────────────────────────────────────────────────────────

describe("markFulfilled — status guard", () => {
  it("succeeds and updates status when order is PAID", async () => {
    orderRow = order("PAID");
    await markFulfilled(fd("order-1"));
    const statusUpdate = dbUpdateSets.find((u) => "status" in u);
    expect(statusUpdate?.status).toBe("FULFILLED");
  });

  it("redirects with action_error and does NOT update DB when order is PENDING", async () => {
    orderRow = order("PENDING");
    await expect(markFulfilled(fd("order-1"))).rejects.toThrow("REDIRECT:");
    const url = redirectSpy.mock.calls[0]![0] as string;
    expect(url).toContain("action_error=");
    expect(decodeURIComponent(url)).toMatch(/PENDING/i);
    const statusUpdate = dbUpdateSets.find((u) => u.status === "FULFILLED");
    expect(statusUpdate).toBeUndefined();
  });

  it("redirects with action_error and does NOT update DB when order is already FULFILLED", async () => {
    orderRow = order("FULFILLED");
    await expect(markFulfilled(fd("order-1"))).rejects.toThrow("REDIRECT:");
    const statusUpdate = dbUpdateSets.find((u) => u.status === "FULFILLED");
    expect(statusUpdate).toBeUndefined();
  });

  it("redirects with action_error and does NOT update DB when order is CANCELLED", async () => {
    orderRow = order("CANCELLED");
    await expect(markFulfilled(fd("order-1"))).rejects.toThrow("REDIRECT:");
    const statusUpdate = dbUpdateSets.find((u) => u.status === "FULFILLED");
    expect(statusUpdate).toBeUndefined();
  });
});

// ── markCancelled ─────────────────────────────────────────────────────────────

describe("markCancelled — status guard", () => {
  it("succeeds and updates status when order is PAID", async () => {
    orderRow = order("PAID");
    await markCancelled(fd("order-1"));
    const statusUpdate = dbUpdateSets.find((u) => "status" in u);
    expect(statusUpdate?.status).toBe("CANCELLED");
  });

  it("succeeds and updates status when order is PENDING", async () => {
    orderRow = order("PENDING");
    await markCancelled(fd("order-1"));
    const statusUpdate = dbUpdateSets.find((u) => "status" in u);
    expect(statusUpdate?.status).toBe("CANCELLED");
  });

  it("redirects with action_error when order is already CANCELLED", async () => {
    orderRow = order("CANCELLED");
    await expect(markCancelled(fd("order-1"))).rejects.toThrow("REDIRECT:");
    const url = redirectSpy.mock.calls[0]![0] as string;
    expect(url).toContain("action_error=");
    expect(decodeURIComponent(url)).toMatch(/cancelled/i);
    // Must not write a second CANCELLED update.
    const statusUpdate = dbUpdateSets.find((u) => u.status === "CANCELLED");
    expect(statusUpdate).toBeUndefined();
  });

  it("redirects with action_error when order is FULFILLED", async () => {
    orderRow = order("FULFILLED");
    await expect(markCancelled(fd("order-1"))).rejects.toThrow("REDIRECT:");
    const url = redirectSpy.mock.calls[0]![0] as string;
    expect(url).toContain("action_error=");
    expect(decodeURIComponent(url)).toMatch(/fulfilled/i);
    const statusUpdate = dbUpdateSets.find((u) => u.status === "CANCELLED");
    expect(statusUpdate).toBeUndefined();
  });
});
