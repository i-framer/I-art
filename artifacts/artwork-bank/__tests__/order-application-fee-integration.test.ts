/**
 * Order applicationFeeCents — real-DB integration.
 *
 * lib/db/src/schema/order.ts:39 defines applicationFeeCents as nullable integer.
 * The webhook/checkout path stores this when Stripe reports an application fee
 * on the payment intent. This suite verifies DB-layer persistence:
 *
 *  1. applicationFeeCents is persisted correctly (non-null value).
 *  2. applicationFeeCents can be null (no fee collected).
 *  3. Two independent orders each store their own fee independently.
 *  4. applicationFeeCents is readable on the orders admin query.
 *  5. applicationFeeCents update overwrites a previous value.
 *  6. applicationFeeCents isolation: updating one order does not affect another.
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, ordersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdOrderIds: string[] = [];

function uid() { return `${randomUUID()}-oafi-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "App Fee Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id };
}

async function createOrder(tenantId: string, applicationFeeCents: number | null = null) {
  const id = uid();
  await db.insert(ordersTable).values({
    id, tenantId, status: "PAID",
    totalCents: 15000,
    buyerEmail: `buyer-${id}@test.com`,
    buyerName: "App Fee Buyer",
    fulfillmentType: "PICKUP",
    stripeSessionId: `cs_test_${id}`,
    applicationFeeCents,
  } as any);
  createdOrderIds.push(id);
  return id;
}

async function fee(orderId: string) {
  const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
  return row ? row.applicationFeeCents : undefined;
}

async function cleanup() {
  for (const id of createdOrderIds.splice(0)) {
    await db.delete(ordersTable).where(eq(ordersTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Order applicationFeeCents — real-DB integration", () => {
  it("applicationFeeCents is persisted correctly (non-null value)", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createOrder(tenantId, 500);

    expect(await fee(orderId)).toBe(500);
  });

  it("applicationFeeCents can be null (no fee collected)", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createOrder(tenantId, null);

    expect(await fee(orderId)).toBeNull();
  });

  it("two independent orders each store their own fee independently", async () => {
    const { tenantId } = await createTenant();
    const order1 = await createOrder(tenantId, 300);
    const order2 = await createOrder(tenantId, 750);

    expect(await fee(order1)).toBe(300);
    expect(await fee(order2)).toBe(750);
  });

  it("applicationFeeCents is readable on the admin orders query", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createOrder(tenantId, 1200);

    const rows = await db.query.ordersTable.findMany({
      where: eq(ordersTable.tenantId, tenantId),
    });
    const order = rows.find(r => r.id === orderId);
    expect(order?.applicationFeeCents).toBe(1200);
  });

  it("applicationFeeCents update overwrites a previous value", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createOrder(tenantId, 400);

    await db.update(ordersTable).set({ applicationFeeCents: 600 }).where(eq(ordersTable.id, orderId));

    expect(await fee(orderId)).toBe(600);
  });

  it("applicationFeeCents isolation: updating one order does not affect another", async () => {
    const { tenantId } = await createTenant();
    const order1 = await createOrder(tenantId, 100);
    const order2 = await createOrder(tenantId, 200);

    await db.update(ordersTable).set({ applicationFeeCents: 999 }).where(eq(ordersTable.id, order1));

    expect(await fee(order1)).toBe(999);
    expect(await fee(order2)).toBe(200); // unchanged
  });
});
