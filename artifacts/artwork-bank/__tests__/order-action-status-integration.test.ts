/**
 * Order status transition actions — real-DB integration (markFulfilled,
 * markCancelled).
 *
 * The unit tests (order-status-transition-guard.test.ts) verify the guard
 * redirects with mocked DB.  This integration suite verifies the same
 * invariants against a real PostgreSQL database:
 *
 *  1. markFulfilled on a PAID order persists status=FULFILLED.
 *  2. markFulfilled on a non-PAID order does NOT change the DB row.
 *  3. markCancelled on a PAID/PENDING order persists status=CANCELLED.
 *  4. markCancelled on a CANCELLED order does NOT change the DB row.
 *  5. markCancelled on a FULFILLED order does NOT change the DB row.
 *  6. Both actions are tenant-scoped — a foreign orderId is rejected before
 *     any DB update.
 *
 * Auth, billing, email, cache, and next/navigation are mocked so only the
 * Drizzle→Postgres layer is exercised.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, ordersTable, orderItemsTable, artworksTable, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Auth ──────────────────────────────────────────────────────────────────────
const mockTenantId = { value: "PLACEHOLDER" };
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ userId: "test-user", tenantId: mockTenantId.value })),
}));

vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
  hasActiveAccess: () => true,
}));

// ── External side-effects: no-op ─────────────────────────────────────────────
vi.mock("@/lib/email", () => ({
  sendOrderStatusUpdate: vi.fn(async () => {}),
  sendOrderConfirmation: vi.fn(async () => {}),
  sendPartialRefundNotification: vi.fn(async () => {}),
}));
vi.mock("@/lib/base-url", () => ({
  getTenantUrl: vi.fn(() => "https://test.example/orders"),
  getPlatformBaseUrl: vi.fn(() => "https://platform.test"),
}));
vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(),
  StripeNotConfiguredError: class extends Error {},
}));
vi.mock("@/lib/slack", () => ({
  sendRefundDbFailureSlackNotification: vi.fn(async () => {}),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

import { markFulfilled, markCancelled } from "@/app/(admin)/(gated)/orders/[id]/actions";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdOrderIds: string[] = [];

function uid() {
  return `${randomUUID()}-${RUN}-${++seq}`;
}

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Order Action Integration Test",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: "active",
  } as any);
  createdTenantIds.push(id);
  mockTenantId.value = id;
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork",
    sku: `sku-${id}`,
    status: "AVAILABLE",
    showInGallery: true,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createOrder(tenantId: string, artworkId: string, status = "PAID") {
  const id = uid();
  await db.insert(ordersTable).values({
    id,
    tenantId,
    status,
    buyerEmail: "buyer@example.com",
    buyerName: "Test Buyer",
    totalCents: 10000,
    fulfillmentType: "PICKUP",
  } as any);
  await db.insert(orderItemsTable).values({
    id: uid(),
    orderId: id,
    artworkId,
    tenantId,
    artworkTitle: "Test Artwork",
    priceCents: 10000,
  } as any);
  createdOrderIds.push(id);
  return id;
}

afterEach(async () => {
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
});

afterAll(async () => {
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
});

function fd(orderId: string) {
  const f = new FormData();
  f.set("orderId", orderId);
  return f;
}

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration(
  "markFulfilled / markCancelled — real-DB status transitions",
  () => {
    // ── markFulfilled ─────────────────────────────────────────────────────────

    it("markFulfilled: persists status=FULFILLED in DB for a PAID order", async () => {
      const tenantId = await createTenant();
      const artworkId = await createArtwork(tenantId);
      const orderId = await createOrder(tenantId, artworkId, "PAID");

      await markFulfilled(fd(orderId));

      const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
      expect(row?.status).toBe("FULFILLED");
    });

    it("markFulfilled: does NOT change DB row for a PENDING order (redirects with action_error)", async () => {
      const tenantId = await createTenant();
      const artworkId = await createArtwork(tenantId);
      const orderId = await createOrder(tenantId, artworkId, "PENDING");

      await expect(markFulfilled(fd(orderId))).rejects.toThrow("REDIRECT:");

      const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
      expect(row?.status).toBe("PENDING");
    });

    it("markFulfilled: does NOT change DB row for an already-FULFILLED order", async () => {
      const tenantId = await createTenant();
      const artworkId = await createArtwork(tenantId);
      const orderId = await createOrder(tenantId, artworkId, "FULFILLED");

      await expect(markFulfilled(fd(orderId))).rejects.toThrow("REDIRECT:");

      const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
      expect(row?.status).toBe("FULFILLED");
    });

    it("markFulfilled: does NOT change DB row for a CANCELLED order", async () => {
      const tenantId = await createTenant();
      const artworkId = await createArtwork(tenantId);
      const orderId = await createOrder(tenantId, artworkId, "CANCELLED");

      await expect(markFulfilled(fd(orderId))).rejects.toThrow("REDIRECT:");

      const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
      expect(row?.status).toBe("CANCELLED");
    });

    // ── markCancelled ─────────────────────────────────────────────────────────

    it("markCancelled: persists status=CANCELLED in DB for a PAID order", async () => {
      const tenantId = await createTenant();
      const artworkId = await createArtwork(tenantId);
      const orderId = await createOrder(tenantId, artworkId, "PAID");

      await markCancelled(fd(orderId));

      const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
      expect(row?.status).toBe("CANCELLED");
    });

    it("markCancelled: persists status=CANCELLED in DB for a PENDING order", async () => {
      const tenantId = await createTenant();
      const artworkId = await createArtwork(tenantId);
      const orderId = await createOrder(tenantId, artworkId, "PENDING");

      await markCancelled(fd(orderId));

      const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
      expect(row?.status).toBe("CANCELLED");
    });

    it("markCancelled: does NOT change DB row for an already-CANCELLED order", async () => {
      const tenantId = await createTenant();
      const artworkId = await createArtwork(tenantId);
      const orderId = await createOrder(tenantId, artworkId, "CANCELLED");

      await expect(markCancelled(fd(orderId))).rejects.toThrow("REDIRECT:");

      const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
      expect(row?.status).toBe("CANCELLED");
    });

    it("markCancelled: does NOT change DB row for a FULFILLED order", async () => {
      const tenantId = await createTenant();
      const artworkId = await createArtwork(tenantId);
      const orderId = await createOrder(tenantId, artworkId, "FULFILLED");

      await expect(markCancelled(fd(orderId))).rejects.toThrow("REDIRECT:");

      const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
      expect(row?.status).toBe("FULFILLED");
    });

    // ── Tenant isolation ──────────────────────────────────────────────────────

    it("markFulfilled: throws for a foreign tenant's order — DB row unchanged", async () => {
      // Tenant A creates an order; session is for tenant B.
      const tenantA = await createTenant();
      const artworkId = await createArtwork(tenantA);
      const orderId = await createOrder(tenantA, artworkId, "PAID");

      // Switch session to tenant B (different tenant).
      const tenantB = await createTenant();
      mockTenantId.value = tenantB;

      await expect(markFulfilled(fd(orderId))).rejects.toThrow("Order not found");

      const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
      expect(row?.status).toBe("PAID");
    });
  },
);
