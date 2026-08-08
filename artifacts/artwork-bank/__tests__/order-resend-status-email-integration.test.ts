/**
 * resendStatusEmail action — real-DB integration.
 *
 * app/(admin)/(gated)/orders/[id]/actions.ts:369-374:
 *   resendStatusEmail(formData) → requireOwnership → notifyBuyerOfUpdate(orderId)
 *   notifyBuyerOfUpdate updates ordersTable:
 *     statusEmailQueuedAt = now, statusEmailError = null, statusEmailAttempts = 0
 *   then attempts an immediate email send.
 *
 *  1. After resend, statusEmailQueuedAt is set to a recent timestamp.
 *  2. After resend, statusEmailAttempts resets to 0.
 *  3. After resend, statusEmailError is cleared to null.
 *  4. Foreign tenant order is blocked (requireOwnership throws).
 *  5. Resend on a CANCELLED order still queues the status email.
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

function uid() { return `${randomUUID()}-rsee-${RUN}-${++seq}`; }

const mockSession = { value: { userId: "u-resend-status", tenantId: "PLACEHOLDER", role: "owner" } };

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => mockSession.value),
}));
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
  hasActiveAccess: () => true,
}));
vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: vi.fn(async () => {}),
  sendOrderStatusUpdate: vi.fn(async () => {}),
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
    id, slug: id, businessName: "Resend Status Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  await db.insert(tenantUsersTable).values({ tenantId: id, userId, role: "owner" } as any);
  return { tenantId: id };
}

async function createOrder(
  tenantId: string,
  opts: { status?: string; statusEmailAttempts?: number; statusEmailError?: string | null } = {},
) {
  const id = uid();
  await db.insert(ordersTable).values({
    id, tenantId, status: opts.status ?? "PAID",
    totalCents: 20000,
    buyerEmail: `buyer-${id}@test.com`,
    buyerName: "Resend Status Buyer",
    fulfillmentType: "PICKUP",
    stripeSessionId: `cs_test_${id}`,
    statusEmailAttempts: opts.statusEmailAttempts ?? 0,
    statusEmailError: opts.statusEmailError ?? null,
  } as any);
  createdOrderIds.push(id);
  return id;
}

function fd(orderId: string) {
  const f = new FormData();
  f.set("orderId", orderId);
  return f;
}

async function orderFields(orderId: string) {
  const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
  return row ?? null;
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

const RECENT_THRESHOLD_MS = 10_000; // 10 seconds

describeIntegration("resendStatusEmail action — real-DB integration", () => {
  it("statusEmailQueuedAt is set to a recent timestamp after resend", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createOrder(tenantId);
    const before = Date.now();

    await resendStatusEmail(fd(orderId))
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const row = await orderFields(orderId);
    expect(row?.statusEmailQueuedAt).not.toBeNull();
    const queued = row!.statusEmailQueuedAt!.getTime();
    expect(queued).toBeGreaterThanOrEqual(before - RECENT_THRESHOLD_MS);
  });

  it("statusEmailAttempts resets to 0 after resend", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createOrder(tenantId, { statusEmailAttempts: 3 });

    await resendStatusEmail(fd(orderId))
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const row = await orderFields(orderId);
    expect(row?.statusEmailAttempts).toBe(0);
  });

  it("statusEmailError is cleared to null after resend", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createOrder(tenantId, { statusEmailError: "SMTP timeout" });

    await resendStatusEmail(fd(orderId))
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const row = await orderFields(orderId);
    expect(row?.statusEmailError).toBeNull();
  });

  it("foreign tenant order is blocked by requireOwnership", async () => {
    const { tenantId: ownId } = await createTenant();

    const foreignTenantId = uid();
    await db.insert(tenantsTable).values({
      id: foreignTenantId, slug: foreignTenantId,
      businessName: "Foreign Resend Gallery", type: "ARTIST",
    } as any);
    createdTenantIds.push(foreignTenantId);
    const foreignOrderId = uid();
    await db.insert(ordersTable).values({
      id: foreignOrderId, tenantId: foreignTenantId, status: "PAID",
      totalCents: 20000,
      buyerEmail: `buyer-${foreignOrderId}@test.com`,
      buyerName: "Foreign Buyer",
      fulfillmentType: "PICKUP",
      stripeSessionId: `cs_test_${foreignOrderId}`,
    } as any);
    createdOrderIds.push(foreignOrderId);

    // Session is still for ownId (set by last createTenant call above).
    mockSession.value = { ...mockSession.value, tenantId: ownId };

    await expect(resendStatusEmail(fd(foreignOrderId))).rejects.toThrow("Order not found");
  });

  it("resend on a CANCELLED order still queues the status email", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createOrder(tenantId, { status: "CANCELLED" });

    await resendStatusEmail(fd(orderId))
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const row = await orderFields(orderId);
    expect(row?.statusEmailQueuedAt).not.toBeNull();
    expect(row?.statusEmailAttempts).toBe(0);
  });
});
