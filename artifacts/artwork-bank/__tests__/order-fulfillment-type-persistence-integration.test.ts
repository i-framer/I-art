/**
 * Order fulfillment type (PICKUP / FRAMING_JOB) — real-DB integration.
 *
 * lib/db/src/schema/order.ts:19-22 defines the enum with two values.
 * This suite verifies persistence and query semantics:
 *
 *  1. PICKUP fulfillment type is persisted and read back correctly.
 *  2. FRAMING_JOB fulfillment type is persisted and read back correctly.
 *  3. Orders with different types can coexist in the same tenant.
 *  4. Fulfillment type does not bleed across tenants.
 *  5. FRAMING_JOB orders can be queried as a filter.
 *  6. Order with PICKUP has null iframerJobId by default.
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

function uid() { return `${randomUUID()}-oftp-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Fulfillment Type Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function _createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Fulfillment Type Test Art", sku: `sku-${id}`, status: "SOLD",
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function insertOrder(tenantId: string, fulfillmentType: "PICKUP" | "FRAMING_JOB") {
  const id = uid();
  await db.insert(ordersTable).values({
    id, tenantId, status: "PAID",
    totalCents: 15000,
    buyerName: "Fulfillment Buyer",
    buyerEmail: `buyer-${id}@test.com`,
    fulfillmentType,
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

describeIntegration("Order fulfillment type persistence — real-DB integration", () => {
  it("PICKUP fulfillment type is persisted and read back correctly", async () => {
    const tenantId = await createTenant();
    const orderId  = await insertOrder(tenantId, "PICKUP");

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.fulfillmentType).toBe("PICKUP");
  });

  it("FRAMING_JOB fulfillment type is persisted and read back correctly", async () => {
    const tenantId = await createTenant();
    const orderId  = await insertOrder(tenantId, "FRAMING_JOB");

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.fulfillmentType).toBe("FRAMING_JOB");
  });

  it("PICKUP and FRAMING_JOB orders coexist in the same tenant", async () => {
    const tenantId  = await createTenant();
    const pickupId  = await insertOrder(tenantId, "PICKUP");
    const framingId = await insertOrder(tenantId, "FRAMING_JOB");

    const [pickup, framing] = await Promise.all([
      db.query.ordersTable.findFirst({ where: eq(ordersTable.id, pickupId) }),
      db.query.ordersTable.findFirst({ where: eq(ordersTable.id, framingId) }),
    ]);

    expect(pickup?.fulfillmentType).toBe("PICKUP");
    expect(framing?.fulfillmentType).toBe("FRAMING_JOB");
  });

  it("fulfillment type does not bleed across tenants", async () => {
    const tenant1 = await createTenant();
    const tenant2 = await createTenant();
    const order1  = await insertOrder(tenant1, "PICKUP");
    const order2  = await insertOrder(tenant2, "FRAMING_JOB");

    const [row1, row2] = await Promise.all([
      db.query.ordersTable.findFirst({ where: eq(ordersTable.id, order1) }),
      db.query.ordersTable.findFirst({ where: eq(ordersTable.id, order2) }),
    ]);

    expect(row1?.fulfillmentType).toBe("PICKUP");
    expect(row2?.fulfillmentType).toBe("FRAMING_JOB");
    expect(row1?.tenantId).toBe(tenant1);
    expect(row2?.tenantId).toBe(tenant2);
  });

  it("FRAMING_JOB orders can be queried as a filter", async () => {
    const tenantId  = await createTenant();
    const pickupId  = await insertOrder(tenantId, "PICKUP");
    const framingId = await insertOrder(tenantId, "FRAMING_JOB");

    const framingOrders = await db.query.ordersTable.findMany({
      where: eq(ordersTable.fulfillmentType, "FRAMING_JOB"),
    });

    const ids = framingOrders.map(o => o.id);
    expect(ids).toContain(framingId);
    expect(ids).not.toContain(pickupId);
  });

  it("PICKUP order has null iframerJobId by default", async () => {
    const tenantId = await createTenant();
    const orderId  = await insertOrder(tenantId, "PICKUP");

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.iframerJobId).toBeNull();
  });
});
