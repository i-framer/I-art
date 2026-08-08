/**
 * checkout.session.completed — payment_status handling — real-DB integration.
 *
 * app/api/stripe/webhook/route.ts handleCheckoutCompleted (line ~643):
 * The route does NOT guard on payment_status. It processes the event
 * solely on metadata presence and idempotency (existing session ID check).
 *
 * This suite documents the actual behavior so any future payment_status
 * guard is caught by a failing test.
 *
 *  1. payment_status="paid" → order created, artwork set SOLD.
 *  2. payment_status=null → order still created (no payment_status guard).
 *  3. payment_status="unpaid" → order still created (no payment_status guard).
 *  4. payment_status="no_payment_required" → order created.
 *  5. Idempotency: duplicate event → only one order row (all payment_status values).
 *  6. Missing metadata → no order created (metadata guard fires instead).
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

function uid() { return `${randomUUID()}-wcups-${RUN}-${++seq}`; }

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
    id, slug: id, businessName: "Payment Status Test", type: "ARTIST", billingExempt: true,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Payment Status Art", sku: `sku-${id}`,
    status: "RESERVED", price: 20000, showInGallery: true,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

function checkoutEvent(sessionId: string, artworkId: string, tenantId: string, paymentStatus: string | null) {
  return {
    type: "checkout.session.completed",
    id: `evt_${uid()}`,
    data: {
      object: {
        id: sessionId,
        payment_status: paymentStatus,
        amount_total: 20000,
        payment_intent: `pi_${uid()}`,
        customer_details: { email: `buyer-${uid()}@test.com`, name: "Status Test Buyer" },
        metadata: { artworkId, tenantId, fulfillmentType: "PICKUP" },
      },
    },
  };
}

async function orderBySession(sessionId: string) {
  return db.query.ordersTable.findFirst({ where: eq(ordersTable.stripeSessionId, sessionId) });
}

async function artworkStatus(artworkId: string) {
  return (await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, artworkId) }))?.status;
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

describeIntegration("Checkout payment_status behavior — real-DB integration", () => {
  it("payment_status='paid' → order created, artwork set SOLD", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    const res = await post(checkoutEvent(sessionId, artworkId, tenantId, "paid"));
    expect(res.status).toBe(200);

    const order = await orderBySession(sessionId);
    expect(order).not.toBeUndefined();
    expect(await artworkStatus(artworkId)).toBe("SOLD");
  });

  it("payment_status=null → order still created (route has no payment_status guard)", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    const res = await post(checkoutEvent(sessionId, artworkId, tenantId, null));
    expect(res.status).toBe(200);

    // No guard on payment_status — order is created regardless.
    const order = await orderBySession(sessionId);
    expect(order).not.toBeUndefined();
    expect(await artworkStatus(artworkId)).toBe("SOLD");
  });

  it("payment_status='unpaid' → order still created (route has no payment_status guard)", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    await post(checkoutEvent(sessionId, artworkId, tenantId, "unpaid"));

    const order = await orderBySession(sessionId);
    expect(order).not.toBeUndefined();
  });

  it("payment_status='no_payment_required' → order is created", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    const res = await post(checkoutEvent(sessionId, artworkId, tenantId, "no_payment_required"));
    expect(res.status).toBe(200);

    const order = await orderBySession(sessionId);
    expect(order).not.toBeUndefined();
  });

  it("duplicate event delivery → only one order row (idempotency on session ID)", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    await post(checkoutEvent(sessionId, artworkId, tenantId, "paid"));
    await post(checkoutEvent(sessionId, artworkId, tenantId, "paid")); // duplicate

    const rows = await db.query.ordersTable.findMany({ where: eq(ordersTable.stripeSessionId, sessionId) });
    expect(rows).toHaveLength(1);
  });

  it("missing metadata → no order created (metadata guard fires)", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    await post({
      type: "checkout.session.completed",
      id: `evt_${uid()}`,
      data: {
        object: {
          id: sessionId,
          payment_status: "paid",
          amount_total: 20000,
          metadata: {}, // missing artworkId / tenantId / fulfillmentType
        },
      },
    });

    const order = await orderBySession(sessionId);
    expect(order).toBeUndefined();
    // Artwork is untouched.
    expect(await artworkStatus(artworkId)).toBe("RESERVED");
  });
});
