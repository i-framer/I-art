/**
 * saveTrackingNote action — clear/update — real-DB integration.
 *
 * app/(admin)/(gated)/orders/[id]/actions.ts:425-435:
 *   saveTrackingNote sets trackingNote = note || null (empty string → null).
 *
 * Existing `order-resend-email-actions-integration.test.ts` covers storing
 * a non-empty note; this suite covers the clearing/update semantics:
 *
 *  1. Clearing a previously-set tracking note stores null.
 *  2. Empty string clears the note (stores null).
 *  3. Updating an existing note overwrites the old value.
 *  4. Foreign tenant order tracking note cannot be cleared.
 *  5. Clearing the note does not affect statusEmailQueuedAt.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  ordersTable,
  orderItemsTable,
  usersTable,
  tenantUsersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdOrderIds: string[] = [];
const createdItemIds: string[] = [];
const createdUserIds: string[] = [];

function uid() { return `${randomUUID()}-otncl-${RUN}-${++seq}`; }

const mockSession = { value: { userId: "u-tracking-clear", tenantId: "PLACEHOLDER", role: "owner" } };

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => mockSession.value),
}));
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
  hasActiveAccess: () => true,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

import { saveTrackingNote } from "@/app/(admin)/(gated)/orders/[id]/actions";

async function createTenant() {
  const id = uid();
  const userId = uid();
  await db.insert(usersTable).values({ id: userId, email: `u-${userId}@test.com`, passwordHash: "x" } as any);
  createdUserIds.push(userId);
  mockSession.value = { userId, tenantId: id, role: "owner" };
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Tracking Clear Test Gallery", type: "ARTIST",
    contactEmail: "gallery@tracking.test",
  } as any);
  createdTenantIds.push(id);
  await db.insert(tenantUsersTable).values({ tenantId: id, userId, role: "owner" } as any);
  return { tenantId: id, userId };
}

async function createOrder(tenantId: string, trackingNote?: string) {
  const id = uid();
  await db.insert(ordersTable).values({
    id, tenantId, status: "FULFILLED",
    totalCents: 12000,
    buyerEmail: `buyer-${id}@test.com`,
    buyerName: "Tracking Buyer",
    fulfillmentType: "PICKUP",
    stripeSessionId: `cs_test_${id}`,
    trackingNote: trackingNote ?? null,
  } as any);
  createdOrderIds.push(id);
  return id;
}

function fd(entries: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
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
    await db.delete(tenantUsersTable).where(eq(tenantUsersTable.tenantId, id)).catch(() => {});
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
  for (const id of createdUserIds.splice(0)) {
    await db.delete(usersTable).where(eq(usersTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("saveTrackingNote — clear/update — real-DB integration", () => {
  it("clearing a previously-set tracking note stores null", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createOrder(tenantId, "Left with neighbour.");

    await saveTrackingNote(fd({ orderId, note: "" }))
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.trackingNote).toBeNull();
  });

  it("empty string clears the note (stores null)", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createOrder(tenantId, "Some previous note.");

    await saveTrackingNote(fd({ orderId, note: "" }))
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.trackingNote).toBeNull();
  });

  it("updating an existing note overwrites the old value", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createOrder(tenantId, "Old note.");

    await saveTrackingNote(fd({ orderId, note: "New updated note." }))
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.trackingNote).toBe("New updated note.");
  });

  it("foreign tenant order tracking note cannot be cleared via own session", async () => {
    const { tenantId: ownId } = await createTenant();

    const foreignTenantId = uid();
    await db.insert(tenantsTable).values({
      id: foreignTenantId, slug: foreignTenantId,
      businessName: "Foreign Tracking Gallery", type: "ARTIST",
    } as any);
    createdTenantIds.push(foreignTenantId);
    const foreignOrderId = await createOrder(foreignTenantId, "Foreign note.");

    // saveTrackingNote scoped to own tenant's order.
    await saveTrackingNote(fd({ orderId: foreignOrderId, note: "" })).catch(() => {});

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, foreignOrderId) });
    expect(row?.trackingNote).toBe("Foreign note."); // unchanged
  });

  it("clearing the note does not affect statusEmailQueuedAt", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createOrder(tenantId, "Note to clear.");
    const queuedAt = new Date();
    await db.update(ordersTable).set({ statusEmailQueuedAt: queuedAt }).where(eq(ordersTable.id, orderId));

    await saveTrackingNote(fd({ orderId, note: "" }))
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.trackingNote).toBeNull();
    // statusEmailQueuedAt must be preserved.
    expect(row?.statusEmailQueuedAt).toBeInstanceOf(Date);
  });
});
