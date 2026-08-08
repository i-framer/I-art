/**
 * Cancelled order detail state — real-DB integration.
 *
 * Verifies DB-layer state for a CANCELLED order as seen by the admin detail
 * view: status, statusEmailQueuedAt presence, refund fields null, buyer fields
 * preserved, and fulfillment fields preserved.
 *
 *  1. Cancelled order status is CANCELLED in DB.
 *  2. Buyer email and name are preserved after cancellation.
 *  3. refundedAmountCents is null for a plain cancellation.
 *  4. refundedAt is null for a plain cancellation.
 *  5. statusEmailQueuedAt is set after markCancelled (email queued).
 *  6. emailSentAt and emailError (confirmation fields) are unaffected.
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

function uid() { return `${randomUUID()}-cods-${RUN}-${++seq}`; }

const mockSession = { value: { userId: "u-cancelled-test", tenantId: "PLACEHOLDER", role: "owner" } };

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
    id, slug: id, businessName: "Cancelled Order Detail Gallery", type: "ARTIST",
    contactEmail: "gallery@cancel.test",
  } as any);
  createdTenantIds.push(id);
  await db.insert(tenantUsersTable).values({ tenantId: id, userId, role: "owner" } as any);
  return { tenantId: id };
}

async function createPaidOrder(tenantId: string) {
  const id = uid();
  await db.insert(ordersTable).values({
    id, tenantId, status: "PAID",
    totalCents: 25000,
    buyerEmail: "buyer-detail@test.com",
    buyerName: "Detail Buyer",
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

describeIntegration("Cancelled order detail state — real-DB integration", () => {
  it("cancelled order status is CANCELLED in DB", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createPaidOrder(tenantId);

    await markCancelled(fd({ orderId }))
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.status).toBe("CANCELLED");
  });

  it("buyer email and name are preserved after cancellation", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createPaidOrder(tenantId);

    await markCancelled(fd({ orderId }))
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.buyerEmail).toBe("buyer-detail@test.com");
    expect(row?.buyerName).toBe("Detail Buyer");
  });

  it("refundedAmountCents is null for a plain cancellation", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createPaidOrder(tenantId);

    await markCancelled(fd({ orderId }))
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.refundedAmountCents).toBeNull();
  });

  it("refundedAt is null for a plain cancellation", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createPaidOrder(tenantId);

    await markCancelled(fd({ orderId }))
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.refundedAt).toBeNull();
  });

  it("statusEmailQueuedAt is set after markCancelled (notification queued)", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createPaidOrder(tenantId);

    await markCancelled(fd({ orderId }))
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.statusEmailQueuedAt).toBeInstanceOf(Date);
  });

  it("emailSentAt and emailError (confirmation fields) are unaffected by cancellation", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createPaidOrder(tenantId);

    await markCancelled(fd({ orderId }))
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    // Confirmation email fields must remain null (not overwritten by cancellation).
    expect(row?.emailSentAt).toBeNull();
    expect(row?.emailError).toBeNull();
  });
});
