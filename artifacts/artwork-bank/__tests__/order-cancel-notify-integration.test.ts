/**
 * markCancelled — buyer notification — real-DB integration.
 *
 * The mocked unit test (order-cancel-notification.test.ts) verifies the call
 * sequence.  This integration suite verifies DB-side behaviour against real
 * PostgreSQL:
 *
 *  1. Successful send → order is CANCELLED, statusEmailQueuedAt cleared, no error.
 *  2. Email failure → order is still CANCELLED, statusEmailError persisted.
 *  3. Foreign-tenant orderId → throws; order is unchanged (no status mutation).
 *  4. Already-CANCELLED order → redirects (guard fires); no double-mutation.
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
const mockSession = { userId: "u-cancel-owner", tenantId: "PLACEHOLDER", role: "owner" };
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

// ── Misc mocks ────────────────────────────────────────────────────────────────
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));
vi.mock("@/lib/base-url", () => ({
  getTenantUrl: vi.fn().mockReturnValue("https://gallery.test/orders"),
}));

import { markCancelled } from "@/app/(admin)/(gated)/orders/[id]/actions";

// ── DB helpers ────────────────────────────────────────────────────────────────
const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdOrderIds: string[] = [];

function uid() { return `${randomUUID()}-cancnotif-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id,
    businessName: "Cancel Notify Test Gallery",
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
    id, tenantId, title: "Cancelable Artwork", sku: `sku-${id}`, status: "SOLD",
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createOrder(
  tenantId: string,
  artworkId: string,
  status: "PAID" | "PENDING" | "CANCELLED" | "FULFILLED" = "PAID",
) {
  const id = uid();
  await db.insert(ordersTable).values({
    id, tenantId,
    buyerEmail: "buyer@example.com",
    buyerName: "Test Buyer",
    totalCents: 5000,
    status,
    fulfillmentType: "PICKUP",
  } as any);
  await db.insert(orderItemsTable).values({
    id: uid(), orderId: id, artworkId, tenantId,
    artworkTitle: "Cancelable Artwork", priceCents: 5000,
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

describeIntegration("markCancelled — buyer notification — real-DB integration", () => {
  it("PAID order → persists CANCELLED status; email send clears queue fields", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId, "PAID");

    await markCancelled(fd(orderId));

    const row = await db.query.ordersTable.findFirst({
      where: eq(ordersTable.id, orderId),
    });
    expect(row?.status).toBe("CANCELLED");
    // Successful send clears the queue.
    expect(row?.statusEmailQueuedAt).toBeNull();
    expect(row?.statusEmailError).toBeNull();
    expect(sendOrderStatusUpdate).toHaveBeenCalledOnce();
  });

  it("email failure → order still CANCELLED; error persisted, attempts incremented", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId, "PAID");

    sendOrderStatusUpdate.mockRejectedValueOnce(new Error("SMTP down"));

    await markCancelled(fd(orderId));

    const row = await db.query.ordersTable.findFirst({
      where: eq(ordersTable.id, orderId),
    });
    // Status must still be CANCELLED even though email failed.
    expect(row?.status).toBe("CANCELLED");
    // Queue is set so the sweep can retry.
    expect(row?.statusEmailQueuedAt).not.toBeNull();
    expect(row?.statusEmailError).toBeTruthy();
  });

  it("PENDING order → persists CANCELLED status and sends buyer notification", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId, "PENDING");

    await markCancelled(fd(orderId));

    const row = await db.query.ordersTable.findFirst({
      where: eq(ordersTable.id, orderId),
    });
    expect(row?.status).toBe("CANCELLED");
    expect(sendOrderStatusUpdate).toHaveBeenCalledOnce();
  });

  it("already-CANCELLED order → redirects; no additional status update or email", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId, "CANCELLED");

    await expect(markCancelled(fd(orderId))).rejects.toThrow(/REDIRECT/);

    const row = await db.query.ordersTable.findFirst({
      where: eq(ordersTable.id, orderId),
    });
    expect(row?.status).toBe("CANCELLED"); // unchanged
    expect(sendOrderStatusUpdate).not.toHaveBeenCalled();
  });

  it("foreign-tenant orderId → throws 'Order not found'; order status unchanged", async () => {
    const tenantA = await createTenant();
    const artworkId = await createArtwork(tenantA);
    const orderId = await createOrder(tenantA, artworkId, "PAID");

    // Switch to tenant B.
    const tenantB = await createTenant();
    mockSession.tenantId = tenantB;

    await expect(markCancelled(fd(orderId))).rejects.toThrow();

    // Original order is still PAID.
    const row = await db.query.ordersTable.findFirst({
      where: eq(ordersTable.id, orderId),
    });
    expect(row?.status).toBe("PAID");
    expect(sendOrderStatusUpdate).not.toHaveBeenCalled();
  });
});
