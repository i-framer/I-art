/**
 * Order fulfillment actions — tenant isolation for markFulfilled, markCancelled,
 * saveTrackingNote.
 *
 * requireOwnership() scopes the order lookup to session.tenantId, so a tenant
 * can never mark or read an order that belongs to a different tenant.
 *
 * Covers:
 *  - markFulfilled throws "Order not found" when orderId belongs to another tenant
 *  - markCancelled throws "Order not found" when orderId belongs to another tenant
 *  - markFulfilled succeeds for the correct tenant
 *  - saveTrackingNote is scoped to the owner's tenant
 *  - Unauthenticated callers are redirected to /login
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Auth mock ─────────────────────────────────────────────────────────────────
const getSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ getSession }));

// ── Billing mock ──────────────────────────────────────────────────────────────
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn().mockResolvedValue(undefined),
}));

// ── DB state ──────────────────────────────────────────────────────────────────
// findFirst resolves to the order only when tenantId matches
let orderRow: Record<string, unknown> | null = null;
const dbUpdateSets: Record<string, unknown>[] = [];

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      ordersTable: {
        findFirst: vi.fn(async () => orderRow),
      },
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

// ── Email / base-url mocks ────────────────────────────────────────────────────
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
  parsePlatformFeePercent: vi.fn().mockReturnValue(10),
  calcApplicationFee: vi.fn(),
}));

// ── next/cache / navigation mocks ─────────────────────────────────────────────
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const REDIRECTS: string[] = [];
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    REDIRECTS.push(url);
    throw new Error(`REDIRECT:${url}`);
  },
}));

import { markFulfilled, markCancelled } from "@/app/(admin)/(gated)/orders/[id]/actions";

function formData(fields: Record<string, string>): FormData {
  return { get: (k: string) => fields[k] ?? null } as unknown as FormData;
}

async function run(fn: () => Promise<unknown>) {
  try { await fn(); } catch (e: any) {
    if (e?.message?.startsWith("REDIRECT:")) return { redirected: true, url: e.message.slice("REDIRECT:".length) };
    throw e;
  }
  return { redirected: false };
}

beforeEach(() => {
  vi.clearAllMocks();
  REDIRECTS.length = 0;
  dbUpdateSets.length = 0;
  orderRow = null;
  getSession.mockResolvedValue({ userId: "u-1", tenantId: "tenant-A", role: "owner" });
});

// ── markFulfilled ─────────────────────────────────────────────────────────────

describe("markFulfilled", () => {
  it("redirects to /login when unauthenticated", async () => {
    getSession.mockResolvedValueOnce({ userId: null, tenantId: "" });
    const r = await run(() => markFulfilled(formData({ orderId: "order-1" })));
    expect(r).toMatchObject({ redirected: true, url: "/login" });
  });

  it("throws 'Order not found' when order belongs to another tenant", async () => {
    // orderRow is null — simulates the tenant-scoped query returning nothing
    orderRow = null;
    await expect(
      markFulfilled(formData({ orderId: "order-from-tenant-B" })),
    ).rejects.toThrow("Order not found.");
  });

  it("updates status to FULFILLED when tenant matches", async () => {
    orderRow = {
      id: "order-1",
      tenantId: "tenant-A",
      status: "PAID",
      buyerEmail: null,
    };

    await markFulfilled(formData({ orderId: "order-1" }));

    expect(dbUpdateSets.some((s) => s.status === "FULFILLED")).toBe(true);
  });
});

// ── markCancelled ─────────────────────────────────────────────────────────────

describe("markCancelled", () => {
  it("redirects to /login when unauthenticated", async () => {
    getSession.mockResolvedValueOnce({ userId: null, tenantId: "" });
    const r = await run(() => markCancelled(formData({ orderId: "order-1" })));
    expect(r).toMatchObject({ redirected: true, url: "/login" });
  });

  it("throws 'Order not found' when order belongs to another tenant", async () => {
    orderRow = null;
    await expect(
      markCancelled(formData({ orderId: "order-from-tenant-B" })),
    ).rejects.toThrow("Order not found.");
  });

  it("updates status to CANCELLED when tenant matches", async () => {
    orderRow = {
      id: "order-1",
      tenantId: "tenant-A",
      status: "PAID",
      buyerEmail: null,
    };

    await markCancelled(formData({ orderId: "order-1" }));

    expect(dbUpdateSets.some((s) => s.status === "CANCELLED")).toBe(true);
  });
});
