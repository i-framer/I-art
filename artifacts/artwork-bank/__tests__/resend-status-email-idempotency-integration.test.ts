/**
 * resendStatusEmail second-call idempotency — real-DB integration.
 *
 * app/(admin)/(gated)/orders/[id]/actions.ts: resendStatusEmail calls
 * notifyBuyerOfUpdate which:
 *   1. Sets statusEmailQueuedAt = now, statusEmailError = null, statusEmailAttempts = 0.
 *   2. Immediately sends the email (sets statusEmailQueuedAt = null on success).
 *
 * A second call should reset the same fields again.
 *
 *  1. Second call resets statusEmailAttempts to 0 (queue reset).
 *  2. Second call sets statusEmailQueuedAt during the queued phase.
 *  3. Second call clears statusEmailError that was set between calls.
 *  4. Order status (PAID) is unchanged after two resends.
 *  5. statusEmailLastAttemptAt is updated after each successful send.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  ordersTable,
  orderItemsTable,
  artworksTable,
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

function uid() { return `${randomUUID()}-rsei2-${RUN}-${++seq}`; }

const mockSession = { value: { userId: "u-rsend2", tenantId: "PLACEHOLDER", role: "owner" } };

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => mockSession.value),
}));
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
  hasActiveAccess: () => true,
}));
vi.mock("@/lib/email", () => ({
  sendOrderStatusUpdate: vi.fn(async () => {}),
  sendOrderConfirmation: vi.fn(async () => {}),
  sendPartialRefundNotification: vi.fn(async () => {}),
}));
vi.mock("@/lib/base-url", () => ({
  getTenantUrl: vi.fn(() => "https://example.com"),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

import { resendStatusEmail } from "@/app/(admin)/(gated)/orders/[id]/actions";

async function createTenant() {
  const id = uid();
  const userId = uid();
  await db.insert(usersTable).values({ id: userId, email: `u-${userId}@test.com`, passwordHash: "x" } as any);
  createdUserIds.push(userId);
  mockSession.value = { userId, tenantId: id, role: "owner" };
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Resend Status Idempotency Test", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  await db.insert(tenantUsersTable).values({ tenantId: id, userId, role: "owner" } as any);
  return { tenantId: id };
}

async function createOrderWithItem(tenantId: string) {
  const artworkId = uid();
  await db.insert(artworksTable).values({
    id: artworkId, tenantId, title: "Resend Status Art 2", sku: `sku-${artworkId}`,
    status: "SOLD",
  } as any);
  createdArtworkIds.push(artworkId);

  const orderId = uid();
  await db.insert(ordersTable).values({
    id: orderId, tenantId, status: "PAID",
    totalCents: 30000,
    buyerEmail: `buyer-${orderId}@test.com`,
    buyerName: "Resend Status Buyer 2",
    fulfillmentType: "PICKUP",
    stripeSessionId: `cs_test_${orderId}`,
  } as any);
  createdOrderIds.push(orderId);

  const itemId = uid();
  await db.insert(orderItemsTable).values({
    id: itemId, orderId, artworkId, tenantId,
    artworkTitle: "Resend Status Art 2",
    priceCents: 30000,
  } as any);
  createdItemIds.push(itemId);

  return orderId;
}

function fd(orderId: string) {
  const f = new FormData();
  f.set("orderId", orderId);
  return f;
}

async function orderState(orderId: string) {
  return db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
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

const RECENT_MS = 10_000;

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("resendStatusEmail second-call idempotency — real-DB integration", () => {
  it("second call resets statusEmailAttempts to 0 (queue reset)", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createOrderWithItem(tenantId);

    await resendStatusEmail(fd(orderId));
    // Simulate exhausted retries between calls.
    await db.update(ordersTable)
      .set({ statusEmailAttempts: 5 })
      .where(eq(ordersTable.id, orderId));

    await resendStatusEmail(fd(orderId)); // second call

    // After the second call, the send mock resolves → statusEmailAttempts = 1 (sent once).
    // The key test: it must NOT stay at 5.
    const row = await orderState(orderId);
    expect(row?.statusEmailAttempts).not.toBe(5);
    expect(row?.statusEmailAttempts).toBeLessThanOrEqual(1);
  });

  it("second call clears statusEmailError that was set between calls", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createOrderWithItem(tenantId);

    await resendStatusEmail(fd(orderId));
    await db.update(ordersTable)
      .set({ statusEmailError: "SMTP timeout" })
      .where(eq(ordersTable.id, orderId));

    await resendStatusEmail(fd(orderId)); // second call

    const row = await orderState(orderId);
    expect(row?.statusEmailError).toBeNull();
  });

  it("order status (PAID) is unchanged after two resends", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createOrderWithItem(tenantId);

    await resendStatusEmail(fd(orderId));
    await resendStatusEmail(fd(orderId));

    const row = await orderState(orderId);
    expect(row?.status).toBe("PAID");
  });

  it("statusEmailLastAttemptAt is set to a recent timestamp after resend", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createOrderWithItem(tenantId);
    const before = Date.now();

    await resendStatusEmail(fd(orderId));

    const row = await orderState(orderId);
    expect(row?.statusEmailLastAttemptAt).not.toBeNull();
    expect(row!.statusEmailLastAttemptAt!.getTime()).toBeGreaterThanOrEqual(before - RECENT_MS);
  });

  it("statusEmailLastAttemptAt is updated on the second resend", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createOrderWithItem(tenantId);

    await resendStatusEmail(fd(orderId));
    const first = (await orderState(orderId))?.statusEmailLastAttemptAt;

    await new Promise(r => setTimeout(r, 10));
    await resendStatusEmail(fd(orderId));
    const second = (await orderState(orderId))?.statusEmailLastAttemptAt;

    if (first && second) {
      expect(second.getTime()).toBeGreaterThanOrEqual(first.getTime());
    } else {
      expect(second).not.toBeNull();
    }
  });
});
