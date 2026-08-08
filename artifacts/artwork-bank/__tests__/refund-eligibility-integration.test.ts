/**
 * refundOrder — status-eligibility real-DB integration.
 *
 * Unit tests (order-refund.test.ts) cover the full refund flow with mocked DB.
 * This integration suite verifies that the status-eligibility guard fires
 * correctly against real PostgreSQL rows:
 *
 *  - PAID and FULFILLED orders are eligible for refund (guard passes).
 *  - PENDING and CANCELLED orders are rejected before any Stripe call.
 *  - An order with no stripePaymentIntentId is rejected before Stripe.
 *  - A fully-refunded order is rejected (maxRefundable ≤ 0).
 *  - Tenant isolation: foreign orderId throws before any Stripe call.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, ordersTable, orderItemsTable, artworksTable, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Auth ──────────────────────────────────────────────────────────────────────
const mockTenantId = { value: "PLACEHOLDER" };
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ userId: "u-refund", tenantId: mockTenantId.value })),
}));
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
  hasActiveAccess: () => true,
}));

// ── Stripe — track calls; list returns empty so create is always reached ──────
const refundCreate = vi.hoisted(() => vi.fn().mockRejectedValue(new Error("No refund in test")));
const refundList = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ data: [] }),
);
vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn().mockResolvedValue({
    refunds: { create: refundCreate, list: refundList },
  }),
  StripeNotConfiguredError: class extends Error {},
}));

vi.mock("@/lib/email", () => ({
  sendOrderStatusUpdate: vi.fn(async () => {}),
  sendOrderConfirmation: vi.fn(async () => {}),
  sendPartialRefundNotification: vi.fn(async () => {}),
}));
vi.mock("@/lib/base-url", () => ({
  getTenantUrl: vi.fn(() => "https://test.example/orders"),
  getPlatformBaseUrl: vi.fn(() => "https://platform.test"),
}));
vi.mock("@/lib/slack", () => ({
  sendRefundDbFailureSlackNotification: vi.fn(async () => {}),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

import { refundOrder } from "@/app/(admin)/(gated)/orders/[id]/actions";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdOrderIds: string[] = [];

function uid() {
  return `${randomUUID()}-rf-${RUN}-${++seq}`;
}

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id,
    businessName: "Refund Eligibility Test Gallery",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: "active",
  } as any);
  createdTenantIds.push(id);
  mockTenantId.value = id;
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Test", sku: `sku-${id}`, status: "SOLD", showInGallery: false,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createOrder(
  tenantId: string,
  artworkId: string,
  opts: {
    status?: string;
    stripePaymentIntentId?: string | null;
    refundedAmountCents?: number | null;
  } = {},
) {
  const id = uid();
  await db.insert(ordersTable).values({
    id, tenantId,
    status: opts.status ?? "PAID",
    buyerEmail: "buyer@example.com",
    buyerName: "Buyer",
    totalCents: 10000,
    fulfillmentType: "PICKUP",
    stripePaymentIntentId: opts.stripePaymentIntentId !== undefined
      ? opts.stripePaymentIntentId
      : "pi_test_refund",
    refundedAmountCents: opts.refundedAmountCents ?? null,
  } as any);
  await db.insert(orderItemsTable).values({
    id: uid(), orderId: id, artworkId, tenantId,
    artworkTitle: "Test", priceCents: 10000,
  } as any);
  createdOrderIds.push(id);
  return id;
}

afterEach(async () => {
  refundCreate.mockClear();
  refundList.mockClear();
  for (const id of createdOrderIds.splice(0)) {
    await db.delete(orderItemsTable).where(eq(orderItemsTable.orderId, id)).catch(() => {});
    await db.delete(ordersTable).where(eq(ordersTable.id, id)).catch(() => {});
  }
  for (const id of createdArtworkIds.splice(0)) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
});

afterAll(async () => {
  for (const id of createdOrderIds.splice(0)) {
    await db.delete(orderItemsTable).where(eq(orderItemsTable.orderId, id)).catch(() => {});
    await db.delete(ordersTable).where(eq(ordersTable.id, id)).catch(() => {});
  }
  for (const id of createdArtworkIds.splice(0)) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
});

function fd(orderId: string, amount?: string) {
  const f = new FormData();
  f.set("orderId", orderId);
  if (amount !== undefined) f.set("refundAmountDollars", amount);
  return f;
}

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("refundOrder — eligibility guards (real DB)", () => {
  it("passes the status guard for a PAID order and proceeds to Stripe", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId, { status: "PAID" });

    // Stripe is mocked to reject — that's fine, we only care the guard passed.
    await expect(refundOrder(fd(orderId))).rejects.toThrow();
    // Guard did NOT redirect with refund_error — it proceeded to Stripe.
    expect(refundCreate).toHaveBeenCalledTimes(1);
  });

  it("passes the status guard for a FULFILLED order and proceeds to Stripe", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId, { status: "FULFILLED" });

    await expect(refundOrder(fd(orderId))).rejects.toThrow();
    expect(refundCreate).toHaveBeenCalledTimes(1);
  });

  it("redirects with refund_error for a PENDING order — Stripe NOT called", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId, { status: "PENDING" });

    await expect(refundOrder(fd(orderId))).rejects.toThrow(
      "REDIRECT:/orders/" + orderId + "?refund_error=",
    );
    expect(refundCreate).not.toHaveBeenCalled();
  });

  it("redirects with refund_error for a CANCELLED order — Stripe NOT called", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId, { status: "CANCELLED" });

    await expect(refundOrder(fd(orderId))).rejects.toThrow(
      "REDIRECT:/orders/" + orderId + "?refund_error=",
    );
    expect(refundCreate).not.toHaveBeenCalled();
  });

  it("redirects when order has no stripePaymentIntentId — Stripe NOT called", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId, {
      status: "PAID",
      stripePaymentIntentId: null,
    });

    await expect(refundOrder(fd(orderId))).rejects.toThrow("REDIRECT:");
    expect(refundCreate).not.toHaveBeenCalled();
  });

  it("redirects when order is fully refunded — Stripe NOT called", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId, {
      status: "PAID",
      refundedAmountCents: 10000, // totalCents = 10000, so maxRefundable = 0
    });

    await expect(refundOrder(fd(orderId))).rejects.toThrow("REDIRECT:");
    expect(refundCreate).not.toHaveBeenCalled();
  });

  it("rejects a foreign tenant's orderId before Stripe is called", async () => {
    const tenantA = await createTenant();
    const artworkId = await createArtwork(tenantA);
    const orderId = await createOrder(tenantA, artworkId, { status: "PAID" });

    const tenantB = await createTenant();
    mockTenantId.value = tenantB;

    await expect(refundOrder(fd(orderId))).rejects.toThrow("Order not found");
    expect(refundCreate).not.toHaveBeenCalled();
  });
});
