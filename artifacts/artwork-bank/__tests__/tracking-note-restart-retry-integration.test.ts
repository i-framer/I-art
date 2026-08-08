/**
 * saveTrackingNote — status-email retry restart — real-DB integration.
 *
 * Task #50: "Tracking-note change restarts status-email retries."
 *
 * `tracking-note-restart-retry.test.ts` uses a mocked DB.  This integration
 * suite verifies the retry-restart behavior against real PostgreSQL:
 *
 *  1. Changed note + failed send → statusEmailQueuedAt set (non-null), error
 *     persisted, attempts >= 1.
 *  2. Changed note + successful send → statusEmailQueuedAt cleared (null),
 *     statusEmailError null, attempts >= 1, note persisted.
 *  3. Unchanged note → no status-email queue fields touched; note unchanged.
 *  4. Note changed from non-null to null → treated as change; queue restarts.
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
const mockSession = { userId: "u-track-owner", tenantId: "PLACEHOLDER", role: "owner" };
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

import { saveTrackingNote } from "@/app/(admin)/(gated)/orders/[id]/actions";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdOrderIds: string[] = [];

function uid() { return `${randomUUID()}-trk-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id,
    businessName: "Tracking Retry Test Gallery",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: "active",
  } as any);
  createdTenantIds.push(id);
  mockSession.tenantId = id;
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Tracked Artwork", sku: `sku-${id}`, status: "SOLD",
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createOrder(tenantId: string, artworkId: string, opts: {
  trackingNote?: string | null;
} = {}) {
  const id = uid();
  await db.insert(ordersTable).values({
    id, tenantId,
    buyerEmail: "buyer@example.com",
    buyerName: "Test Buyer",
    totalCents: 8000,
    status: "PAID",
    fulfillmentType: "PICKUP",
    trackingNote: opts.trackingNote ?? null,
  } as any);
  await db.insert(orderItemsTable).values({
    id: uid(), orderId: id, artworkId, tenantId,
    artworkTitle: "Tracked Artwork", priceCents: 8000,
  } as any);
  createdOrderIds.push(id);
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
}

afterEach(async () => { sendOrderStatusUpdate.mockReset(); await cleanup(); });
afterAll(cleanup);

function fd(orderId: string, note: string) {
  const f = new FormData();
  f.set("orderId", orderId);
  f.set("note", note);
  return f;
}

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("saveTrackingNote — retry restart — real-DB integration", () => {
  it("changed note + failed send → statusEmailQueuedAt non-null, error persisted", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId);

    sendOrderStatusUpdate.mockRejectedValueOnce(new Error("SMTP down"));

    await saveTrackingNote(fd(orderId, "Dispatched via courier"));

    const row = await db.query.ordersTable.findFirst({
      where: eq(ordersTable.id, orderId),
    });

    expect(row?.trackingNote).toBe("Dispatched via courier");
    // Failed send → queue remains set so sweep can retry.
    expect(row?.statusEmailQueuedAt).not.toBeNull();
    expect(row?.statusEmailError).toBeTruthy();
    expect(row?.statusEmailAttempts).toBeGreaterThanOrEqual(1);
  });

  it("changed note + successful send → queue cleared, note persisted, error null", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId);

    sendOrderStatusUpdate.mockResolvedValueOnce(undefined);

    await saveTrackingNote(fd(orderId, "Ready for pickup"));

    const row = await db.query.ordersTable.findFirst({
      where: eq(ordersTable.id, orderId),
    });

    expect(row?.trackingNote).toBe("Ready for pickup");
    // Successful send → queue cleared.
    expect(row?.statusEmailQueuedAt).toBeNull();
    expect(row?.statusEmailError).toBeNull();
    expect(row?.statusEmailAttempts).toBeGreaterThanOrEqual(1);
  });

  it("unchanged note → no email sent, queue fields untouched", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId, { trackingNote: "Same note" });

    await saveTrackingNote(fd(orderId, "Same note"));

    expect(sendOrderStatusUpdate).not.toHaveBeenCalled();

    const row = await db.query.ordersTable.findFirst({
      where: eq(ordersTable.id, orderId),
    });

    expect(row?.trackingNote).toBe("Same note");
    expect(row?.statusEmailQueuedAt).toBeNull();
    expect(row?.statusEmailError).toBeNull();
  });

  it("note cleared (changed to empty) → treated as change, queue restarts", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId, { trackingNote: "Old note" });

    sendOrderStatusUpdate.mockRejectedValueOnce(new Error("transient"));

    await saveTrackingNote(fd(orderId, ""));

    const row = await db.query.ordersTable.findFirst({
      where: eq(ordersTable.id, orderId),
    });

    // Empty string stored as null by the action (note || null).
    expect(row?.trackingNote).toBeNull();
    // Clearing the note is a change → queue was kicked.
    expect(sendOrderStatusUpdate).toHaveBeenCalledOnce();
  });
});
