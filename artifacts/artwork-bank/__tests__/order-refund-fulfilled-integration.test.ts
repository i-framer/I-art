/**
 * refundOrder action — FULFILLED order full refund → CANCELLED — real-DB integration.
 *
 * app/(admin)/(gated)/orders/[id]/actions.ts:196:
 *   Only PAID or FULFILLED orders can be refunded.
 *   Full refund (newTotalRefunded >= totalCents) sets status → CANCELLED.
 *
 *  1. Full refund of FULFILLED order → status CANCELLED, refundedAmountCents = total.
 *  2. Partial refund of FULFILLED order → status stays FULFILLED, fee accumulates.
 *  3. Partial + partial on FULFILLED eventually CANCELS when fully refunded.
 *  4. FULFILLED order with no stripePaymentIntentId is blocked (redirect).
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  ordersTable,
  usersTable,
  tenantUsersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdOrderIds: string[] = [];
const createdUserIds: string[] = [];

function uid() { return `${randomUUID()}-orfi-${RUN}-${++seq}`; }

const mockSession = { value: { userId: "u-refund-ful", tenantId: "PLACEHOLDER", role: "owner" } };
const mockStripeRefundId = { value: `re_ful_${uid()}` };

const mockStripeClient = {
  refunds: {
    list: vi.fn(async () => ({ data: [] })),
    create: vi.fn(async () => ({ id: mockStripeRefundId.value })),
  },
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => mockSession.value),
}));
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
  hasActiveAccess: () => true,
}));
vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(async () => mockStripeClient),
  StripeNotConfiguredError: class extends Error {},
}));
vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: vi.fn(async () => {}),
  sendOrderStatusUpdate: vi.fn(async () => {}),
  sendPartialRefundNotification: vi.fn(async () => {}),
}));
vi.mock("@/lib/slack", () => ({
  sendRefundDbFailureSlackNotification: vi.fn(async () => {}),
}));
vi.mock("@/lib/base-url", () => ({
  getTenantUrl: vi.fn(() => "https://example.com"),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

import { refundOrder } from "@/app/(admin)/(gated)/orders/[id]/actions";

async function createTenant() {
  const id = uid();
  const userId = uid();
  await db.insert(usersTable).values({ id: userId, email: `u-${userId}@test.com`, passwordHash: "x" } as any);
  createdUserIds.push(userId);
  mockSession.value = { userId, tenantId: id, role: "owner" };
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Refund Fulfilled Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  await db.insert(tenantUsersTable).values({ tenantId: id, userId, role: "owner" } as any);
  return { tenantId: id };
}

async function createFulfilledOrder(tenantId: string, opts: {
  refundedAmountCents?: number | null;
  stripePaymentIntentId?: string | null;
} = {}) {
  const id = uid();
  await db.insert(ordersTable).values({
    id, tenantId, status: "FULFILLED",
    totalCents: 80000,
    buyerEmail: `buyer-${id}@test.com`,
    buyerName: "Fulfilled Refund Buyer",
    fulfillmentType: "PICKUP",
    stripeSessionId: `cs_test_${id}`,
    stripePaymentIntentId: opts.stripePaymentIntentId !== undefined
      ? opts.stripePaymentIntentId
      : `pi_test_${id}`,
    refundedAmountCents: opts.refundedAmountCents ?? null,
  } as any);
  createdOrderIds.push(id);
  return id;
}

function fd(orderId: string, amountDollars?: string) {
  const f = new FormData();
  f.set("orderId", orderId);
  if (amountDollars !== undefined) f.set("refundAmountDollars", amountDollars);
  return f;
}

async function orderState(orderId: string) {
  return db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
}

async function cleanup() {
  for (const id of createdOrderIds.splice(0)) {
    await db.delete(ordersTable).where(eq(ordersTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantUsersTable).where(eq(tenantUsersTable.tenantId, id)).catch(() => {});
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
  for (const id of createdUserIds.splice(0)) {
    await db.delete(usersTable).where(eq(usersTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("refundOrder FULFILLED order — real-DB integration", () => {
  it("full refund of FULFILLED order → status CANCELLED, refundedAmountCents = totalCents", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createFulfilledOrder(tenantId);
    mockStripeRefundId.value = `re_ful_full_${uid()}`;

    // $800 = 80000 cents = totalCents → full refund
    await refundOrder(fd(orderId, "800"))
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const row = await orderState(orderId);
    expect(row?.status).toBe("CANCELLED");
    expect(row?.refundedAmountCents).toBe(80000);
    expect(row?.refundedAt).not.toBeNull();
    expect(row?.stripeRefundId).toBe(mockStripeRefundId.value);
  });

  it("partial refund of FULFILLED order → status stays FULFILLED, amount accumulates", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createFulfilledOrder(tenantId);
    mockStripeRefundId.value = `re_ful_partial_${uid()}`;

    // $200 = 20000 cents, partial refund
    await refundOrder(fd(orderId, "200"))
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const row = await orderState(orderId);
    expect(row?.status).toBe("FULFILLED");
    expect(row?.refundedAmountCents).toBe(20000);
  });

  it("partial + partial on FULFILLED eventually CANCELS when fully refunded", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createFulfilledOrder(tenantId);

    // First: $500 partial
    mockStripeRefundId.value = `re_ful_p1_${uid()}`;
    await refundOrder(fd(orderId, "500"))
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    let row = await orderState(orderId);
    expect(row?.status).toBe("FULFILLED");
    expect(row?.refundedAmountCents).toBe(50000);

    // Second: remaining $300 → full refund
    mockStripeRefundId.value = `re_ful_p2_${uid()}`;
    await refundOrder(fd(orderId, "300"))
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    row = await orderState(orderId);
    expect(row?.status).toBe("CANCELLED");
    expect(row?.refundedAmountCents).toBe(80000);
  });

  it("FULFILLED order with no stripePaymentIntentId is blocked (redirect)", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createFulfilledOrder(tenantId, { stripePaymentIntentId: null });

    let redirectUrl = "";
    await refundOrder(fd(orderId, "100"))
      .catch(e => { redirectUrl = String(e); });

    expect(redirectUrl).toContain("REDIRECT");
    expect(redirectUrl).toContain("refund_error");

    const row = await orderState(orderId);
    expect(row?.refundedAmountCents).toBeNull();
    expect(row?.status).toBe("FULFILLED"); // unchanged
  });
});
