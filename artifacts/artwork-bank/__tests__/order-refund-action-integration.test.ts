/**
 * refundOrder action — real-DB integration.
 *
 * app/(admin)/(gated)/orders/[id]/actions.ts:189-365:
 *   Reads order from DB, calls Stripe refunds.list (reconciliation) then
 *   refunds.create, then writes to ordersTable:
 *     refundedAmountCents, refundedAt, stripeRefundId, and status→CANCELLED on full refund.
 *
 *  1. Partial refund: refundedAmountCents accumulates, status stays PAID.
 *  2. Full refund: refundedAmountCents = totalCents, status → CANCELLED.
 *  3. Partial + partial = full: second refund tips into full refund → CANCELLED.
 *  4. Guard: CANCELLED order is blocked (status guard fires).
 *  5. Guard: already fully refunded (maxRefundable ≤ 0) is blocked.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  ordersTable,
  orderItemsTable,
  usersTable,
  tenantUsersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdOrderIds: string[] = [];
const createdItemIds: string[] = [];
const createdUserIds: string[] = [];

function uid() { return `${randomUUID()}-orai-${RUN}-${++seq}`; }

const mockSession = { value: { userId: "u-refund", tenantId: "PLACEHOLDER", role: "owner" } };
const mockStripeRefundId = { value: `re_${uid()}` };

/** Minimal Stripe mock that immediately succeeds. */
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
    id, slug: id, businessName: "Refund Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  await db.insert(tenantUsersTable).values({ tenantId: id, userId, role: "owner" } as any);
  return { tenantId: id };
}

async function createOrder(tenantId: string, status: string = "PAID", refundedAmountCents: number | null = null) {
  const id = uid();
  await db.insert(ordersTable).values({
    id, tenantId, status,
    totalCents: 50000,
    buyerEmail: `buyer-${id}@test.com`,
    buyerName: "Refund Buyer",
    fulfillmentType: "PICKUP",
    stripeSessionId: `cs_test_${id}`,
    stripePaymentIntentId: `pi_test_${id}`,
    refundedAmountCents,
  } as any);
  createdOrderIds.push(id);
  return id;
}

function fd(orderId: string, refundAmountDollars?: string) {
  const f = new FormData();
  f.set("orderId", orderId);
  if (refundAmountDollars !== undefined) f.set("refundAmountDollars", refundAmountDollars);
  return f;
}

async function orderState(orderId: string) {
  const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
  return row ?? null;
}

async function cleanup() {
  for (const id of createdItemIds.splice(0)) {
    await db.delete(orderItemsTable).where(eq(orderItemsTable.id, id)).catch(() => {});
  }
  for (const id of createdOrderIds.splice(0)) {
    await db.delete(ordersTable).where(eq(ordersTable.id, id)).catch(() => {});
  }
  for (const id of createdArtworkIds.splice(0)) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
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

describeIntegration("refundOrder action — real-DB integration", () => {
  it("partial refund: refundedAmountCents accumulates, status stays PAID", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createOrder(tenantId, "PAID", null);
    mockStripeRefundId.value = `re_partial_${uid()}`;

    await refundOrder(fd(orderId, "100")) // $100 = 10000 cents of $500 total
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const row = await orderState(orderId);
    expect(row?.refundedAmountCents).toBe(10000);
    expect(row?.status).toBe("PAID");
    expect(row?.refundedAt).not.toBeNull();
    expect(row?.stripeRefundId).toBe(mockStripeRefundId.value);
  });

  it("full refund: refundedAmountCents = totalCents, status → CANCELLED", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createOrder(tenantId, "PAID", null);
    mockStripeRefundId.value = `re_full_${uid()}`;

    // $500 = 50000 cents = totalCents → full refund
    await refundOrder(fd(orderId, "500"))
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const row = await orderState(orderId);
    expect(row?.refundedAmountCents).toBe(50000);
    expect(row?.status).toBe("CANCELLED");
    expect(row?.refundedAt).not.toBeNull();
  });

  it("partial then full: second refund tips into full → CANCELLED", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createOrder(tenantId, "PAID", null);

    // First: partial refund of $200
    mockStripeRefundId.value = `re_first_${uid()}`;
    await refundOrder(fd(orderId, "200"))
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    let row = await orderState(orderId);
    expect(row?.refundedAmountCents).toBe(20000);
    expect(row?.status).toBe("PAID");

    // Second: remaining $300 → full refund
    mockStripeRefundId.value = `re_second_${uid()}`;
    await refundOrder(fd(orderId, "300"))
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    row = await orderState(orderId);
    expect(row?.refundedAmountCents).toBe(50000);
    expect(row?.status).toBe("CANCELLED");
  });

  it("CANCELLED order is blocked before touching Stripe or DB", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createOrder(tenantId, "CANCELLED", null);

    let redirectUrl = "";
    await refundOrder(fd(orderId, "100"))
      .catch(e => { redirectUrl = String(e); });

    expect(redirectUrl).toContain("REDIRECT");
    expect(redirectUrl).toContain("refund_error");

    const row = await orderState(orderId);
    expect(row?.refundedAmountCents).toBeNull(); // unchanged
    expect(row?.status).toBe("CANCELLED"); // unchanged
  });

  it("already fully refunded order is blocked (maxRefundable ≤ 0)", async () => {
    const { tenantId } = await createTenant();
    // Pre-set refundedAmountCents = totalCents
    const orderId = await createOrder(tenantId, "PAID", 50000);

    let redirectUrl = "";
    await refundOrder(fd(orderId, "100"))
      .catch(e => { redirectUrl = String(e); });

    expect(redirectUrl).toContain("REDIRECT");
    expect(redirectUrl).toContain("refund_error");

    // DB should be unchanged
    const row = await orderState(orderId);
    expect(row?.refundedAmountCents).toBe(50000);
  });
});
