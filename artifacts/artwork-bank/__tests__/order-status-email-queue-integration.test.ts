/**
 * Order status email queue fields — persistence — real-DB integration.
 *
 * lib/db/src/schema/order.ts:56-62 defines statusEmailQueuedAt, statusEmailError,
 * statusEmailAttempts, and statusEmailLastAttemptAt.
 *
 * These are set by notifyBuyerOfUpdate (called on markFulfilled, markCancelled).
 * This suite verifies DB-layer persistence of these fields:
 *
 *  1. statusEmailQueuedAt is persisted and read back correctly.
 *  2. statusEmailAttempts is persisted correctly.
 *  3. statusEmailError is persisted correctly.
 *  4. statusEmailLastAttemptAt is persisted correctly.
 *  5. Fields can be cleared (reset after successful send).
 *  6. Field isolation: status email fields don't affect order confirmation email fields.
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable, ordersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdOrderIds: string[] = [];

function uid() { return `${randomUUID()}-oseq-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Status Email Queue Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createOrder(tenantId: string) {
  const id = uid();
  await db.insert(ordersTable).values({
    id, tenantId, status: "FULFILLED",
    totalCents: 12000,
    buyerEmail: `buyer-${id}@test.com`,
    buyerName: "Queue Test Buyer",
    fulfillmentType: "PICKUP",
    stripeSessionId: `cs_test_${id}`,
  } as any);
  createdOrderIds.push(id);
  return id;
}

async function cleanup() {
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

describeIntegration("Order status email queue fields — persistence — real-DB integration", () => {
  it("statusEmailQueuedAt is persisted and read back correctly", async () => {
    const tenantId = await createTenant();
    const orderId  = await createOrder(tenantId);
    const now = new Date();

    await db.update(ordersTable)
      .set({ statusEmailQueuedAt: now })
      .where(eq(ordersTable.id, orderId));

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.statusEmailQueuedAt).toBeInstanceOf(Date);
    expect(row?.statusEmailQueuedAt!.getTime()).toBeCloseTo(now.getTime(), -2);
  });

  it("statusEmailAttempts is persisted correctly", async () => {
    const tenantId = await createTenant();
    const orderId  = await createOrder(tenantId);

    await db.update(ordersTable)
      .set({ statusEmailAttempts: 3 })
      .where(eq(ordersTable.id, orderId));

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.statusEmailAttempts).toBe(3);
  });

  it("statusEmailError is persisted correctly", async () => {
    const tenantId = await createTenant();
    const orderId  = await createOrder(tenantId);

    await db.update(ordersTable)
      .set({ statusEmailError: "SMTP connection refused." })
      .where(eq(ordersTable.id, orderId));

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.statusEmailError).toBe("SMTP connection refused.");
  });

  it("statusEmailLastAttemptAt is persisted correctly", async () => {
    const tenantId = await createTenant();
    const orderId  = await createOrder(tenantId);
    const now = new Date();

    await db.update(ordersTable)
      .set({ statusEmailLastAttemptAt: now })
      .where(eq(ordersTable.id, orderId));

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.statusEmailLastAttemptAt).toBeInstanceOf(Date);
  });

  it("status email fields can be cleared after successful send", async () => {
    const tenantId = await createTenant();
    const orderId  = await createOrder(tenantId);

    // Set some queue state.
    await db.update(ordersTable)
      .set({
        statusEmailQueuedAt: new Date(),
        statusEmailAttempts: 2,
        statusEmailError: "Previous error.",
      })
      .where(eq(ordersTable.id, orderId));

    // Clear them (simulate successful delivery).
    await db.update(ordersTable)
      .set({
        statusEmailQueuedAt: null,
        statusEmailAttempts: 0,
        statusEmailError: null,
      })
      .where(eq(ordersTable.id, orderId));

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.statusEmailQueuedAt).toBeNull();
    expect(row?.statusEmailAttempts).toBe(0);
    expect(row?.statusEmailError).toBeNull();
  });

  it("status email fields do not affect order confirmation email fields", async () => {
    const tenantId = await createTenant();
    const orderId  = await createOrder(tenantId);

    await db.update(ordersTable)
      .set({ statusEmailQueuedAt: new Date(), statusEmailError: "Status fail." })
      .where(eq(ordersTable.id, orderId));

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    // Confirmation email fields must be unset.
    expect(row?.emailSentAt).toBeNull();
    expect(row?.emailError).toBeNull();
    // Status email fields set correctly.
    expect(row?.statusEmailQueuedAt).toBeInstanceOf(Date);
    expect(row?.statusEmailError).toBe("Status fail.");
  });
});
