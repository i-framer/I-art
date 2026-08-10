/**
 * Checkout order buyer fields (buyerEmail, buyerName) — real-DB integration.
 *
 * The Stripe webhook checkout.session.completed handler (route.ts:671-689)
 * extracts buyerEmail from `session.customer_details.email` and buyerName from
 * `session.customer_details.name`. This suite verifies DB-level persistence:
 *
 *  1. buyerEmail is persisted and read back correctly.
 *  2. buyerName is persisted and read back correctly.
 *  3. Null buyerName is stored and returned as null.
 *  4. buyerEmail and buyerName are both present on the orders query.
 *  5. Buyer fields do not bleed across orders.
 *  6. buyerEmail update persists correctly (resend/edit path).
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

function uid() { return `${randomUUID()}-cbf-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Buyer Fields Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function _createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Buyer Test Art", sku: `sku-${id}`, status: "SOLD",
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function insertOrder(tenantId: string, buyerEmail: string, buyerName: string | null) {
  const id = uid();
  await db.insert(ordersTable).values({
    id, tenantId, status: "PAID",
    totalCents: 20000,
    buyerEmail,
    buyerName,
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

describeIntegration("Checkout order buyer fields — persistence — real-DB integration", () => {
  it("buyerEmail is persisted and read back correctly", async () => {
    const tenantId = await createTenant();
    const orderId = await insertOrder(tenantId, "alice@buyer.test", "Alice Buyer");

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.buyerEmail).toBe("alice@buyer.test");
  });

  it("buyerName is persisted and read back correctly", async () => {
    const tenantId = await createTenant();
    const orderId = await insertOrder(tenantId, "bob@buyer.test", "Bob Collector");

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.buyerName).toBe("Bob Collector");
  });

  it("null buyerName is stored and returned as null", async () => {
    const tenantId = await createTenant();
    const orderId = await insertOrder(tenantId, "anon@buyer.test", null);

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.buyerName).toBeNull();
  });

  it("both buyerEmail and buyerName are present on the orders query result", async () => {
    const tenantId = await createTenant();
    const orderId = await insertOrder(tenantId, "carol@buyer.test", "Carol Smith");

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.buyerEmail).toBe("carol@buyer.test");
    expect(row?.buyerName).toBe("Carol Smith");
  });

  it("buyer fields do not bleed across orders", async () => {
    const tenantId = await createTenant();
    const order1 = await insertOrder(tenantId, "buyer1@test.com", "Buyer One");
    const order2 = await insertOrder(tenantId, "buyer2@test.com", "Buyer Two");

    const [row1, row2] = await Promise.all([
      db.query.ordersTable.findFirst({ where: eq(ordersTable.id, order1) }),
      db.query.ordersTable.findFirst({ where: eq(ordersTable.id, order2) }),
    ]);

    expect(row1?.buyerEmail).toBe("buyer1@test.com");
    expect(row1?.buyerName).toBe("Buyer One");
    expect(row2?.buyerEmail).toBe("buyer2@test.com");
    expect(row2?.buyerName).toBe("Buyer Two");
  });

  it("buyerEmail can be updated (resend path)", async () => {
    const tenantId = await createTenant();
    const orderId = await insertOrder(tenantId, "old@buyer.test", "Same Name");

    await db.update(ordersTable)
      .set({ buyerEmail: "new@buyer.test" })
      .where(eq(ordersTable.id, orderId));

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.buyerEmail).toBe("new@buyer.test");
  });
});
