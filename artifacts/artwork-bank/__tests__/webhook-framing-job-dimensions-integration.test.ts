/**
 * FRAMING_JOB checkout — artwork dimensions → iFramer metres — real-DB integration.
 *
 * app/api/stripe/webhook/route.ts:775-816 (createIFramerJobForOrder):
 *   dimensionsW/H (stored in mm) ÷ 1000 → widthM/heightM passed to iFramer.
 *   sourceOrderId, sourceArtworkId, title, condition, accountId also forwarded.
 *
 *  1. FRAMING_JOB event with dimensionsW=600/H=900 → createIFramerJob called
 *     with widthM=0.6, heightM=0.9.
 *  2. Null dimensions → widthM=null, heightM=null passed to iFramer.
 *  3. sourceOrderId matches the created order id.
 *  4. sourceArtworkId matches the artwork id.
 *  5. Successful job → iframerJobId persisted on the order row.
 *  6. iFramer failure → iframerJobError persisted, order still committed.
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

function uid() { return `${randomUUID()}-wfjdi-${RUN}-${++seq}`; }

vi.mock("@/lib/iframer", () => ({
  createIFramerJob: vi.fn(),
  IFramerError: class IFramerError extends Error {
    constructor(message: string) { super(message); this.name = "IFramerError"; }
  },
}));
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
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));
vi.mock("@/lib/base-url", () => ({
  getTenantUrl: vi.fn(() => "https://example.com"),
}));

import { POST as webhookPOST } from "@/app/api/stripe/webhook/route";
import { createIFramerJob, IFramerError } from "@/lib/iframer";
const mockCreateIFramerJob = vi.mocked(createIFramerJob);

function post(event: object) {
  return webhookPOST(
    new Request("http://localhost/api/stripe/webhook", {
      method: "POST",
      body: JSON.stringify(event),
    }),
  );
}

async function createTenant(withIframer = true) {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Framing Dimensions Test", type: "FRAMER",
    billingExempt: true,
    ...(withIframer ? { iframerAccountId: `acc_${uid()}` } : {}),
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string, dims: { w: number | null; h: number | null; condition?: string } = { w: 600, h: 900 }) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Framing Test Artwork", sku: `sku-${id}`,
    status: "RESERVED", price: 50000, showInGallery: true,
    dimensionsW: dims.w,
    dimensionsH: dims.h,
    condition: dims.condition ?? "GOOD",
  } as any);
  createdArtworkIds.push(id);
  return id;
}

function framingEvent(sessionId: string, artworkId: string, tenantId: string) {
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
        metadata: { artworkId, tenantId, fulfillmentType: "FRAMING_JOB" },
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

afterEach(async () => { mockCreateIFramerJob.mockReset(); await cleanup(); });
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("FRAMING_JOB dimensions → iFramer metres — real-DB integration", () => {
  it("dimensionsW=600/H=900 → createIFramerJob called with widthM=0.6, heightM=0.9", async () => {
    const tenantId  = await createTenant(true);
    const artworkId = await createArtwork(tenantId, { w: 600, h: 900 });
    const sessionId = `cs_test_${uid()}`;
    mockCreateIFramerJob.mockResolvedValue({ jobId: `job_${uid()}` });

    await post(framingEvent(sessionId, artworkId, tenantId));

    expect(mockCreateIFramerJob).toHaveBeenCalledTimes(1);
    const call = mockCreateIFramerJob.mock.calls[0][0];
    expect(call.widthM).toBeCloseTo(0.6);
    expect(call.heightM).toBeCloseTo(0.9);
  });

  it("null dimensions → widthM=null, heightM=null passed to iFramer", async () => {
    const tenantId  = await createTenant(true);
    const artworkId = await createArtwork(tenantId, { w: null, h: null });
    const sessionId = `cs_test_${uid()}`;
    mockCreateIFramerJob.mockResolvedValue({ jobId: `job_${uid()}` });

    await post(framingEvent(sessionId, artworkId, tenantId));

    const call = mockCreateIFramerJob.mock.calls[0][0];
    expect(call.widthM).toBeNull();
    expect(call.heightM).toBeNull();
  });

  it("sourceOrderId matches the created order id", async () => {
    const tenantId  = await createTenant(true);
    const artworkId = await createArtwork(tenantId, { w: 500, h: 700 });
    const sessionId = `cs_test_${uid()}`;
    mockCreateIFramerJob.mockResolvedValue({ jobId: `job_${uid()}` });

    await post(framingEvent(sessionId, artworkId, tenantId));

    const order = await orderBySession(sessionId);
    const call = mockCreateIFramerJob.mock.calls[0][0];
    expect(call.sourceOrderId).toBe(order?.id);
  });

  it("sourceArtworkId matches the artwork id", async () => {
    const tenantId  = await createTenant(true);
    const artworkId = await createArtwork(tenantId, { w: 400, h: 600 });
    const sessionId = `cs_test_${uid()}`;
    mockCreateIFramerJob.mockResolvedValue({ jobId: `job_${uid()}` });

    await post(framingEvent(sessionId, artworkId, tenantId));

    const call = mockCreateIFramerJob.mock.calls[0][0];
    expect(call.sourceArtworkId).toBe(artworkId);
  });

  it("successful iFramer job → iframerJobId persisted on order row", async () => {
    const tenantId  = await createTenant(true);
    const artworkId = await createArtwork(tenantId, { w: 300, h: 400 });
    const sessionId = `cs_test_${uid()}`;
    const jobId = `job_${uid()}`;
    mockCreateIFramerJob.mockResolvedValue({ jobId });

    await post(framingEvent(sessionId, artworkId, tenantId));

    const order = await orderBySession(sessionId);
    expect(order?.iframerJobId).toBe(jobId);
    expect(order?.iframerJobError).toBeNull();
  });

  it("iFramer API failure → iframerJobError persisted, order still committed", async () => {
    const tenantId  = await createTenant(true);
    const artworkId = await createArtwork(tenantId, { w: 300, h: 400 });
    const sessionId = `cs_test_${uid()}`;
    mockCreateIFramerJob.mockRejectedValue(new IFramerError("iFramer API timeout"));

    const res = await post(framingEvent(sessionId, artworkId, tenantId));
    expect(res.status).toBe(200);

    const order = await orderBySession(sessionId);
    expect(order).not.toBeUndefined(); // order committed
    expect(order?.iframerJobId).toBeNull();
    expect(order?.iframerJobError).toContain("iFramer API timeout");
  });
});
