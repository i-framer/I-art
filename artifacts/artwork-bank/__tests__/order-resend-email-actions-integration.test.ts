/**
 * Order email resend actions — real-DB integration.
 *
 * resendConfirmationEmail (app/(admin)/(gated)/orders/[id]/actions.ts:376)
 *   - On success: sets emailSentAt, clears emailError, sets emailLastAttemptAt.
 *   - On failure: sets emailError, sets emailLastAttemptAt, resets emailAttempts to 1.
 *
 * saveTrackingNote (actions.ts:425)
 *   - Stores the note; clears to null when empty string submitted.
 *   - If note is unchanged, persists with no extra side effect on DB.
 *
 * Foreign-tenant orders are rejected by requireOwnership.
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
const createdOrderIds: string[] = [];
const createdItemIds: string[] = [];

function uid() { return `${randomUUID()}-orra-${RUN}-${++seq}`; }

// ── Auth / billing / next ────────────────────────────────────────────────────
const mockTenantId = { value: "PLACEHOLDER" };
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ userId: "u-resend-test", tenantId: mockTenantId.value })),
}));
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
  hasActiveAccess: () => true,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// ── Email ────────────────────────────────────────────────────────────────────
const sendOrderConfirmation  = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const notifyBuyerOfUpdate    = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/email", () => ({
  sendOrderConfirmation,
  notifyBuyerOfUpdate,
}));

import {
  resendConfirmationEmail,
  saveTrackingNote,
} from "@/app/(admin)/(gated)/orders/[id]/actions";

// ── DB helpers ───────────────────────────────────────────────────────────────
async function createTenant() {
  const id = uid();
  mockTenantId.value = id;
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Email Resend Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Resend Test Art", sku: `sku-${id}`, status: "SOLD",
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createOrder(tenantId: string, artworkId: string, opts: {
  emailSentAt?: Date | null;
  emailAttempts?: number;
  trackingNote?: string | null;
} = {}) {
  const id = uid();
  await db.insert(ordersTable).values({
    id, tenantId, status: "PAID",
    totalCents: 10000,
    buyerName: "Test Buyer",
    buyerEmail: `buyer-${id}@test.com`,
    fulfillmentType: "PICKUP",
    stripeSessionId: `cs_test_${id}`,
    emailSentAt: opts.emailSentAt ?? null,
    emailAttempts: opts.emailAttempts ?? 0,
    trackingNote: opts.trackingNote ?? null,
  } as any);
  createdOrderIds.push(id);
  return id;
}

async function addItem(orderId: string, artworkId: string, tenantId: string) {
  const id = uid();
  await db.insert(orderItemsTable).values({
    id, orderId, artworkId, tenantId,
    artworkTitle: "Resend Test Art",
    priceCents: 10000,
  } as any);
  createdItemIds.push(id);
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
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("resendConfirmationEmail — real-DB integration", () => {
  it("on success: sets emailSentAt and clears emailError in DB", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId, { emailAttempts: 5 });
    await addItem(orderId, artworkId, tenantId);

    sendOrderConfirmation.mockResolvedValueOnce(undefined);
    await resendConfirmationEmail(fd({ orderId }));

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.emailSentAt).toBeInstanceOf(Date);
    expect(row?.emailError).toBeNull();
    expect(row?.emailLastAttemptAt).toBeInstanceOf(Date);
  });

  it("on send failure: sets emailError and resets emailAttempts to 1", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId, { emailAttempts: 5 });
    await addItem(orderId, artworkId, tenantId);

    sendOrderConfirmation.mockRejectedValueOnce(new Error("SMTP timeout"));
    await resendConfirmationEmail(fd({ orderId }));

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.emailError).toContain("SMTP timeout");
    expect(row?.emailAttempts).toBe(1); // retry budget reset
    expect(row?.emailLastAttemptAt).toBeInstanceOf(Date);
  });
});

describeIntegration("saveTrackingNote — real-DB integration", () => {
  it("stores a non-empty tracking note in DB", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId);

    await saveTrackingNote(fd({ orderId, note: "Shipped via AusPost — tracking AU123456789" }));

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.trackingNote).toBe("Shipped via AusPost — tracking AU123456789");
  });

  it("clears tracking note to null when empty string is submitted", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId, { trackingNote: "Old note" });

    await saveTrackingNote(fd({ orderId, note: "" }));

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.trackingNote).toBeNull();
  });

  it("updates an existing note to a new value", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId, { trackingNote: "Old note" });

    await saveTrackingNote(fd({ orderId, note: "Updated tracking info" }));

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.trackingNote).toBe("Updated tracking info");
  });
});
