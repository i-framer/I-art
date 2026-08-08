/**
 * checkout.session.expired — SHIP fulfillment — RESERVED→AVAILABLE restore — real-DB integration.
 *
 * Existing checkout-session-expired-integration.test.ts only uses PICKUP fixtures.
 * This suite adds SHIP-specific coverage.
 *
 * app/api/stripe/webhook/route.ts: on checkout.session.expired, release
 * RESERVED artwork back to AVAILABLE (regardless of fulfillmentType).
 *
 *  1. SHIP RESERVED artwork reverts to AVAILABLE on session expired.
 *  2. Paid SHIP order is NOT reverted (protected from release).
 *  3. SHIP expiry does not affect a PICKUP artwork in the same tenant.
 *  4. Cross-tenant: SHIP expiry for tenant B does not release tenant A artwork.
 *  5. SHIP artwork already AVAILABLE when session expires — no error.
 *  6. SHIP + FRAMING_JOB — both revert RESERVED to AVAILABLE on expiry.
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
const createdOrderIds: string[] = [];
const createdItemIds: string[] = [];

function uid() { return `${randomUUID()}-csesi-${RUN}-${++seq}`; }

vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(),
  getStripeWebhookSecret: vi.fn().mockResolvedValue(null),
  calcApplicationFee: vi.fn(),
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
    id, slug: id, businessName: "SHIP Expired Test", type: "ARTIST", billingExempt: true,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string, status: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "SHIP Expired Art", sku: `sku-${id}`,
    status, price: 25000, showInGallery: true,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createPaidOrder(tenantId: string, artworkId: string, sessionId: string) {
  const orderId = uid();
  await db.insert(ordersTable).values({
    id: orderId, tenantId, status: "PAID",
    totalCents: 25000, buyerEmail: `buyer-${orderId}@test.com`,
    buyerName: "Paid Buyer", fulfillmentType: "SHIP",
    stripeSessionId: sessionId,
  } as any);
  createdOrderIds.push(orderId);
  const itemId = uid();
  await db.insert(orderItemsTable).values({
    id: itemId, orderId, artworkId, tenantId,
    artworkTitle: "SHIP Expired Art", priceCents: 25000,
  } as any);
  createdItemIds.push(itemId);
  return orderId;
}

function expiredEvent(sessionId: string, artworkId: string, tenantId: string, fulfillmentType = "SHIP") {
  return {
    type: "checkout.session.expired",
    id: `evt_${uid()}`,
    data: {
      object: {
        id: sessionId,
        metadata: { artworkId, tenantId, fulfillmentType },
      },
    },
  };
}

async function artworkStatus(artworkId: string) {
  return (await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, artworkId) }))?.status;
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

describeIntegration("checkout.session.expired SHIP fulfillment — real-DB integration", () => {
  it("SHIP RESERVED artwork reverts to AVAILABLE on session expired", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId, "RESERVED");
    const sessionId = `cs_test_${uid()}`;

    const res = await post(expiredEvent(sessionId, artworkId, tenantId, "SHIP"));
    expect(res.status).toBe(200);

    expect(await artworkStatus(artworkId)).toBe("AVAILABLE");
  });

  it("paid SHIP order protects artwork from RESERVED release on expiry", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId, "RESERVED");
    const sessionId = `cs_test_${uid()}`;
    await createPaidOrder(tenantId, artworkId, sessionId);

    await post(expiredEvent(sessionId, artworkId, tenantId, "SHIP"));

    // Paid order guard — artwork should NOT be set back to AVAILABLE.
    expect(await artworkStatus(artworkId)).toBe("RESERVED");
  });

  it("SHIP expiry does not affect a PICKUP artwork in the same tenant", async () => {
    const tenantId       = await createTenant();
    const shipArtwork    = await createArtwork(tenantId, "RESERVED");
    const pickupArtwork  = await createArtwork(tenantId, "RESERVED");
    const shipSession    = `cs_test_${uid()}`;

    await post(expiredEvent(shipSession, shipArtwork, tenantId, "SHIP"));

    expect(await artworkStatus(shipArtwork)).toBe("AVAILABLE");
    expect(await artworkStatus(pickupArtwork)).toBe("RESERVED"); // untouched
  });

  it("cross-tenant: SHIP expiry for tenant B does not release tenant A artwork", async () => {
    const tenantA   = await createTenant();
    const tenantB   = await createTenant();
    const artworkA  = await createArtwork(tenantA, "RESERVED");
    const sessionId = `cs_test_${uid()}`;

    await post(expiredEvent(sessionId, artworkA, tenantB, "SHIP"));

    expect(await artworkStatus(artworkA)).toBe("RESERVED"); // different tenant — untouched
  });

  it("SHIP artwork already AVAILABLE when session expires — no error (200 returned)", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId, "AVAILABLE");
    const sessionId = `cs_test_${uid()}`;

    const res = await post(expiredEvent(sessionId, artworkId, tenantId, "SHIP"));

    expect(res.status).toBe(200);
    expect(await artworkStatus(artworkId)).toBe("AVAILABLE");
  });

  it("FRAMING_JOB fulfillment also reverts RESERVED to AVAILABLE on expiry", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId, "RESERVED");
    const sessionId = `cs_test_${uid()}`;

    await post(expiredEvent(sessionId, artworkId, tenantId, "FRAMING_JOB"));

    expect(await artworkStatus(artworkId)).toBe("AVAILABLE");
  });
});
