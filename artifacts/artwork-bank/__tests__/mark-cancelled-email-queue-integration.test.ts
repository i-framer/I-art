/**
 * markCancelled action — status email queue persistence — real-DB integration.
 *
 * app/(admin)/(gated)/orders/[id]/actions.ts:168-185:
 *   markCancelled sets status=CANCELLED then calls notifyBuyerOfUpdate,
 *   which writes statusEmailQueuedAt so the background sweep retries.
 *
 *  1. Order status becomes CANCELLED.
 *  2. statusEmailQueuedAt is set (non-null) after markCancelled.
 *  3. statusEmailAttempts is 0 after queue (fresh queue).
 *  4. Already-CANCELLED order cannot be cancelled again (redirects with action_error).
 *  5. FULFILLED order cannot be cancelled (redirects with action_error).
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

function uid() { return `${randomUUID()}-mceq-${RUN}-${++seq}`; }

const mockSession = { value: { userId: "u-cancel-test", tenantId: "PLACEHOLDER", role: "owner" } };

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
vi.mock("@/lib/email", () => ({
  sendOrderStatusUpdate: vi.fn().mockResolvedValue(undefined),
  sendOrderConfirmation: vi.fn().mockResolvedValue(undefined),
}));

import { markCancelled } from "@/app/(admin)/(gated)/orders/[id]/actions";

async function createTenant() {
  const id = uid();
  const userId = uid();
  await db.insert(usersTable).values({ id: userId, email: `u-${userId}@test.com`, passwordHash: "x" } as any);
  createdUserIds.push(userId);
  mockSession.value = { userId, tenantId: id, role: "owner" };
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Cancel Queue Test Gallery", type: "ARTIST",
    contactEmail: "gallery@cancel.test",
  } as any);
  createdTenantIds.push(id);
  await db.insert(tenantUsersTable).values({ tenantId: id, userId, role: "owner" } as any);
  return { tenantId: id, userId };
}

async function createOrder(tenantId: string, status: "PAID" | "CANCELLED" | "FULFILLED" = "PAID") {
  const id = uid();
  await db.insert(ordersTable).values({
    id, tenantId, status,
    totalCents: 20000,
    buyerEmail: `buyer-${id}@test.com`,
    buyerName: "Cancel Buyer",
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

describeIntegration("markCancelled action — status email queue — real-DB integration", () => {
  it("order status becomes CANCELLED", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createOrder(tenantId, "PAID");

    await markCancelled(fd({ orderId }))
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.status).toBe("CANCELLED");
  });

  it("statusEmailQueuedAt is set (non-null) after markCancelled", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createOrder(tenantId, "PAID");

    await markCancelled(fd({ orderId }))
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.statusEmailQueuedAt).toBeInstanceOf(Date);
  });

  it("statusEmailAttempts is 0 after queue (fresh cancellation notification)", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createOrder(tenantId, "PAID");

    await markCancelled(fd({ orderId }))
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.statusEmailAttempts).toBe(0);
  });

  it("already-CANCELLED order cannot be cancelled again (redirects with action_error)", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createOrder(tenantId, "CANCELLED");

    let redirectUrl = "";
    await markCancelled(fd({ orderId })).catch(e => { redirectUrl = String(e); });

    expect(redirectUrl).toContain("REDIRECT");
    expect(redirectUrl).toContain("action_error");
  });

  it("FULFILLED order cannot be cancelled (redirects with action_error)", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createOrder(tenantId, "FULFILLED");

    let redirectUrl = "";
    await markCancelled(fd({ orderId })).catch(e => { redirectUrl = String(e); });

    expect(redirectUrl).toContain("REDIRECT");
    expect(redirectUrl).toContain("action_error");
  });
});
