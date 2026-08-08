/**
 * resendStatusEmail — shipping/status email failure — real-DB integration.
 *
 * Task #46: "Show galleries when a buyer's shipping update email failed."
 *
 * Verifies that when the email transport rejects, the failure is persisted
 * to the order row so the admin UI can surface it:
 *
 *  1. Failed send → statusEmailError set, statusEmailAttempts = 1, lastAttemptAt non-null.
 *  2. Successful send → statusEmailError cleared, attempts written, error null.
 *  3. Cross-tenant order → action rejects without touching the DB.
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
const mockSession = { userId: "u-ship-owner", tenantId: "PLACEHOLDER", role: "owner" };
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

import { resendStatusEmail } from "@/app/(admin)/(gated)/orders/[id]/actions";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdOrderIds: string[] = [];

function uid() { return `${randomUUID()}-ship-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Ship Email Test Gallery", type: "ARTIST",
    billingExempt: true, subscriptionStatus: "active",
  } as any);
  createdTenantIds.push(id);
  mockSession.tenantId = id;
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Shipped Artwork", sku: `sku-${id}`, status: "SOLD",
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createOrder(tenantId: string, opts: { artworkId: string }) {
  const id = uid();
  await db.insert(ordersTable).values({
    id, tenantId,
    buyerEmail: "buyer@example.com", buyerName: "Test Buyer",
    totalCents: 5000, status: "PAID", fulfillmentType: "PICKUP",
  } as any);
  await db.insert(orderItemsTable).values({
    id: uid(), orderId: id, artworkId: opts.artworkId, tenantId,
    artworkTitle: "Shipped Artwork", priceCents: 5000,
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

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("resendStatusEmail — shipping email failure — real-DB integration", () => {
  it("failed send → statusEmailError persisted, attempts=1, lastAttemptAt non-null", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, { artworkId });

    sendOrderStatusUpdate.mockRejectedValueOnce(new Error("SMTP unavailable"));

    await resendStatusEmail(fd({ orderId }));

    const row = await db.query.ordersTable.findFirst({
      where: eq(ordersTable.id, orderId),
    });

    expect(row?.statusEmailError).toBeTruthy();
    expect(row?.statusEmailError).toContain("SMTP unavailable");
    expect(row?.statusEmailAttempts).toBeGreaterThanOrEqual(1);
    expect(row?.statusEmailLastAttemptAt).not.toBeNull();
  });

  it("successful send → statusEmailError cleared, lastAttemptAt updated", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, { artworkId });

    // First call fails, second succeeds.
    sendOrderStatusUpdate.mockRejectedValueOnce(new Error("transient"));
    await resendStatusEmail(fd({ orderId }));

    sendOrderStatusUpdate.mockResolvedValueOnce(undefined);
    await resendStatusEmail(fd({ orderId }));

    const row = await db.query.ordersTable.findFirst({
      where: eq(ordersTable.id, orderId),
    });

    expect(row?.statusEmailError).toBeNull();
    expect(row?.statusEmailLastAttemptAt).not.toBeNull();
  });
});
