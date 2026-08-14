/**
 * markCancelled — buyer notification
 *
 * When an admin cancels an order, the buyer should receive a status-update
 * email. The email is first queued (so the background sweep can retry it on
 * failure), then an immediate send is attempted.
 *
 * Before this fix, markCancelled silently omitted the notifyBuyerOfUpdate
 * call that markFulfilled had, leaving buyers unaware of the cancellation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Auth / billing mocks ───────────────────────────────────────────────────
const getSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ getSession }));
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn().mockResolvedValue(undefined),
}));

// ── Email mock ─────────────────────────────────────────────────────────────
const sendOrderStatusUpdate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({
  sendOrderStatusUpdate,
  sendOrderConfirmation: vi.fn().mockResolvedValue(undefined),
  sendPartialRefundNotification: vi.fn().mockResolvedValue(undefined),
}));

// ── Utility mocks ──────────────────────────────────────────────────────────
vi.mock("@/lib/base-url", () => ({
  getTenantUrl: vi.fn().mockReturnValue("https://gallery-a.test/orders"),
  getPlatformBaseUrl: vi.fn().mockReturnValue("https://platform.test"),
}));
vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(),
  StripeNotConfiguredError: class StripeNotConfiguredError extends Error {},
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// ── DB mock ────────────────────────────────────────────────────────────────
const dbUpdateSets: Record<string, unknown>[] = [];

const orderRow = {
  id: "order-1",
  tenantId: "tenant-A",
  status: "PAID",
  buyerEmail: "buyer@example.com",
  buyerName: "Test Buyer",
  trackingNote: null,
  stripePaymentIntentId: null,
  totalCents: 10000,
  refundedAmountCents: 0,
  statusEmailQueuedAt: null,
  statusEmailError: null,
  statusEmailAttempts: 0,
};

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      ordersTable: { findFirst: vi.fn(async () => orderRow) },
      orderItemsTable: {
        findFirst: vi.fn(async () => ({ artworkTitle: "Sunset Painting" })),
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
        return {
          where: () =>
            Object.assign(Promise.resolve(undefined), {
              returning: () => Promise.resolve([{ id: "order-1" }]),
            }),
        };
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
    statusEmailLastAttemptAt: "orders.statusEmailLastAttemptAt",
  },
  orderItemsTable: { orderId: "orderItems.orderId" },
  tenantsTable: { id: "tenants.id" },
  eq: vi.fn(),
  and: vi.fn(),
}));

// ── Helpers ────────────────────────────────────────────────────────────────
import { markCancelled } from "@/app/(admin)/(gated)/orders/[id]/actions";

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks(); // reset call counts before each test
  dbUpdateSets.length = 0;
  sendOrderStatusUpdate.mockResolvedValue(undefined);
  getSession.mockResolvedValue({
    userId: "user-1",
    tenantId: "tenant-A",
    role: "owner",
  });
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("markCancelled — buyer notification", () => {
  it("sets order status to CANCELLED", async () => {
    await markCancelled(formData({ orderId: "order-1" }));
    expect(dbUpdateSets.some((s) => s.status === "CANCELLED")).toBe(true);
  });

  it("queues the status email before attempting send", async () => {
    await markCancelled(formData({ orderId: "order-1" }));
    const queueSet = dbUpdateSets.find(
      (s) => "statusEmailQueuedAt" in s && s.statusEmailError === null,
    );
    expect(queueSet).toBeDefined();
  });

  it("calls sendOrderStatusUpdate with the buyer's email", async () => {
    await markCancelled(formData({ orderId: "order-1" }));
    expect(sendOrderStatusUpdate).toHaveBeenCalledOnce();
    expect(sendOrderStatusUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ buyerEmail: "buyer@example.com" }),
    );
  });

  it("persists the error and does NOT throw when email send fails", async () => {
    sendOrderStatusUpdate.mockRejectedValueOnce(new Error("SMTP timeout"));

    // Should not throw — the error is stored for the retry sweep
    await expect(
      markCancelled(formData({ orderId: "order-1" })),
    ).resolves.toBeUndefined();

    expect(dbUpdateSets.some((s) => s.status === "CANCELLED")).toBe(true);
    const errSet = dbUpdateSets.find(
      (s) => typeof s.statusEmailError === "string",
    );
    expect(errSet?.statusEmailError).toContain("SMTP timeout");
  });
});
