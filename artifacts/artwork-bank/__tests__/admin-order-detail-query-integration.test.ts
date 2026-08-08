/**
 * Admin order detail page — DB query — real-DB integration.
 *
 * The admin order detail page (app/(admin)/(gated)/orders/[id]/page.tsx)
 * runs three parallel queries:
 *   - ordersTable: WHERE id = ? AND tenantId = session.tenantId
 *   - orderItemsTable: WHERE orderId = ?
 *   - tenantsTable: WHERE id = session.tenantId (iframerAccountId)
 *
 * This suite verifies those query contracts directly against real PostgreSQL:
 *
 *  1. Own order is found with correct status and amount.
 *  2. Foreign-tenant order is NOT found (returns undefined → notFound()).
 *  3. Order items are returned for the correct orderId.
 *  4. Items from a different order do not leak into results.
 *  5. Tenant iframerAccountId is correctly returned.
 *  6. Refund state fields (refundedAmountCents, statusEmailError) are readable.
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

// ── DB helpers ────────────────────────────────────────────────────────────────
const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdOrderIds: string[] = [];
const createdItemIds: string[] = [];

function uid() { return `${randomUUID()}-aodq-${RUN}-${++seq}`; }

async function createTenant(opts: { iframerAccountId?: string } = {}) {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: `Order Detail Test Gallery ${id}`,
    type: "ARTIST",
    iframerAccountId: opts.iframerAccountId ?? null,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Detail Test Artwork", sku: `sku-${id}`, status: "SOLD",
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createOrder(tenantId: string, opts: {
  status?: string;
  totalCents?: number;
  refundedAmountCents?: number | null;
  statusEmailError?: string | null;
} = {}) {
  const id = uid();
  await db.insert(ordersTable).values({
    id, tenantId,
    status: opts.status ?? "PAID",
    totalCents: opts.totalCents ?? 25000,
    buyerName: "Test Buyer",
    buyerEmail: "buyer@detail.test",
    fulfillmentType: "PICKUP",
    refundedAmountCents: opts.refundedAmountCents ?? null,
    statusEmailError: opts.statusEmailError ?? null,
    stripeSessionId: `cs_test_${id}`,
  } as any);
  createdOrderIds.push(id);
  return id;
}

async function addItem(orderId: string, artworkId: string, tenantId: string) {
  const id = uid();
  await db.insert(orderItemsTable).values({
    id, orderId, artworkId, tenantId,
    artworkTitle: "Detail Test Artwork",
    priceCents: 25000,
    fulfillmentType: "PICKUP",
  } as any);
  createdItemIds.push(id);
  return id;
}

/** Mirror the page's order query: tenant-scoped findFirst. */
async function pageOrderQuery(id: string, tenantId: string) {
  return db.query.ordersTable.findFirst({
    where: and(eq(ordersTable.id, id), eq(ordersTable.tenantId, tenantId)),
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

describeIntegration("Admin order detail page — DB query — real-DB integration", () => {
  it("own order is found with correct status and amount", async () => {
    const tenantId = await createTenant();
    const orderId = await createOrder(tenantId, { status: "PAID", totalCents: 30000 });

    const order = await pageOrderQuery(orderId, tenantId);

    expect(order).toBeDefined();
    expect(order?.id).toBe(orderId);
    expect(order?.status).toBe("PAID");
    expect(order?.totalCents).toBe(30000);
    expect(order?.tenantId).toBe(tenantId);
  });

  it("foreign-tenant order is NOT found (returns undefined → page returns notFound)", async () => {
    const ownerTenantId = await createTenant();
    const foreignTenantId = await createTenant();
    const orderId = await createOrder(ownerTenantId);

    // Query as the foreign tenant — must return undefined.
    const order = await pageOrderQuery(orderId, foreignTenantId);

    expect(order).toBeUndefined();
  });

  it("order items are returned for the correct orderId", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId);
    const itemId = await addItem(orderId, artworkId, tenantId);

    const items = await db.query.orderItemsTable.findMany({
      where: eq(orderItemsTable.orderId, orderId),
    });

    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe(itemId);
    expect(items[0]!.artworkTitle).toBe("Detail Test Artwork");
  });

  it("items from a different order do not appear in results", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);

    const orderId1 = await createOrder(tenantId);
    const orderId2 = await createOrder(tenantId);
    await addItem(orderId1, artworkId, tenantId);
    const item2Id = await addItem(orderId2, artworkId, tenantId);

    // Query items for orderId1 only — item2 must not appear.
    const items = await db.query.orderItemsTable.findMany({
      where: eq(orderItemsTable.orderId, orderId1),
    });

    const ids = items.map(i => i.id);
    expect(ids).not.toContain(item2Id);
    expect(ids).toHaveLength(1);
  });

  it("tenant iframerAccountId is correctly returned for the iFramer panel", async () => {
    const tenantId = await createTenant({ iframerAccountId: "ifr-test-001" });

    const tenant = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, tenantId),
      columns: { iframerAccountId: true },
    });

    expect(tenant?.iframerAccountId).toBe("ifr-test-001");
  });

  it("refund state fields (refundedAmountCents, statusEmailError) are readable for badge derivation", async () => {
    const tenantId = await createTenant();
    const orderId = await createOrder(tenantId, {
      status: "PAID",
      totalCents: 40000,
      refundedAmountCents: 10000,
      statusEmailError: "Email delivery failed",
    });

    const order = await pageOrderQuery(orderId, tenantId);

    expect(order?.refundedAmountCents).toBe(10000);
    expect(order?.statusEmailError).toBe("Email delivery failed");
    // maxRefundable = 40000 - 10000 = 30000
    const alreadyRefunded = order?.refundedAmountCents ?? 0;
    const maxRefundable = (order?.totalCents ?? 0) - alreadyRefunded;
    expect(maxRefundable).toBe(30000);
  });
});
