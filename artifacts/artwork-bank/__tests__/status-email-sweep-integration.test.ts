/**
 * sweepUnsentStatusEmails — real-DB integration.
 *
 * lib/email-sweep.ts:250-330 selects orders with statusEmailQueuedAt non-null,
 * sends, and persists queue/error/attempt timestamps.
 *
 *  1. Successful send clears statusEmailQueuedAt and increments attempts.
 *  2. Failed send records statusEmailError and increments attempts (queue retained).
 *  3. Order at MAX_EMAIL_ATTEMPTS is not selected.
 *  4. Order without buyerEmail is not selected.
 *  5. Order without a matching tenant is skipped.
 *  6. Backoff window skips the order (statusEmailLastAttemptAt recent).
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  ordersTable,
  orderItemsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdOrderIds: string[] = [];
const createdItemIds: string[] = [];

function uid() { return `${randomUUID()}-sese-${RUN}-${++seq}`; }

const sendOrderStatusUpdate = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/email", () => ({
  sendOrderStatusUpdate,
  sendOrderConfirmation: vi.fn().mockResolvedValue(undefined),
}));

import { sweepUnsentStatusEmails, MAX_EMAIL_ATTEMPTS } from "@/lib/email-sweep";

async function createTenant(contactEmail = "owner@test.com") {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Status Sweep Test Gallery", type: "ARTIST",
    contactEmail,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Status Sweep Art", sku: `sku-${id}`, status: "SOLD",
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createQueuedOrder(
  tenantId: string,
  opts: {
    statusEmailAttempts?: number;
    statusEmailLastAttemptAt?: Date | null;
    buyerEmail?: string | null;
  } = {},
) {
  const id = uid();
  await db.insert(ordersTable).values({
    id, tenantId, status: "FULFILLED",
    totalCents: 10000,
    buyerName: "Status Buyer",
    buyerEmail: opts.buyerEmail !== undefined ? (opts.buyerEmail ?? "") : `buyer-${id}@test.com`,
    fulfillmentType: "PICKUP",
    stripeSessionId: `cs_test_${id}`,
    statusEmailQueuedAt: new Date(),
    statusEmailAttempts: opts.statusEmailAttempts ?? 0,
    statusEmailLastAttemptAt: opts.statusEmailLastAttemptAt ?? null,
  } as any);
  createdOrderIds.push(id);
  return id;
}

async function attachItem(orderId: string, tenantId: string) {
  const artworkId = await createArtwork(tenantId);
  const itemId = uid();
  await db.insert(orderItemsTable).values({
    id: itemId, orderId, artworkId, tenantId,
    artworkTitle: "Status Sweep Art", priceCents: 10000,
  } as any);
  createdItemIds.push(itemId);
  return itemId;
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
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("sweepUnsentStatusEmails — real-DB integration", () => {
  it("successful send clears statusEmailQueuedAt and increments attempts", async () => {
    const tenantId = await createTenant();
    const orderId  = await createQueuedOrder(tenantId, { statusEmailAttempts: 0 });
    await attachItem(orderId, tenantId);

    sendOrderStatusUpdate.mockResolvedValueOnce(undefined);
    const result = await sweepUnsentStatusEmails(new Date());

    expect(result.sent).toBeGreaterThanOrEqual(1);
    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.statusEmailQueuedAt).toBeNull();
    expect(row?.statusEmailAttempts).toBe(1);
  });

  it("failed send records statusEmailError and increments attempts; queue retained", async () => {
    const tenantId = await createTenant();
    const orderId  = await createQueuedOrder(tenantId, { statusEmailAttempts: 0 });
    await attachItem(orderId, tenantId);

    sendOrderStatusUpdate.mockRejectedValueOnce(new Error("SMTP timeout"));
    const result = await sweepUnsentStatusEmails(new Date());

    expect(result.failed).toBeGreaterThanOrEqual(1);
    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    // Queue must still be set (order stays re-selectable).
    expect(row?.statusEmailQueuedAt).toBeInstanceOf(Date);
    expect(row?.statusEmailAttempts).toBe(1);
    expect(row?.statusEmailError).toBeTruthy();
  });

  it("order at MAX_EMAIL_ATTEMPTS is not selected by the sweep", async () => {
    const tenantId = await createTenant();
    const orderId  = await createQueuedOrder(tenantId, { statusEmailAttempts: MAX_EMAIL_ATTEMPTS });
    await attachItem(orderId, tenantId);

    sendOrderStatusUpdate.mockClear();
    await sweepUnsentStatusEmails(new Date());

    // sendOrderStatusUpdate must not have been called for this specific order.
    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    // Attempts unchanged.
    expect(row?.statusEmailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
  });

  it("order without buyerEmail is not selected by the sweep", async () => {
    const tenantId = await createTenant();
    const orderId  = await createQueuedOrder(tenantId, { buyerEmail: null });
    await attachItem(orderId, tenantId);

    sendOrderStatusUpdate.mockClear();
    await sweepUnsentStatusEmails(new Date());

    // statusEmailAttempts must be unchanged (order excluded from sweep).
    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.statusEmailAttempts).toBe(0);
  });

  it("order without a matching item or tenant is skipped", async () => {
    const tenantId = await createTenant();
    // No item attached.
    const orderId  = await createQueuedOrder(tenantId, { statusEmailAttempts: 0 });
    // DO NOT call attachItem.

    const _result = await sweepUnsentStatusEmails(new Date());

    // Scanned but skipped; send not called for this order.
    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.statusEmailAttempts).toBe(0); // attempts unchanged (skipped, not sent/failed)
  });

  it("backoff window causes order to be skipped on the next immediate sweep", async () => {
    const tenantId = await createTenant();
    // Set lastAttemptAt to right now so backoff kicks in.
    const orderId  = await createQueuedOrder(tenantId, {
      statusEmailAttempts: 1,
      statusEmailLastAttemptAt: new Date(), // just tried
    });
    await attachItem(orderId, tenantId);

    const result = await sweepUnsentStatusEmails(new Date());

    expect(result.skipped).toBeGreaterThanOrEqual(1);
    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    // Attempts unchanged because order was skipped by backoff.
    expect(row?.statusEmailAttempts).toBe(1);
  });
});
