/**
 * FRAMING_JOB order + order-item persistence — real-DB integration.
 *
 * The ordersTable.fulfillmentType enum includes FRAMING_JOB for i-Framer
 * integration orders. The admin order detail page and iFramer webhook handler
 * both depend on this path. This suite verifies DB persistence:
 *
 *  1. FRAMING_JOB order is persisted with correct fulfillmentType.
 *  2. Order item with fulfillmentType=FRAMING_JOB is persisted correctly.
 *  3. Admin detail page query (tenant-scoped) returns the FRAMING_JOB order.
 *  4. iFramerJobId field on the order is persisted and readable.
 *  5. FRAMING_JOB order and PICKUP order for same tenant are both returned.
 *  6. Foreign-tenant FRAMING_JOB order is not returned (tenant isolation).
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  ordersTable,
  orderItemsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdOrderIds: string[] = [];
const createdItemIds: string[] = [];

function uid() { return `${randomUUID()}-ofj-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Framing Job Test Gallery", type: "FRAMER",
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Framing Test Art", sku: `sku-${id}`, status: "SOLD",
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createOrder(tenantId: string, fulfillmentType: "PICKUP" | "SHIP" | "FRAMING_JOB", opts: {
  iFramerJobId?: string | null;
} = {}) {
  const id = uid();
  await db.insert(ordersTable).values({
    id, tenantId, status: "PAID",
    totalCents: 15000,
    buyerName: "Test Buyer",
    buyerEmail: "buyer@framing.test",
    fulfillmentType,
    stripeSessionId: `cs_test_${id}`,
    iframerJobId: opts.iFramerJobId ?? null,
  } as any);
  createdOrderIds.push(id);
  return id;
}

async function addItem(orderId: string, artworkId: string, tenantId: string) {
  const id = uid();
  await db.insert(orderItemsTable).values({
    id, orderId, artworkId, tenantId,
    artworkTitle: "Framing Test Art",
    priceCents: 15000,
  } as any);
  createdItemIds.push(id);
  return id;
}

/** Mirror admin order detail page query (tenant-scoped). */
async function detailQuery(orderId: string, tenantId: string) {
  return db.query.ordersTable.findFirst({
    where: and(eq(ordersTable.id, orderId), eq(ordersTable.tenantId, tenantId)),
  });
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

describeIntegration("FRAMING_JOB order + order-item persistence — real-DB integration", () => {
  it("FRAMING_JOB order is persisted with correct fulfillmentType", async () => {
    const tenantId = await createTenant();
    const orderId = await createOrder(tenantId, "FRAMING_JOB");

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.fulfillmentType).toBe("FRAMING_JOB");
    expect(row?.status).toBe("PAID");
    expect(row?.totalCents).toBe(15000);
  });

  it("order item linked to a FRAMING_JOB order is persisted correctly", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, "FRAMING_JOB");
    const itemId = await addItem(orderId, artworkId, tenantId);

    const item = await db.query.orderItemsTable.findFirst({ where: eq(orderItemsTable.id, itemId) });
    expect(item).toBeDefined();
    expect(item?.orderId).toBe(orderId);
    expect(item?.artworkId).toBe(artworkId);
    expect(item?.artworkTitle).toBe("Framing Test Art");
    expect(item?.priceCents).toBe(15000);

    // The parent order carries the FRAMING_JOB fulfillmentType.
    const order = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(order?.fulfillmentType).toBe("FRAMING_JOB");
  });

  it("admin detail page query (tenant-scoped) returns the FRAMING_JOB order", async () => {
    const tenantId = await createTenant();
    const orderId = await createOrder(tenantId, "FRAMING_JOB");

    const order = await detailQuery(orderId, tenantId);
    expect(order).toBeDefined();
    expect(order?.fulfillmentType).toBe("FRAMING_JOB");
  });

  it("iframerJobId field is persisted and readable", async () => {
    const tenantId = await createTenant();
    const jobId = `ifr-job-${uid()}`;
    const orderId = await createOrder(tenantId, "FRAMING_JOB", { iFramerJobId: jobId });

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.iframerJobId).toBe(jobId);
  });

  it("FRAMING_JOB and PICKUP orders for same tenant are both independently queryable", async () => {
    const tenantId = await createTenant();
    const framingId = await createOrder(tenantId, "FRAMING_JOB");
    const pickupId  = await createOrder(tenantId, "PICKUP");

    const [framingOrder, pickupOrder] = await Promise.all([
      detailQuery(framingId, tenantId),
      detailQuery(pickupId, tenantId),
    ]);

    expect(framingOrder?.fulfillmentType).toBe("FRAMING_JOB");
    expect(pickupOrder?.fulfillmentType).toBe("PICKUP");
  });

  it("foreign-tenant FRAMING_JOB order is not returned (tenant isolation)", async () => {
    const ownTenantId     = await createTenant();
    const foreignTenantId = await createTenant();
    const foreignOrderId  = await createOrder(foreignTenantId, "FRAMING_JOB");

    const order = await detailQuery(foreignOrderId, ownTenantId);
    expect(order).toBeUndefined();
  });
});
