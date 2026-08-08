/**
 * checkout.session.completed — SHIP fulfillment type — real-DB integration.
 *
 * app/api/stripe/webhook/route.ts: handles fulfillmentType=SHIP the same as
 * PICKUP at the order-creation level — order row persisted, artwork→SOLD,
 * no iFramer job (FRAMING_JOB only).
 *
 *  1. SHIP checkout creates an order row in the DB.
 *  2. SHIP order has fulfillmentType = "SHIP".
 *  3. Artwork status is set to SOLD after SHIP checkout.
 *  4. SHIP checkout does NOT create an iFramer job (iframerJobId = null).
 *  5. SHIP order totalCents persists from session.amount_total.
 *  6. Duplicate SHIP session redelivery creates only one order.
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

function uid() { return `${randomUUID()}-wcshi-${RUN}-${++seq}`; }

const mockCreateIFramerJob = vi.fn();

vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(),
  getStripeWebhookSecret: vi.fn().mockResolvedValue(null),
  calcApplicationFee: (cents: number) => Math.round(cents * 0.05),
  StripeNotConfiguredError: class extends Error {},
}));
vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: vi.fn(async () => true),
  sendBillingAlertNotification: vi.fn(),
}));
vi.mock("@/lib/slack", () => ({
  sendBillingAlertSlackNotification: vi.fn().mockResolvedValue({ ok: true }),
  sendIframerAccountSlackNotification: vi.fn(async () => {}),
  postToSlack: vi.fn(async () => {}),
}));
vi.mock("@/lib/iframer", () => {
  class IFramerError extends Error {}
  return {
    IFramerError,
    createIFramerJob: (...args: any[]) => mockCreateIFramerJob(...args),
  };
});
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));
vi.mock("@/lib/base-url", () => ({
  getTenantUrl: vi.fn(() => "https://example.com"),
}));

import { POST as webhookPOST } from "@/app/api/stripe/webhook/route";

function post(event: object) {
  return webhookPOST(
    new Request("http://localhost/api/stripe/webhook", {
      method: "POST",
      body: JSON.stringify(event),
    }),
  );
}

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "SHIP Fulfillment Test Gallery",
    type: "ARTIST", billingExempt: true,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Ship Me Art", sku: `sku-${id}`,
    status: "RESERVED", price: 25000,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

function checkoutEvent(sessionId: string, artworkId: string, tenantId: string) {
  return {
    type: "checkout.session.completed",
    id: `evt_${uid()}`,
    data: {
      object: {
        id: sessionId,
        payment_status: "paid",
        amount_total: 25000,
        payment_intent: `pi_${uid()}`,
        customer_details: { email: `ship-buyer-${uid()}@test.com`, name: "Ship Buyer" },
        metadata: { artworkId, tenantId, fulfillmentType: "SHIP" },
      },
    },
  };
}

async function orderBySession(sessionId: string) {
  return db.query.ordersTable.findFirst({ where: eq(ordersTable.stripeSessionId, sessionId) });
}

async function orderCountBySession(sessionId: string) {
  const orders = await db.query.ordersTable.findMany({ where: eq(ordersTable.stripeSessionId, sessionId) });
  return orders.length;
}

async function cleanup() {
  for (const artworkId of createdArtworkIds) {
    const items = await db.query.orderItemsTable.findMany({ where: eq(orderItemsTable.artworkId, artworkId) });
    for (const item of items) {
      await db.delete(orderItemsTable).where(eq(orderItemsTable.id, item.id)).catch(() => {});
      await db.delete(ordersTable).where(eq(ordersTable.id, item.orderId)).catch(() => {});
    }
  }
  for (const id of createdArtworkIds.splice(0)) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(async () => {
  mockCreateIFramerJob.mockReset();
  await cleanup();
});
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Checkout SHIP fulfillment — real-DB integration", () => {
  it("SHIP checkout creates an order row in the DB", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    const res = await post(checkoutEvent(sessionId, artworkId, tenantId));
    expect(res.status).toBe(200);

    const order = await orderBySession(sessionId);
    expect(order).not.toBeUndefined();
  });

  it("SHIP order has fulfillmentType = 'SHIP'", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    await post(checkoutEvent(sessionId, artworkId, tenantId));

    const order = await orderBySession(sessionId);
    expect(order?.fulfillmentType).toBe("SHIP");
  });

  it("artwork status is set to SOLD after SHIP checkout", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    await post(checkoutEvent(sessionId, artworkId, tenantId));

    const artwork = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, artworkId) });
    expect(artwork?.status).toBe("SOLD");
  });

  it("SHIP checkout does NOT trigger iFramer job creation", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    mockCreateIFramerJob.mockResolvedValueOnce({ jobId: `job_${uid()}` });

    await post(checkoutEvent(sessionId, artworkId, tenantId));

    expect(mockCreateIFramerJob).not.toHaveBeenCalled();
    const order = await orderBySession(sessionId);
    expect(order?.iframerJobId).toBeNull();
  });

  it("SHIP order totalCents persists from session.amount_total", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    await post(checkoutEvent(sessionId, artworkId, tenantId));

    const order = await orderBySession(sessionId);
    expect(order?.totalCents).toBe(25000);
  });

  it("duplicate SHIP session redelivery creates only one order", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    await post(checkoutEvent(sessionId, artworkId, tenantId));
    await post(checkoutEvent(sessionId, artworkId, tenantId)); // duplicate

    expect(await orderCountBySession(sessionId)).toBe(1);
  });
});
