/**
 * saveTrackingNote — real-DB integration.
 *
 * Unit tests (tracking-note-restart-retry.test.ts) verify email retry
 * behaviour with a mocked DB.  This integration suite verifies the DB
 * persistence and tenant-isolation invariants against real PostgreSQL:
 *
 *  1. A changed note is saved and the buyer notification is queued.
 *  2. An unchanged note is saved without restarting the email retry.
 *  3. An empty string note is stored as NULL.
 *  4. A foreign-tenant orderId is rejected before any DB write.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, ordersTable, orderItemsTable, artworksTable, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Auth ──────────────────────────────────────────────────────────────────────
const mockTenantId = { value: "PLACEHOLDER" };
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ userId: "u-tracking", tenantId: mockTenantId.value })),
}));

vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
  hasActiveAccess: () => true,
}));

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

import { saveTrackingNote } from "@/app/(admin)/(gated)/orders/[id]/actions";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdOrderIds: string[] = [];

function uid() {
  return `${randomUUID()}-tn-${RUN}-${++seq}`;
}

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id,
    businessName: "Tracking Note Test Gallery",
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
    id, tenantId, title: "Test", sku: `sku-${id}`, status: "AVAILABLE", showInGallery: true,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createOrder(
  tenantId: string,
  artworkId: string,
  opts: { trackingNote?: string | null; statusEmailQueuedAt?: Date | null } = {},
) {
  const id = uid();
  await db.insert(ordersTable).values({
    id, tenantId, status: "PAID",
    buyerEmail: "buyer@example.com",
    buyerName: "Buyer",
    totalCents: 10000,
    fulfillmentType: "PICKUP",
    trackingNote: opts.trackingNote ?? null,
    statusEmailQueuedAt: opts.statusEmailQueuedAt ?? null,
  } as any);
  await db.insert(orderItemsTable).values({
    id: uid(), orderId: id, artworkId, tenantId,
    artworkTitle: "Test", priceCents: 10000,
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

function fd(orderId: string, note: string) {
  const f = new FormData();
  f.set("orderId", orderId);
  f.set("note", note);
  return f;
}

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("saveTrackingNote — real-DB integration", () => {
  it("persists a new tracking note and queues buyer notification when note changes", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId, { trackingNote: null });

    await saveTrackingNote(fd(orderId, "Your parcel is with Australia Post"));

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.trackingNote).toBe("Your parcel is with Australia Post");
    // Note changed → buyer notification sent (statusEmailAttempts incremented).
    expect((row?.statusEmailAttempts ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it("saves the updated note when an existing note is changed", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId, { trackingNote: "Old note" });

    await saveTrackingNote(fd(orderId, "New note with tracking number AUP12345"));

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.trackingNote).toBe("New note with tracking number AUP12345");
    expect((row?.statusEmailAttempts ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it("does NOT queue buyer notification when note is unchanged", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId, {
      trackingNote: "Same note",
      statusEmailQueuedAt: null,
    });

    await saveTrackingNote(fd(orderId, "Same note"));

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    // Note unchanged → no email queued.
    expect(row?.statusEmailQueuedAt).toBeNull();
  });

  it("stores NULL when an empty string note is submitted", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId, { trackingNote: "Previous note" });

    await saveTrackingNote(fd(orderId, ""));

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.trackingNote).toBeNull();
    // Changed (previous→null) → buyer notification sent.
    expect((row?.statusEmailAttempts ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it("throws for a foreign tenant's order — DB row unchanged", async () => {
    const tenantA = await createTenant();
    const artworkId = await createArtwork(tenantA);
    const orderId = await createOrder(tenantA, artworkId, { trackingNote: "Original" });

    // Switch session to tenant B.
    const tenantB = await createTenant();
    mockTenantId.value = tenantB;

    await expect(saveTrackingNote(fd(orderId, "Injected note"))).rejects.toThrow("Order not found");

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.trackingNote).toBe("Original");
  });
});
