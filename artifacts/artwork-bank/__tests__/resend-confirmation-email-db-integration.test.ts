/**
 * resendConfirmationEmail action — real-DB integration.
 *
 * app/(admin)/(gated)/orders/[id]/actions.ts:376-423:
 *   On success: ordersTable.emailSentAt = now, emailError = null, emailLastAttemptAt = now.
 *   On failure: ordersTable.emailError = err.message, emailLastAttemptAt = now, emailAttempts = 1.
 *
 *  1. Success: emailSentAt is set to a recent timestamp.
 *  2. Success: emailError is cleared to null.
 *  3. Success: emailLastAttemptAt is updated.
 *  4. Failure: emailError persists the error message.
 *  5. Failure: emailAttempts resets to 1 (retry budget restored).
 *  6. Foreign tenant order is blocked (requireOwnership throws).
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

function uid() { return `${randomUUID()}-rcedi-${RUN}-${++seq}`; }

const mockSession = { value: { userId: "u-resend-conf", tenantId: "PLACEHOLDER", role: "owner" } };
const emailShouldFail = { value: false };

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => mockSession.value),
}));
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
  hasActiveAccess: () => true,
}));
vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: vi.fn(async (opts: any) => {
    if (emailShouldFail.value) throw new Error("SMTP connection refused");
    return true;
  }),
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

import { resendConfirmationEmail } from "@/app/(admin)/(gated)/orders/[id]/actions";

async function createTenant() {
  const id = uid();
  const userId = uid();
  await db.insert(usersTable).values({ id: userId, email: `u-${userId}@test.com`, passwordHash: "x" } as any);
  createdUserIds.push(userId);
  mockSession.value = { userId, tenantId: id, role: "owner" };
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Resend Confirm Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  await db.insert(tenantUsersTable).values({ tenantId: id, userId, role: "owner" } as any);
  return { tenantId: id };
}

async function createOrderWithItem(tenantId: string, opts: { emailAttempts?: number; emailError?: string | null } = {}) {
  const artworkId = uid();
  await db.insert(artworksTable).values({
    id: artworkId, tenantId, title: "Resend Confirm Art", sku: `sku-${artworkId}`, status: "SOLD",
  } as any);
  createdArtworkIds.push(artworkId);

  const orderId = uid();
  await db.insert(ordersTable).values({
    id: orderId, tenantId, status: "PAID",
    totalCents: 25000,
    buyerEmail: `buyer-${orderId}@test.com`,
    buyerName: "Resend Confirm Buyer",
    fulfillmentType: "PICKUP",
    stripeSessionId: `cs_test_${orderId}`,
    emailAttempts: opts.emailAttempts ?? 0,
    emailError: opts.emailError ?? null,
  } as any);
  createdOrderIds.push(orderId);

  const itemId = uid();
  await db.insert(orderItemsTable).values({
    id: itemId, orderId, artworkId, tenantId,
    artworkTitle: "Resend Confirm Art",
    priceCents: 25000,
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
  emailShouldFail.value = false;
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

describeIntegration("resendConfirmationEmail action — real-DB integration", () => {
  it("success: emailSentAt is set to a recent timestamp", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createOrderWithItem(tenantId);
    const before = Date.now();

    await resendConfirmationEmail(fd(orderId));

    const row = await orderState(orderId);
    expect(row?.emailSentAt).not.toBeNull();
    expect(row!.emailSentAt!.getTime()).toBeGreaterThanOrEqual(before - RECENT_MS);
  });

  it("success: emailError is cleared to null", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createOrderWithItem(tenantId, { emailError: "Previous error" });

    await resendConfirmationEmail(fd(orderId));

    const row = await orderState(orderId);
    expect(row?.emailError).toBeNull();
  });

  it("success: emailLastAttemptAt is updated to a recent timestamp", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createOrderWithItem(tenantId);
    const before = Date.now();

    await resendConfirmationEmail(fd(orderId));

    const row = await orderState(orderId);
    expect(row?.emailLastAttemptAt).not.toBeNull();
    expect(row!.emailLastAttemptAt!.getTime()).toBeGreaterThanOrEqual(before - RECENT_MS);
  });

  it("failure: emailError persists the error message", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createOrderWithItem(tenantId);
    emailShouldFail.value = true;

    await resendConfirmationEmail(fd(orderId));

    const row = await orderState(orderId);
    expect(row?.emailError).toBe("SMTP connection refused");
  });

  it("failure: emailAttempts resets to 1 (retry budget restored)", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createOrderWithItem(tenantId, { emailAttempts: 5 });
    emailShouldFail.value = true;

    await resendConfirmationEmail(fd(orderId));

    const row = await orderState(orderId);
    expect(row?.emailAttempts).toBe(1);
  });

  it("foreign tenant order is blocked by requireOwnership", async () => {
    const { tenantId: ownId } = await createTenant();

    const foreignTenantId = uid();
    await db.insert(tenantsTable).values({
      id: foreignTenantId, slug: foreignTenantId,
      businessName: "Foreign Resend Gallery", type: "ARTIST",
    } as any);
    createdTenantIds.push(foreignTenantId);
    const foreignOrderId = await createOrderWithItem(foreignTenantId);

    mockSession.value = { ...mockSession.value, tenantId: ownId };

    await expect(resendConfirmationEmail(fd(foreignOrderId))).rejects.toThrow("Order not found");
  });
});
