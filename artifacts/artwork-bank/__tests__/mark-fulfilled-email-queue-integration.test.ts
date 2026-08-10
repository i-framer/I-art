/**
 * markFulfilled action — status email queue persistence — real-DB integration.
 *
 * app/(admin)/(gated)/orders/[id]/actions.ts:147-165:
 *   1. Sets order status to FULFILLED.
 *   2. Calls notifyBuyerOfUpdate which sets statusEmailQueuedAt = now.
 *
 * This suite verifies those DB writes:
 *
 *  1. Order status becomes FULFILLED.
 *  2. statusEmailQueuedAt is set (non-null) after markFulfilled.
 *  3. statusEmailAttempts starts at 0.
 *  4. Foreign tenant order cannot be fulfilled via own session.
 *  5. Already-FULFILLED order cannot be re-fulfilled.
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

function uid() { return `${randomUUID()}-mfeq-${RUN}-${++seq}`; }

const mockSession = { value: { userId: "u-fulfill-test", tenantId: "PLACEHOLDER", role: "owner" } };

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => mockSession.value),
}));
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
  hasActiveAccess: () => true,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

// Don't let email actually send.
vi.mock("@/lib/email", () => ({
  sendOrderStatusUpdate: vi.fn().mockResolvedValue(undefined),
}));

import { markFulfilled } from "@/app/(admin)/(gated)/orders/[id]/actions";

async function createTenant() {
  const id = uid();
  const userId = uid();
  await db.insert(usersTable).values({ id: userId, email: `u-${userId}@test.com`, passwordHash: "x" } as any);
  createdUserIds.push(userId);
  mockSession.value = { userId, tenantId: id, role: "owner" };
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Fulfill Queue Test Gallery", type: "ARTIST",
    contactEmail: "gallery@fulfill.test",
  } as any);
  createdTenantIds.push(id);
  await db.insert(tenantUsersTable).values({ tenantId: id, userId, role: "owner" } as any);
  return { tenantId: id, userId };
}

async function createOrder(tenantId: string, status: "PAID" | "FULFILLED" = "PAID") {
  const id = uid();
  await db.insert(ordersTable).values({
    id, tenantId, status,
    totalCents: 15000,
    buyerEmail: `buyer-${id}@test.com`,
    buyerName: "Fulfill Buyer",
    fulfillmentType: "PICKUP",
    stripeSessionId: `cs_test_${id}`,
  } as any);
  createdOrderIds.push(id);
  return id;
}

function fd(entries: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
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

describeIntegration("markFulfilled action — status email queue — real-DB integration", () => {
  it("order status becomes FULFILLED", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createOrder(tenantId, "PAID");

    await markFulfilled(fd({ orderId }))
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.status).toBe("FULFILLED");
  });

  it("statusEmailQueuedAt is set (non-null) after markFulfilled", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createOrder(tenantId, "PAID");

    await markFulfilled(fd({ orderId }))
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.statusEmailQueuedAt).toBeInstanceOf(Date);
  });

  it("statusEmailAttempts starts at 0 after queue", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createOrder(tenantId, "PAID");

    await markFulfilled(fd({ orderId }))
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.statusEmailAttempts).toBe(0);
  });

  it("foreign tenant order cannot be fulfilled via own session", async () => {
    const { tenantId: _ownTenantId } = await createTenant();

    const foreignTenantId = uid();
    await db.insert(tenantsTable).values({
      id: foreignTenantId, slug: foreignTenantId,
      businessName: "Foreign Fulfill Gallery", type: "ARTIST",
    } as any);
    createdTenantIds.push(foreignTenantId);
    const foreignOrderId = await createOrder(foreignTenantId, "PAID");

    await markFulfilled(fd({ orderId: foreignOrderId })).catch(() => {
      // Expected: throws "Order not found." or redirects with error.
    });

    // Order status must remain PAID — the action must not fulfil a foreign order.
    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, foreignOrderId) });
    expect(row?.status).toBe("PAID");
  });

  it("already-FULFILLED order cannot be re-fulfilled (redirects to action_error)", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createOrder(tenantId, "FULFILLED");

    let redirectUrl = "";
    await markFulfilled(fd({ orderId })).catch(e => {
      redirectUrl = String(e);
    });

    expect(redirectUrl).toContain("REDIRECT");
    expect(redirectUrl).toContain("action_error");
  });
});
