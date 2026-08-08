/**
 * checkout.session.completed — order confirmation emailSentAt/emailError
 * persistence — real-DB integration.
 *
 * app/api/stripe/webhook/route.ts:~744-762:
 *   On email success: emailSentAt = now, emailError = null, emailLastAttemptAt = now.
 *   On email failure: emailError = message, emailLastAttemptAt = now, emailSentAt unchanged.
 *
 *  1. emailSentAt is set to a recent timestamp after a successful send.
 *  2. emailError is null after a successful send.
 *  3. emailLastAttemptAt is set after a successful send.
 *  4. emailError is persisted when sendOrderConfirmation throws.
 *  5. emailSentAt is NOT set when sendOrderConfirmation throws.
 *  6. emailLastAttemptAt is set even on email failure.
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

function uid() { return `${randomUUID()}-wceci-${RUN}-${++seq}`; }

const mockSendOrderConfirmation = vi.fn();

vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(),
  getStripeWebhookSecret: vi.fn().mockResolvedValue(null),
  calcApplicationFee: (cents: number) => Math.round(cents * 0.05),
  StripeNotConfiguredError: class extends Error {},
}));
vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: (...args: any[]) => mockSendOrderConfirmation(...args),
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
    id, slug: id, businessName: "Email Confirm Test Gallery",
    type: "ARTIST", billingExempt: true,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Confirm Email Art", sku: `sku-${id}`,
    status: "RESERVED", price: 20000,
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
        amount_total: 20000,
        payment_intent: `pi_${uid()}`,
        customer_details: { email: `buyer-${uid()}@test.com`, name: "Email Buyer" },
        metadata: { artworkId, tenantId, fulfillmentType: "PICKUP" },
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

afterEach(async () => {
  mockSendOrderConfirmation.mockReset();
  await cleanup();
});
afterAll(cleanup);

const RECENT_MS = 10_000;

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Checkout confirmation email persistence — real-DB integration", () => {
  it("emailSentAt is set to a recent timestamp after a successful send", async () => {
    mockSendOrderConfirmation.mockResolvedValue(true);
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;
    const before = Date.now();

    await post(checkoutEvent(sessionId, artworkId, tenantId));

    const order = await orderBySession(sessionId);
    expect(order?.emailSentAt).not.toBeNull();
    expect(order!.emailSentAt!.getTime()).toBeGreaterThanOrEqual(before - RECENT_MS);
  });

  it("emailError is null after a successful send", async () => {
    mockSendOrderConfirmation.mockResolvedValue(true);
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    await post(checkoutEvent(sessionId, artworkId, tenantId));

    const order = await orderBySession(sessionId);
    expect(order?.emailError).toBeNull();
  });

  it("emailLastAttemptAt is set after a successful send", async () => {
    mockSendOrderConfirmation.mockResolvedValue(true);
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;
    const before = Date.now();

    await post(checkoutEvent(sessionId, artworkId, tenantId));

    const order = await orderBySession(sessionId);
    expect(order?.emailLastAttemptAt).not.toBeNull();
    expect(order!.emailLastAttemptAt!.getTime()).toBeGreaterThanOrEqual(before - RECENT_MS);
  });

  it("emailError is persisted when sendOrderConfirmation throws", async () => {
    mockSendOrderConfirmation.mockRejectedValue(new Error("SMTP connection refused"));
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    const res = await post(checkoutEvent(sessionId, artworkId, tenantId));
    expect(res.status).toBe(200); // webhook still returns 200

    const order = await orderBySession(sessionId);
    expect(order?.emailError).toContain("SMTP connection refused");
  });

  it("emailSentAt is NOT set when sendOrderConfirmation throws", async () => {
    mockSendOrderConfirmation.mockRejectedValue(new Error("SMTP unavailable"));
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    await post(checkoutEvent(sessionId, artworkId, tenantId));

    const order = await orderBySession(sessionId);
    expect(order?.emailSentAt).toBeNull();
  });

  it("emailLastAttemptAt is set even on email failure", async () => {
    mockSendOrderConfirmation.mockRejectedValue(new Error("Timeout"));
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;
    const before = Date.now();

    await post(checkoutEvent(sessionId, artworkId, tenantId));

    const order = await orderBySession(sessionId);
    expect(order?.emailLastAttemptAt).not.toBeNull();
    expect(order!.emailLastAttemptAt!.getTime()).toBeGreaterThanOrEqual(before - RECENT_MS);
  });
});
