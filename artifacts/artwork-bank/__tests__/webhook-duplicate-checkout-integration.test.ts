/**
 * Duplicate checkout.session.completed webhook — real-DB integration.
 *
 * app/api/stripe/webhook/route.ts: the handler guards against duplicate
 * delivery by checking `ordersTable.stripeSessionId` before any writes.
 * If a row already exists for that session, the handler returns 200 without
 * creating another order, changing the artwork status, or writing another
 * order item.
 *
 *  1. First delivery creates exactly one order row.
 *  2. Second delivery with the same sessionId returns 200.
 *  3. Second delivery does NOT create a second order row.
 *  4. Artwork status stays SOLD after both deliveries (no double-write).
 *  5. orderItemsTable has exactly one row after both deliveries.
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

function uid() { return `${randomUUID()}-wdci-${RUN}-${++seq}`; }

const mockSendGalleryNewOrderNotification = vi.hoisted(() => vi.fn());

vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(),
  getStripeWebhookSecret: vi.fn().mockResolvedValue(null), // dev-bypass
  calcApplicationFee: (cents: number) => Math.round(cents * 0.05),
  StripeNotConfiguredError: class extends Error {},
}));
vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: vi.fn(async () => true),
  sendGalleryNewOrderNotification: (...args: any[]) =>
    mockSendGalleryNewOrderNotification(...args),
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

async function createTenant(contactEmail = "orders@duplicate-gallery.example") {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Duplicate Checkout Gallery",
    type: "ARTIST", billingExempt: true, contactEmail,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Duplicate Checkout Art", sku: `sku-${id}`,
    status: "RESERVED", price: 40000,
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
        amount_total: 40000,
        payment_intent: `pi_${uid()}`,
        customer_details: { email: `buyer-${uid()}@test.com`, name: "Dup Buyer" },
        metadata: { artworkId, tenantId, fulfillmentType: "PICKUP" },
      },
    },
  };
}

async function ordersForSession(sessionId: string) {
  return db.query.ordersTable.findMany({ where: eq(ordersTable.stripeSessionId, sessionId) });
}

async function itemsForArtwork(artworkId: string) {
  return db.query.orderItemsTable.findMany({ where: eq(orderItemsTable.artworkId, artworkId) });
}

async function cleanup() {
  for (const id of createdOrderIds.splice(0)) {
    await db.delete(orderItemsTable).where(eq(orderItemsTable.orderId, id)).catch(() => {});
    await db.delete(ordersTable).where(eq(ordersTable.id, id)).catch(() => {});
  }
  // Also clean orders created by webhook (not tracked by id).
  for (const artworkId of [...createdArtworkIds]) {
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
  mockSendGalleryNewOrderNotification.mockReset();
  await cleanup();
});
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Duplicate checkout.session.completed webhook — real-DB integration", () => {
  it("first delivery creates exactly one order row", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    const res = await post(checkoutEvent(sessionId, artworkId, tenantId));
    expect(res.status).toBe(200);

    const orders = await ordersForSession(sessionId);
    expect(orders).toHaveLength(1);
  });

  it("second delivery with same sessionId returns 200", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    await post(checkoutEvent(sessionId, artworkId, tenantId));
    const res2 = await post(checkoutEvent(sessionId, artworkId, tenantId));

    expect(res2.status).toBe(200);
  });

  it("second delivery does NOT create a second order row", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    await post(checkoutEvent(sessionId, artworkId, tenantId));
    await post(checkoutEvent(sessionId, artworkId, tenantId));

    const orders = await ordersForSession(sessionId);
    expect(orders).toHaveLength(1);
  });

  it("artwork status stays SOLD after both deliveries (no double-write)", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    await post(checkoutEvent(sessionId, artworkId, tenantId));
    await post(checkoutEvent(sessionId, artworkId, tenantId));

    const artwork = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, artworkId) });
    expect(artwork?.status).toBe("SOLD");
  });

  it("orderItemsTable has exactly one row after both deliveries", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    await post(checkoutEvent(sessionId, artworkId, tenantId));
    await post(checkoutEvent(sessionId, artworkId, tenantId));

    const items = await itemsForArtwork(artworkId);
    expect(items).toHaveLength(1);
  });

  it("sends one tenant-scoped gallery notification across webhook replay", async () => {
    const galleryEmail = `orders-${uid()}@gallery.test`;
    const otherGalleryEmail = `orders-${uid()}@other-gallery.test`;
    const tenantId = await createTenant(galleryEmail);
    await createTenant(otherGalleryEmail);
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;
    const event = checkoutEvent(sessionId, artworkId, tenantId);

    await post(event);
    await post(event);

    expect(mockSendGalleryNewOrderNotification).toHaveBeenCalledOnce();
    expect(mockSendGalleryNewOrderNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        galleryEmail,
        artworkTitle: "Duplicate Checkout Art",
        orderRef: expect.any(String),
      }),
    );
    expect(mockSendGalleryNewOrderNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ galleryEmail: otherGalleryEmail }),
    );

    const [order] = await ordersForSession(sessionId);
    expect(order?.galleryOrderEmailSentAt).toBeInstanceOf(Date);
    expect(order?.galleryOrderEmailError).toBeNull();
    expect(order?.galleryOrderEmailAttempts).toBe(1);
    expect(order?.galleryOrderEmailLastAttemptAt).toBeInstanceOf(Date);
  });

  it("records gallery delivery failure without failing the webhook", async () => {
    mockSendGalleryNewOrderNotification.mockRejectedValueOnce(
      new Error("SMTP gallery delivery failed"),
    );
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    const event = checkoutEvent(sessionId, artworkId, tenantId);
    const response = await post(event);
    const replayResponse = await post(event);

    expect(response.status).toBe(200);
    expect(replayResponse.status).toBe(200);
    expect(mockSendGalleryNewOrderNotification).toHaveBeenCalledOnce();
    const [order] = await ordersForSession(sessionId);
    expect(order?.galleryOrderEmailSentAt).toBeNull();
    expect(order?.galleryOrderEmailError).toContain(
      "SMTP gallery delivery failed",
    );
    expect(order?.galleryOrderEmailAttempts).toBe(1);
    expect(order?.galleryOrderEmailLastAttemptAt).toBeInstanceOf(Date);
  });
});
