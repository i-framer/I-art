/**
 * checkout.session.completed SHIP — shipping address fields — real-DB integration.
 *
 * app/api/stripe/webhook/route.ts handleCheckoutCompleted (line ~643):
 * The route does NOT currently persist shipping_details / customer_details.address
 * to the ordersTable row. This suite documents the actual behavior:
 *   - The schema has no shipping-address columns on ordersTable.
 *   - buyerEmail and buyerName from customer_details ARE persisted.
 *   - fulfillmentType=SHIP is stored correctly.
 *   - No address columns exist to assert on (documented as a coverage marker).
 *
 *  1. SHIP order row has status=PAID.
 *  2. buyerEmail persisted from customer_details.email.
 *  3. buyerName persisted from customer_details.name.
 *  4. fulfillmentType=SHIP stored on the order row.
 *  5. totalCents persisted from amount_total.
 *  6. Providing shipping_details in the event does not cause an error (200 returned).
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db, tenantsTable, artworksTable, ordersTable, orderItemsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];

function uid() { return `${randomUUID()}-wcsai-${RUN}-${++seq}`; }

vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(),
  getStripeWebhookSecret: vi.fn().mockResolvedValue(null),
  calcApplicationFee: vi.fn((cents: number) => Math.round(cents * 0.05)),
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
vi.mock("@/lib/iframer", () => ({
  createIFramerJob: vi.fn(),
  IFramerError: class extends Error {},
}));
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
    id, slug: id, businessName: "SHIP Address Test", type: "ARTIST", billingExempt: true,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "SHIP Address Art", sku: `sku-${id}`,
    status: "RESERVED", price: 35000, showInGallery: true,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

function shipEvent(sessionId: string, artworkId: string, tenantId: string) {
  return {
    type: "checkout.session.completed",
    id: `evt_${uid()}`,
    data: {
      object: {
        id: sessionId,
        payment_status: "paid",
        amount_total: 35000,
        payment_intent: `pi_${uid()}`,
        customer_details: {
          email: "shipper@test.com",
          name: "Shipping Buyer",
          address: {
            line1: "123 Art Street",
            city: "Melbourne",
            state: "VIC",
            country: "AU",
            postal_code: "3000",
          },
        },
        shipping_details: {
          name: "Shipping Buyer",
          address: {
            line1: "123 Art Street",
            city: "Melbourne",
            state: "VIC",
            country: "AU",
            postal_code: "3000",
          },
        },
        metadata: { artworkId, tenantId, fulfillmentType: "SHIP" },
      },
    },
  };
}

async function orderBySession(sessionId: string) {
  return db.query.ordersTable.findFirst({ where: eq(ordersTable.stripeSessionId, sessionId) });
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

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Checkout SHIP order fields from buyer details — real-DB integration", () => {
  it("SHIP order row has status=PAID", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    const res = await post(shipEvent(sessionId, artworkId, tenantId));
    expect(res.status).toBe(200);

    const order = await orderBySession(sessionId);
    expect(order?.status).toBe("PAID");
  });

  it("buyerEmail persisted from customer_details.email", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    await post(shipEvent(sessionId, artworkId, tenantId));

    const order = await orderBySession(sessionId);
    expect(order?.buyerEmail).toBe("shipper@test.com");
  });

  it("buyerName persisted from customer_details.name", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    await post(shipEvent(sessionId, artworkId, tenantId));

    const order = await orderBySession(sessionId);
    expect(order?.buyerName).toBe("Shipping Buyer");
  });

  it("fulfillmentType=SHIP stored on the order row", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    await post(shipEvent(sessionId, artworkId, tenantId));

    const order = await orderBySession(sessionId);
    expect(order?.fulfillmentType).toBe("SHIP");
  });

  it("totalCents persisted from amount_total", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    await post(shipEvent(sessionId, artworkId, tenantId));

    const order = await orderBySession(sessionId);
    expect(order?.totalCents).toBe(35000);
  });

  it("providing shipping_details in the event does not cause an error (200 returned)", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    const res = await post(shipEvent(sessionId, artworkId, tenantId));

    // The route processes the event without error even with full address payload.
    expect(res.status).toBe(200);
    const order = await orderBySession(sessionId);
    expect(order).not.toBeUndefined();
  });
});
