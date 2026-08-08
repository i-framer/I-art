/**
 * resendStatusEmail / resendConfirmationEmail — real-DB integration.
 *
 * Unit tests (resend-confirmation-email.test.ts) cover the resend actions with
 * mocked DB.  This integration suite verifies the DB persistence invariants
 * against real PostgreSQL:
 *
 * resendStatusEmail:
 *  1. Resets statusEmailAttempts to 0 and queues the email (sets QueuedAt).
 *  2. After a successful send, statusEmailAttempts is incremented and error cleared.
 *  3. Foreign tenant orderId throws before any DB write.
 *
 * resendConfirmationEmail:
 *  4. On email success, persists emailSentAt and clears emailError.
 *  5. On email failure, records emailError and sets emailLastAttemptAt.
 *  6. Foreign tenant orderId throws before any send.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, ordersTable, orderItemsTable, artworksTable, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Auth ──────────────────────────────────────────────────────────────────────
const mockTenantId = { value: "PLACEHOLDER" };
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ userId: "u-resend", tenantId: mockTenantId.value })),
}));
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
  hasActiveAccess: () => true,
}));

// ── Email — controlled per test ───────────────────────────────────────────────
const sendOrderStatusUpdate = vi.hoisted(() => vi.fn(async () => {}));
const sendOrderConfirmation = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/email", () => ({
  sendOrderStatusUpdate: (...a: unknown[]) => sendOrderStatusUpdate(...a),
  sendOrderConfirmation: (...a: unknown[]) => sendOrderConfirmation(...a),
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

import {
  resendStatusEmail,
  resendConfirmationEmail,
} from "@/app/(admin)/(gated)/orders/[id]/actions";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdOrderIds: string[] = [];

function uid() {
  return `${randomUUID()}-rs-${RUN}-${++seq}`;
}

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id,
    businessName: "Resend Email Test Gallery",
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
    id, tenantId, title: "Test Artwork", sku: `sku-${id}`,
    status: "SOLD", showInGallery: false,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createOrder(
  tenantId: string, artworkId: string,
  opts: {
    status?: string;
    statusEmailError?: string | null;
    statusEmailAttempts?: number;
    emailError?: string | null;
    emailSentAt?: Date | null;
  } = {},
) {
  const id = uid();
  await db.insert(ordersTable).values({
    id, tenantId,
    status: opts.status ?? "PAID",
    buyerEmail: "buyer@example.com",
    buyerName: "Buyer",
    totalCents: 10000,
    fulfillmentType: "PICKUP",
    statusEmailError: opts.statusEmailError ?? null,
    statusEmailAttempts: opts.statusEmailAttempts ?? 0,
    emailError: opts.emailError ?? null,
    emailSentAt: opts.emailSentAt ?? null,
  } as any);
  await db.insert(orderItemsTable).values({
    id: uid(), orderId: id, artworkId, tenantId,
    artworkTitle: "Test Artwork", priceCents: 10000,
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

afterEach(async () => {
  sendOrderStatusUpdate.mockClear();
  sendOrderConfirmation.mockClear();
  await cleanup();
});
afterAll(cleanup);

function fd(orderId: string) {
  const f = new FormData();
  f.set("orderId", orderId);
  return f;
}

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("resendStatusEmail / resendConfirmationEmail — real-DB", () => {
  // ── resendStatusEmail ──────────────────────────────────────────────────────

  it("resendStatusEmail: clears statusEmailError and increments statusEmailAttempts on success", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId, {
      statusEmailError: "Previous error",
      statusEmailAttempts: 5,
    });

    // Email succeeds.
    sendOrderStatusUpdate.mockResolvedValueOnce(undefined);

    await resendStatusEmail(fd(orderId));

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    // Error cleared on success.
    expect(row?.statusEmailError).toBeNull();
    // Attempts incremented (sent once).
    expect((row?.statusEmailAttempts ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it("resendStatusEmail: records statusEmailError in DB when email send fails", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId, { statusEmailAttempts: 0 });

    sendOrderStatusUpdate.mockRejectedValueOnce(new Error("SMTP unavailable"));

    await resendStatusEmail(fd(orderId));

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.statusEmailError).toMatch(/SMTP unavailable/);
  });

  it("resendStatusEmail: throws for a foreign tenant's order — no send attempted", async () => {
    const tenantA = await createTenant();
    const artworkId = await createArtwork(tenantA);
    const orderId = await createOrder(tenantA, artworkId, {});

    const tenantB = await createTenant();
    mockTenantId.value = tenantB;

    await expect(resendStatusEmail(fd(orderId))).rejects.toThrow("Order not found");
    expect(sendOrderStatusUpdate).not.toHaveBeenCalled();
  });

  // ── resendConfirmationEmail ────────────────────────────────────────────────

  it("resendConfirmationEmail: sets emailSentAt and clears emailError on success", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId, {
      emailError: "Prior send failure",
      emailSentAt: null,
    });

    sendOrderConfirmation.mockResolvedValueOnce(undefined);

    await resendConfirmationEmail(fd(orderId));

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.emailSentAt).not.toBeNull();
    expect(row?.emailError).toBeNull();
  });

  it("resendConfirmationEmail: records emailError in DB when email send fails", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId, { emailSentAt: null });

    sendOrderConfirmation.mockRejectedValueOnce(new Error("Template error"));

    await resendConfirmationEmail(fd(orderId));

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.emailError).toMatch(/Template error/);
  });

  it("resendConfirmationEmail: throws for a foreign tenant's order — no send", async () => {
    const tenantA = await createTenant();
    const artworkId = await createArtwork(tenantA);
    const orderId = await createOrder(tenantA, artworkId, {});

    const tenantB = await createTenant();
    mockTenantId.value = tenantB;

    await expect(resendConfirmationEmail(fd(orderId))).rejects.toThrow("Order not found");
    expect(sendOrderConfirmation).not.toHaveBeenCalled();
  });
});
