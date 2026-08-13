/**
 * Stripe webhook — checkout.session.completed (artwork purchase) — real-DB integration.
 *
 * Uses STRIPE_WEBHOOK_DEV_BYPASS=true so the route accepts raw JSON bodies in
 * non-production environments (no Stripe signature required). All DB
 * side-effects (order creation, order item, artwork→SOLD, email flags) are
 * exercised against real PostgreSQL.
 *
 *  1. Valid checkout event → order row inserted, order item inserted, artwork→SOLD.
 *  2. Confirmation email success → emailSentAt set; emailError NULL.
 *  3. Confirmation email failure → emailSentAt NULL; emailError + emailAttempts=1.
 *  4. Duplicate event (same stripeSessionId) → idempotent; one order row only.
 *  5. Missing metadata → early return; no rows inserted.
 *  6. Artwork tenant mismatch → early return; no order inserted.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  ordersTable,
  orderItemsTable,
  stripeAlertsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// Enable dev bypass so the route parses the body directly (no Stripe sig check).
vi.stubEnv("STRIPE_WEBHOOK_DEV_BYPASS", "true");

// ── Email — controlled per-test ───────────────────────────────────────────────
const sendOrderConfirmation = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return { ...actual, sendOrderConfirmation, sendBillingAlertNotification: vi.fn() };
});
vi.mock("@/lib/slack", () => ({
  sendBillingAlertSlackNotification: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/base-url", () => ({
  getTenantUrl: vi.fn(() => "https://gallery.test/orders"),
}));
vi.mock("@/lib/iframer", () => ({
  createIFramerJob: vi.fn(async () => ({ ok: true })),
  IFramerError: class IFramerError extends Error {},
}));
// next/headers must be mocked — the route calls headers() server-side.
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (_key: string) => null, // no stripe-signature header → dev-bypass path
  })),
}));

import { POST } from "@/app/api/stripe/webhook/route";

// ── DB helpers ────────────────────────────────────────────────────────────────
const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdOrderIds: string[] = [];
const createdAlertEventIds: string[] = [];

function uid() { return `${randomUUID()}-wh-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Webhook Test Gallery",
    type: "ARTIST", billingExempt: true,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string, status = "AVAILABLE") {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Webhook Test Artwork", sku: `sku-${id}`,
    status, price: 50000,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function cleanup() {
  for (const id of createdOrderIds.splice(0)) {
    await db.delete(orderItemsTable).where(eq(orderItemsTable.orderId, id)).catch(() => {});
    await db.delete(ordersTable).where(eq(ordersTable.id, id)).catch(() => {});
  }
  for (const id of createdArtworkIds.splice(0)) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
  for (const eventId of createdAlertEventIds.splice(0)) {
    await db.delete(stripeAlertsTable).where(eq(stripeAlertsTable.stripeEventId, eventId)).catch(() => {});
  }
}

function checkoutEvent(
  sessionId: string,
  artworkId: string,
  tenantId: string,
  opts: { buyerEmail?: string; buyerName?: string } = {},
) {
  return {
    id: `evt-${sessionId}`,
    type: "checkout.session.completed",
    data: {
      object: {
        id: sessionId,
        mode: "payment",
        payment_intent: `pi-${sessionId}`,
        amount_total: 50000,
        metadata: { artworkId, tenantId, fulfillmentType: "PICKUP" },
        customer_details: {
          email: opts.buyerEmail ?? "buyer@example.com",
          name: opts.buyerName ?? "Test Buyer",
        },
      },
    },
  };
}

function makeRequest(event: object): Request {
  return new Request("http://localhost/api/stripe/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });
}

afterEach(async () => {
  sendOrderConfirmation.mockReset();
  await cleanup();
});
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Stripe webhook — checkout.session.completed — real-DB integration", () => {
  it("valid checkout event → order row + order item inserted; artwork becomes SOLD", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId, "AVAILABLE");
    const sessionId = `cs_test_${uid()}`;

    const res = await POST(makeRequest(checkoutEvent(sessionId, artworkId, tenantId)));
    expect(res.status).toBe(200);

    const order = await db.query.ordersTable.findFirst({
      where: eq(ordersTable.stripeSessionId, sessionId),
    });
    expect(order).toBeDefined();
    expect(order?.status).toBe("PAID");
    expect(order?.tenantId).toBe(tenantId);
    if (order) createdOrderIds.push(order.id);

    const item = order
      ? await db.query.orderItemsTable.findFirst({ where: eq(orderItemsTable.orderId, order.id) })
      : null;
    expect(item?.artworkId).toBe(artworkId);

    const art = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, artworkId) });
    expect(art?.status).toBe("SOLD");
  });

  it("confirmation email success → emailSentAt set; emailError NULL", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    await POST(makeRequest(checkoutEvent(sessionId, artworkId, tenantId)));

    const order = await db.query.ordersTable.findFirst({
      where: eq(ordersTable.stripeSessionId, sessionId),
    });
    if (order) createdOrderIds.push(order.id);

    expect(sendOrderConfirmation).toHaveBeenCalledOnce();
    expect(order?.emailSentAt).toBeInstanceOf(Date);
    expect(order?.emailError).toBeNull();
  });

  it("confirmation email failure → emailSentAt NULL; emailError + emailAttempts=1", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    sendOrderConfirmation.mockRejectedValueOnce(new Error("SMTP error"));

    const res = await POST(makeRequest(checkoutEvent(sessionId, artworkId, tenantId)));
    expect(res.status).toBe(200); // email failure is non-fatal

    const order = await db.query.ordersTable.findFirst({
      where: eq(ordersTable.stripeSessionId, sessionId),
    });
    if (order) createdOrderIds.push(order.id);

    expect(order?.emailSentAt).toBeNull();
    expect(order?.emailAttempts).toBe(1);
    expect(order?.emailError).toMatch(/SMTP error/);
  });

  it("duplicate event (same stripeSessionId) → idempotent; one order row only", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;
    const event = checkoutEvent(sessionId, artworkId, tenantId);

    await POST(makeRequest(event));
    await POST(makeRequest(event)); // second call — should be a no-op

    const orders = await db.select({ id: ordersTable.id })
      .from(ordersTable)
      .where(eq(ordersTable.stripeSessionId, sessionId));
    expect(orders).toHaveLength(1);
    if (orders[0]) createdOrderIds.push(orders[0].id);
  });

  it("missing metadata → early return; no order inserted; durable alert created", async () => {
    const tenantId = await createTenant();
    const sessionId = `cs_test_${uid()}`;
    const eventId = `evt-${sessionId}`;
    createdAlertEventIds.push(eventId);
    const noMetaEvent = {
      id: eventId,
      type: "checkout.session.completed",
      data: {
        object: {
          id: sessionId, mode: "payment", amount_total: 50000,
          metadata: {}, // no artworkId/tenantId/fulfillmentType
          customer_details: { email: "buyer@example.com", name: "Test Buyer" },
        },
      },
    };

    const res = await POST(makeRequest(noMetaEvent));
    expect(res.status).toBe(200);

    // No order must be created.
    const orders = await db.select({ id: ordersTable.id })
      .from(ordersTable)
      .where(eq(ordersTable.tenantId, tenantId));
    expect(orders).toHaveLength(0);

    // A durable alert row must exist so the paid session is never silent.
    const alert = await db.query.stripeAlertsTable.findFirst({
      where: eq(stripeAlertsTable.stripeEventId, eventId),
    });
    expect(alert).toBeDefined();
    expect(alert?.eventType).toBe("checkout.session.completed");
    expect(alert?.reason).toMatch(/missing required metadata/);
    expect(alert?.reason).toMatch(sessionId);
  });

  it("artwork tenant mismatch → early return; no order inserted; durable alert created", async () => {
    const tenantA = await createTenant();
    const tenantB = await createTenant();
    const artworkId = await createArtwork(tenantA); // belongs to tenantA
    const sessionId = `cs_test_${uid()}`;
    const eventId = `evt-${sessionId}`;
    createdAlertEventIds.push(eventId);
    // Event claims artwork belongs to tenantB — integrity check should reject it.
    const event = { ...checkoutEvent(sessionId, artworkId, tenantB), id: eventId };

    const res = await POST(makeRequest(event));
    expect(res.status).toBe(200);

    // No order must be created.
    const orders = await db.select({ id: ordersTable.id })
      .from(ordersTable)
      .where(eq(ordersTable.stripeSessionId, sessionId));
    expect(orders).toHaveLength(0);

    // A durable alert row must exist so the paid session is never silent.
    const alert = await db.query.stripeAlertsTable.findFirst({
      where: eq(stripeAlertsTable.stripeEventId, eventId),
    });
    expect(alert).toBeDefined();
    expect(alert?.eventType).toBe("checkout.session.completed");
    expect(alert?.reason).toMatch(/artwork not found or tenant mismatch/);
    expect(alert?.reason).toMatch(artworkId);
    expect(alert?.reason).toMatch(sessionId);
  });

  it("missing artworkId only → no order; durable alert with artworkId=(missing)", async () => {
    const tenantId = await createTenant();
    const sessionId = `cs_test_${uid()}`;
    const eventId = `evt-${sessionId}`;
    createdAlertEventIds.push(eventId);
    const event = {
      id: eventId,
      type: "checkout.session.completed",
      data: {
        object: {
          id: sessionId, mode: "payment", amount_total: 50000,
          metadata: { tenantId, fulfillmentType: "PICKUP" }, // artworkId absent
          customer_details: { email: "buyer@example.com", name: "Test Buyer" },
        },
      },
    };

    const res = await POST(makeRequest(event));
    expect(res.status).toBe(200);

    const orders = await db.select({ id: ordersTable.id })
      .from(ordersTable).where(eq(ordersTable.stripeSessionId, sessionId));
    expect(orders).toHaveLength(0);

    const alert = await db.query.stripeAlertsTable.findFirst({
      where: eq(stripeAlertsTable.stripeEventId, eventId),
    });
    expect(alert).toBeDefined();
    expect(alert?.reason).toMatch(/artworkId=\(missing\)/);
  });

  it("missing tenantId only → no order; durable alert with tenantId=(missing)", async () => {
    const artworkId = await createArtwork(await createTenant());
    const sessionId = `cs_test_${uid()}`;
    const eventId = `evt-${sessionId}`;
    createdAlertEventIds.push(eventId);
    const event = {
      id: eventId,
      type: "checkout.session.completed",
      data: {
        object: {
          id: sessionId, mode: "payment", amount_total: 50000,
          metadata: { artworkId, fulfillmentType: "PICKUP" }, // tenantId absent
          customer_details: { email: "buyer@example.com", name: "Test Buyer" },
        },
      },
    };

    const res = await POST(makeRequest(event));
    expect(res.status).toBe(200);

    const orders = await db.select({ id: ordersTable.id })
      .from(ordersTable).where(eq(ordersTable.stripeSessionId, sessionId));
    expect(orders).toHaveLength(0);

    const alert = await db.query.stripeAlertsTable.findFirst({
      where: eq(stripeAlertsTable.stripeEventId, eventId),
    });
    expect(alert).toBeDefined();
    expect(alert?.reason).toMatch(/tenantId=\(missing\)/);
  });

  it("missing fulfillmentType only → no order; durable alert with fulfillmentType=(missing)", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;
    const eventId = `evt-${sessionId}`;
    createdAlertEventIds.push(eventId);
    const event = {
      id: eventId,
      type: "checkout.session.completed",
      data: {
        object: {
          id: sessionId, mode: "payment", amount_total: 50000,
          metadata: { artworkId, tenantId }, // fulfillmentType absent
          customer_details: { email: "buyer@example.com", name: "Test Buyer" },
        },
      },
    };

    const res = await POST(makeRequest(event));
    expect(res.status).toBe(200);

    const orders = await db.select({ id: ordersTable.id })
      .from(ordersTable).where(eq(ordersTable.stripeSessionId, sessionId));
    expect(orders).toHaveLength(0);

    const alert = await db.query.stripeAlertsTable.findFirst({
      where: eq(stripeAlertsTable.stripeEventId, eventId),
    });
    expect(alert).toBeDefined();
    expect(alert?.reason).toMatch(/fulfillmentType=\(missing\)/);
  });

  it("duplicate invalid event → idempotent; only one alert row created", async () => {
    const sessionId = `cs_test_${uid()}`;
    const eventId = `evt-${sessionId}`;
    createdAlertEventIds.push(eventId);
    const event = {
      id: eventId,
      type: "checkout.session.completed",
      data: {
        object: {
          id: sessionId, mode: "payment", amount_total: 50000,
          metadata: {}, // all missing
          customer_details: { email: "buyer@example.com" },
        },
      },
    };

    await POST(makeRequest(event));
    await POST(makeRequest(event)); // second delivery — Stripe retry simulation

    const alerts = await db.select({ id: stripeAlertsTable.id })
      .from(stripeAlertsTable)
      .where(eq(stripeAlertsTable.stripeEventId, eventId));
    expect(alerts).toHaveLength(1); // onConflictDoNothing deduplicates
  });
});
