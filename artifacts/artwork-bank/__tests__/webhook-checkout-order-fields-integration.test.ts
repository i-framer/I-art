/**
 * checkout.session.completed order financial/customer field persistence — real-DB integration.
 *
 * app/api/stripe/webhook/route.ts:681-710:
 *   ordersTable.totalCents   ← session.amount_total
 *   ordersTable.buyerName    ← customer_details.name
 *   ordersTable.buyerEmail   ← customer_details.email
 *
 *  1. totalCents persists from session.amount_total.
 *  2. buyerName persists from customer_details.name.
 *  3. buyerEmail persists from customer_details.email.
 *  4. totalCents and buyerName are independent between two orders.
 *  5. buyerEmail is lowercased/stored as-is (no silent transform).
 *  6. Duplicate session redelivery does not change totalCents of first order.
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

function uid() { return `${randomUUID()}-wcofi-${RUN}-${++seq}`; }

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
    id, slug: id, businessName: "Order Fields Gallery",
    type: "ARTIST", billingExempt: true,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Order Fields Art", sku: `sku-${id}`,
    status: "RESERVED", price: 45000,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

function checkoutEvent(opts: {
  sessionId: string;
  artworkId: string;
  tenantId: string;
  amountTotal: number;
  buyerName: string;
  buyerEmail: string;
}) {
  return {
    type: "checkout.session.completed",
    id: `evt_${uid()}`,
    data: {
      object: {
        id: opts.sessionId,
        payment_status: "paid",
        amount_total: opts.amountTotal,
        payment_intent: `pi_${uid()}`,
        customer_details: { email: opts.buyerEmail, name: opts.buyerName },
        metadata: {
          artworkId: opts.artworkId,
          tenantId: opts.tenantId,
          fulfillmentType: "PICKUP",
        },
      },
    },
  };
}

async function orderBySession(sessionId: string) {
  return db.query.ordersTable.findFirst({ where: eq(ordersTable.stripeSessionId, sessionId) });
}

async function cleanup() {
  for (const artworkId of createdArtworkIds) {
    const items = await db.query.orderItemsTable.findMany({
      where: eq(orderItemsTable.artworkId, artworkId),
    });
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

describeIntegration("Webhook order financial/customer fields — real-DB integration", () => {
  it("totalCents persists from session.amount_total", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    await post(checkoutEvent({
      sessionId, artworkId, tenantId,
      amountTotal: 45000, buyerName: "Test Buyer", buyerEmail: "buyer@test.com",
    }));

    const order = await orderBySession(sessionId);
    expect(order?.totalCents).toBe(45000);
  });

  it("buyerName persists from customer_details.name", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    await post(checkoutEvent({
      sessionId, artworkId, tenantId,
      amountTotal: 45000, buyerName: "Jane Smith", buyerEmail: "jane@test.com",
    }));

    const order = await orderBySession(sessionId);
    expect(order?.buyerName).toBe("Jane Smith");
  });

  it("buyerEmail persists from customer_details.email", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;
    const email = `jane-${uid()}@example.com`;

    await post(checkoutEvent({
      sessionId, artworkId, tenantId,
      amountTotal: 45000, buyerName: "Jane Smith", buyerEmail: email,
    }));

    const order = await orderBySession(sessionId);
    expect(order?.buyerEmail).toBe(email);
  });

  it("totalCents and buyerName are independent between two orders", async () => {
    const tenantId   = await createTenant();
    const artwork1   = await createArtwork(tenantId);
    const artwork2   = await createArtwork(tenantId);
    const session1   = `cs_test_${uid()}`;
    const session2   = `cs_test_${uid()}`;

    await post(checkoutEvent({ sessionId: session1, artworkId: artwork1, tenantId, amountTotal: 10000, buyerName: "Alice", buyerEmail: "alice@test.com" }));
    await post(checkoutEvent({ sessionId: session2, artworkId: artwork2, tenantId, amountTotal: 20000, buyerName: "Bob",   buyerEmail: "bob@test.com"   }));

    const order1 = await orderBySession(session1);
    const order2 = await orderBySession(session2);
    expect(order1?.totalCents).toBe(10000);
    expect(order1?.buyerName).toBe("Alice");
    expect(order2?.totalCents).toBe(20000);
    expect(order2?.buyerName).toBe("Bob");
  });

  it("duplicate session redelivery does not change totalCents of first order", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    await post(checkoutEvent({ sessionId, artworkId, tenantId, amountTotal: 45000, buyerName: "Original Buyer", buyerEmail: "orig@test.com" }));
    await post(checkoutEvent({ sessionId, artworkId, tenantId, amountTotal: 99999, buyerName: "Retry Buyer",    buyerEmail: "retry@test.com"  })); // duplicate

    const order = await orderBySession(sessionId);
    expect(order?.totalCents).toBe(45000); // first delivery wins
    expect(order?.buyerName).toBe("Original Buyer");
  });

  it("order status is PAID after successful checkout", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    const res = await post(checkoutEvent({ sessionId, artworkId, tenantId, amountTotal: 45000, buyerName: "Status Buyer", buyerEmail: "status@test.com" }));
    expect(res.status).toBe(200);

    const order = await orderBySession(sessionId);
    expect(order?.status).toBe("PAID");
  });
});
