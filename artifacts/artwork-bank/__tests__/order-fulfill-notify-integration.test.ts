/**
 * markFulfilled — buyer notification — real-DB integration.
 *
 * The unit test (order-action-status-integration.test.ts) mocks email and
 * verifies DB status transitions.  This integration suite verifies the
 * notification side-effects against real PostgreSQL:
 *
 *  1. PAID order → persists FULFILLED status; successful email clears queue.
 *  2. Email failure → order is still FULFILLED; error persisted in DB.
 *  3. Non-PAID order → redirects; DB row unchanged; no email sent.
 *  4. Foreign-tenant orderId → throws; order status unchanged; no email sent.
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

// ── Auth ──────────────────────────────────────────────────────────────────────
const mockSession = { userId: "u-fulfill-owner", tenantId: "PLACEHOLDER", role: "owner" };
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
}));
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
}));

// ── Email — controlled per-test ───────────────────────────────────────────────
const sendOrderStatusUpdate = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return { ...actual, sendOrderStatusUpdate };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));
vi.mock("@/lib/base-url", () => ({
  getTenantUrl: vi.fn().mockReturnValue("https://gallery.test/orders"),
}));

import { markFulfilled } from "@/app/(admin)/(gated)/orders/[id]/actions";

// ── DB helpers ────────────────────────────────────────────────────────────────
const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdOrderIds: string[] = [];

function uid() { return `${randomUUID()}-ffnotif-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id,
    businessName: "Fulfill Notify Test Gallery",
    type: "ARTIST", billingExempt: true,
    subscriptionStatus: "active",
  } as any);
  createdTenantIds.push(id);
  mockSession.tenantId = id;
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Fulfillable Artwork", sku: `sku-${id}`, status: "SOLD",
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createOrder(
  tenantId: string,
  artworkId: string,
  status: "PAID" | "PENDING" | "FULFILLED" | "CANCELLED" = "PAID",
) {
  const id = uid();
  await db.insert(ordersTable).values({
    id, tenantId,
    buyerEmail: "buyer@example.com",
    buyerName: "Test Buyer",
    totalCents: 7500,
    status,
    fulfillmentType: "PICKUP",
  } as any);
  await db.insert(orderItemsTable).values({
    id: uid(), orderId: id, artworkId, tenantId,
    artworkTitle: "Fulfillable Artwork", priceCents: 7500,
  } as any);
  createdOrderIds.push(id);
  return id;
}

function fd(orderId: string) {
  const f = new FormData();
  f.set("orderId", orderId);
  return f;
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
}

afterEach(async () => { sendOrderStatusUpdate.mockReset(); await cleanup(); });
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("markFulfilled — buyer notification — real-DB integration", () => {
  it("PAID order → persists FULFILLED; successful email clears queue fields", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId, "PAID");

    await markFulfilled(fd(orderId));

    const row = await db.query.ordersTable.findFirst({
      where: eq(ordersTable.id, orderId),
    });
    expect(row?.status).toBe("FULFILLED");
    expect(row?.statusEmailQueuedAt).toBeNull();
    expect(row?.statusEmailError).toBeNull();
    expect(sendOrderStatusUpdate).toHaveBeenCalledOnce();
  });

  it("email failure → order still FULFILLED; error persisted in DB", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId, "PAID");

    sendOrderStatusUpdate.mockRejectedValueOnce(new Error("SMTP timeout"));

    await markFulfilled(fd(orderId));

    const row = await db.query.ordersTable.findFirst({
      where: eq(ordersTable.id, orderId),
    });
    expect(row?.status).toBe("FULFILLED");
    expect(row?.statusEmailQueuedAt).not.toBeNull();
    expect(row?.statusEmailError).toBeTruthy();
  });

  it("non-PAID order → redirects; DB row unchanged; no email sent", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId, "PENDING");

    await expect(markFulfilled(fd(orderId))).rejects.toThrow(/REDIRECT/);

    const row = await db.query.ordersTable.findFirst({
      where: eq(ordersTable.id, orderId),
    });
    expect(row?.status).toBe("PENDING"); // unchanged
    expect(sendOrderStatusUpdate).not.toHaveBeenCalled();
  });

  it("foreign-tenant orderId → throws; order status unchanged; no email", async () => {
    const tenantA = await createTenant();
    const artworkId = await createArtwork(tenantA);
    const orderId = await createOrder(tenantA, artworkId, "PAID");

    const tenantB = await createTenant();
    mockSession.tenantId = tenantB;

    await expect(markFulfilled(fd(orderId))).rejects.toThrow();

    const row = await db.query.ordersTable.findFirst({
      where: eq(ordersTable.id, orderId),
    });
    expect(row?.status).toBe("PAID"); // unchanged
    expect(sendOrderStatusUpdate).not.toHaveBeenCalled();
  });
});
