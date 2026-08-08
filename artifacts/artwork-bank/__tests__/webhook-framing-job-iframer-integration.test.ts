/**
 * FRAMING_JOB checkout — iFramer job creation via webhook — real-DB integration.
 *
 * app/api/stripe/webhook/route.ts:createIFramerJobForOrder:
 *   When fulfillmentType=FRAMING_JOB and tenant.iframerAccountId is set:
 *     Success: order.iframerJobId = result.jobId, iframerJobError = null.
 *     Failure: order.iframerJobError = message, iframerJobId unchanged.
 *   PICKUP orders never call createIFramerJob.
 *   Tenant without iframerAccountId skips job creation even for FRAMING_JOB.
 *
 *  1. FRAMING_JOB with iframerAccountId → iframerJobId persisted.
 *  2. FRAMING_JOB with iframerAccountId → iframerJobError = null on success.
 *  3. iFramer failure → iframerJobError persisted.
 *  4. PICKUP order never sets iframerJobId.
 *  5. FRAMING_JOB without iframerAccountId → iframerJobId stays null.
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

function uid() { return `${randomUUID()}-wfjii-${RUN}-${++seq}`; }

// Module-level mock that we can reconfigure per test.
const mockCreateIFramerJob = vi.fn();

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

async function createTenant(iframerAccountId?: string) {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Framing Job Test Gallery",
    type: "FRAMER", billingExempt: true,
    ...(iframerAccountId ? { iframerAccountId } : {}),
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Frame Me Art", sku: `sku-${id}`,
    status: "RESERVED", price: 50000,
    dimensionsW: 600, dimensionsH: 900,
    condition: "EXCELLENT",
  } as any);
  createdArtworkIds.push(id);
  return id;
}

function checkoutEvent(sessionId: string, artworkId: string, tenantId: string, fulfillmentType: string) {
  return {
    type: "checkout.session.completed",
    id: `evt_${uid()}`,
    data: {
      object: {
        id: sessionId,
        payment_status: "paid",
        amount_total: 50000,
        payment_intent: `pi_${uid()}`,
        customer_details: { email: `buyer-${uid()}@test.com`, name: "Framing Buyer" },
        metadata: { artworkId, tenantId, fulfillmentType },
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
  mockCreateIFramerJob.mockReset();
  await cleanup();
});
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("FRAMING_JOB checkout — iFramer job persistence — real-DB integration", () => {
  it("FRAMING_JOB with iframerAccountId → iframerJobId persisted on order", async () => {
    const iframerAccountId = `ifr_acct_${uid()}`;
    const tenantId  = await createTenant(iframerAccountId);
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;
    const expectedJobId = `job_${uid()}`;

    mockCreateIFramerJob.mockResolvedValueOnce({ jobId: expectedJobId });

    const res = await post(checkoutEvent(sessionId, artworkId, tenantId, "FRAMING_JOB"));
    expect(res.status).toBe(200);

    const order = await orderBySession(sessionId);
    expect(order?.iframerJobId).toBe(expectedJobId);
  });

  it("FRAMING_JOB success → iframerJobError is null", async () => {
    const iframerAccountId = `ifr_acct_${uid()}`;
    const tenantId  = await createTenant(iframerAccountId);
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    mockCreateIFramerJob.mockResolvedValueOnce({ jobId: `job_${uid()}` });

    await post(checkoutEvent(sessionId, artworkId, tenantId, "FRAMING_JOB"));

    const order = await orderBySession(sessionId);
    expect(order?.iframerJobError).toBeNull();
  });

  it("iFramer failure → iframerJobError persisted on order", async () => {
    const { IFramerError } = await import("@/lib/iframer");
    const iframerAccountId = `ifr_acct_${uid()}`;
    const tenantId  = await createTenant(iframerAccountId);
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    mockCreateIFramerJob.mockRejectedValueOnce(new IFramerError("iFramer API timeout"));

    const res = await post(checkoutEvent(sessionId, artworkId, tenantId, "FRAMING_JOB"));
    expect(res.status).toBe(200); // order still created, job error logged

    const order = await orderBySession(sessionId);
    expect(order?.iframerJobError).toContain("iFramer API timeout");
    expect(order?.iframerJobId).toBeNull();
  });

  it("PICKUP order never sets iframerJobId", async () => {
    const iframerAccountId = `ifr_acct_${uid()}`;
    const tenantId  = await createTenant(iframerAccountId);
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    // createIFramerJob should NOT be called for PICKUP.
    mockCreateIFramerJob.mockResolvedValueOnce({ jobId: `job_${uid()}` });

    await post(checkoutEvent(sessionId, artworkId, tenantId, "PICKUP"));

    const order = await orderBySession(sessionId);
    expect(order?.iframerJobId).toBeNull();
    expect(mockCreateIFramerJob).not.toHaveBeenCalled();
  });

  it("FRAMING_JOB without iframerAccountId → iframerJobId stays null", async () => {
    const tenantId  = await createTenant(); // no iframerAccountId
    const artworkId = await createArtwork(tenantId);
    const sessionId = `cs_test_${uid()}`;

    mockCreateIFramerJob.mockResolvedValueOnce({ jobId: `job_${uid()}` });

    await post(checkoutEvent(sessionId, artworkId, tenantId, "FRAMING_JOB"));

    const order = await orderBySession(sessionId);
    expect(order?.iframerJobId).toBeNull();
    expect(mockCreateIFramerJob).not.toHaveBeenCalled();
  });
});
