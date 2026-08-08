/**
 * checkout.session.completed — PICKUP fulfillment → no shipping address stored — real-DB integration.
 *
 * app/api/stripe/webhook/route.ts (handleCheckoutCompleted):
 *   SHIP: stores buyerAddress, buyerCity, buyerPostcode, buyerState, buyerCountry.
 *   PICKUP: fulfillmentType=PICKUP — shipping address fields should be null/absent.
 *
 *  1. PICKUP event → order created with fulfillmentType=PICKUP.
 *  2. PICKUP event → buyerAddress is null.
 *  3. PICKUP event → buyerCity is null.
 *  4. PICKUP event → buyer email from customer_details persisted.
 *  5. PICKUP event → artwork set to SOLD.
 *  6. PICKUP with shipping_details present in session → address fields still null (PICKUP logic wins).
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

function uid() { return `${randomUUID()}-wcpnsi-${RUN}-${++seq}`; }

vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(),
  getStripeWebhookSecret: vi.fn().mockResolvedValue(null),
  calcApplicationFee: vi.fn(() => 0),
  StripeNotConfiguredError: class extends Error {},
}));
vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: vi.fn(async () => true),
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
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/base-url", () => ({ getTenantUrl: vi.fn(() => "https://example.com") }));

import { POST as webhookPOST } from "@/app/api/stripe/webhook/route";

function pickupEvent(
  sessionId: string,
  artworkId: string,
  tenantId: string,
  opts: { shippingDetails?: object } = {},
) {
  return {
    type: "checkout.session.completed",
    id: `evt_${uid()}`,
    data: {
      object: {
        id: sessionId,
        payment_status: "paid",
        amount_total: 20000,
        payment_intent: `pi_${uid()}`,
        customer_details: {
          email: `pickup-buyer-${uid()}@test.com`,
          name: "Pickup Buyer",
        },
        shipping_details: opts.shippingDetails ?? null,
        metadata: { artworkId, tenantId, fulfillmentType: "PICKUP" },
      },
    },
  };
}

function post(event: object) {
  return webhookPOST(new Request("http://localhost/api/stripe/webhook", {
    method: "POST",
    body: JSON.stringify(event),
  }));
}

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Pickup Test Gallery", type: "ARTIST", billingExempt: true,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Pickup Art", sku: `sku-${id}`,
    status: "RESERVED", price: 20000, showInGallery: true,
  } as any);
  createdArtworkIds.push(id);
  return id;
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

describeIntegration("PICKUP checkout — no shipping address stored — real-DB integration", () => {
  it("PICKUP event → order created with fulfillmentType=PICKUP", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    await post(pickupEvent(sessionId, artworkId, tenantId));

    const order = await orderBySession(sessionId);
    expect(order).not.toBeUndefined();
    expect(order?.fulfillmentType).toBe("PICKUP");
  });

  it("PICKUP event → buyerAddress is null or undefined (not set)", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    await post(pickupEvent(sessionId, artworkId, tenantId));

    const order = await orderBySession(sessionId);
    expect(order?.buyerAddress ?? null).toBeNull();
  });

  it("PICKUP event → buyerCity is null or undefined (not set)", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    await post(pickupEvent(sessionId, artworkId, tenantId));

    const order = await orderBySession(sessionId);
    expect(order?.buyerCity ?? null).toBeNull();
  });

  it("PICKUP event → buyer email from customer_details persisted", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    await post(pickupEvent(sessionId, artworkId, tenantId));

    const order = await orderBySession(sessionId);
    expect(order?.buyerEmail).toMatch(/@test\.com$/);
  });

  it("PICKUP event → artwork set to SOLD", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    await post(pickupEvent(sessionId, artworkId, tenantId));

    const artwork = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, artworkId) });
    expect(artwork?.status).toBe("SOLD");
  });

  it("PICKUP with shipping_details present → address fields still null", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;
    const shippingDetails = {
      address: { line1: "123 Main St", city: "Sydney", state: "NSW", postal_code: "2000", country: "AU" },
      name: "Pickup Buyer",
    };

    await post(pickupEvent(sessionId, artworkId, tenantId, { shippingDetails }));

    const order = await orderBySession(sessionId);
    // PICKUP fulfillment → address fields not copied even if shipping_details is present.
    expect(order?.fulfillmentType).toBe("PICKUP");
    expect(order?.buyerAddress ?? null).toBeNull();
    expect(order?.buyerCity ?? null).toBeNull();
  });
});
