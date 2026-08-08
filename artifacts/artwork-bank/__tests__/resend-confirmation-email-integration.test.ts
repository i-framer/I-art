/**
 * resendConfirmationEmail — real-DB integration.
 *
 * Existing `resend-confirmation-email.test.ts` mocks the DB.  This suite
 * verifies the email persistence logic against real PostgreSQL:
 *
 *  1. Successful send → emailSentAt set, emailError null, emailLastAttemptAt non-null.
 *  2. Failed send → emailError persisted, emailAttempts = 1, emailLastAttemptAt non-null.
 *  3. Second successful send → emailError cleared, emailSentAt updated.
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
const mockSession = { userId: "u-conf-owner", tenantId: "PLACEHOLDER", role: "owner" };
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
}));
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
}));

// ── Email — controlled per-test ───────────────────────────────────────────────
const sendOrderConfirmation = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return { ...actual, sendOrderConfirmation };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { resendConfirmationEmail } from "@/app/(admin)/(gated)/orders/[id]/actions";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdOrderIds: string[] = [];

function uid() { return `${randomUUID()}-conf-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id,
    businessName: "Confirm Email Test Gallery",
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
    id, tenantId, title: "Confirmed Artwork", sku: `sku-${id}`, status: "SOLD",
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createOrder(tenantId: string, artworkId: string) {
  const id = uid();
  await db.insert(ordersTable).values({
    id, tenantId,
    buyerEmail: "buyer@example.com",
    buyerName: "Test Buyer",
    totalCents: 7500,
    status: "PAID",
    fulfillmentType: "PICKUP",
  } as any);
  await db.insert(orderItemsTable).values({
    id: uid(), orderId: id, artworkId, tenantId,
    artworkTitle: "Confirmed Artwork", priceCents: 7500,
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

afterEach(async () => { sendOrderConfirmation.mockReset(); await cleanup(); });
afterAll(cleanup);

function fd(orderId: string) {
  const f = new FormData();
  f.set("orderId", orderId);
  return f;
}

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("resendConfirmationEmail — real-DB integration", () => {
  it("successful send → emailSentAt set, emailError null, emailLastAttemptAt non-null", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId);

    sendOrderConfirmation.mockResolvedValueOnce(undefined);

    await resendConfirmationEmail(fd(orderId));

    const row = await db.query.ordersTable.findFirst({
      where: eq(ordersTable.id, orderId),
    });

    expect(row?.emailSentAt).not.toBeNull();
    expect(row?.emailError).toBeNull();
    expect(row?.emailLastAttemptAt).not.toBeNull();
  });

  it("failed send → emailError persisted, emailAttempts=1, emailLastAttemptAt non-null", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId);

    sendOrderConfirmation.mockRejectedValueOnce(new Error("SMTP refused connection"));

    await resendConfirmationEmail(fd(orderId));

    const row = await db.query.ordersTable.findFirst({
      where: eq(ordersTable.id, orderId),
    });

    expect(row?.emailError).toBeTruthy();
    expect(row?.emailError).toContain("SMTP refused connection");
    expect(row?.emailAttempts).toBeGreaterThanOrEqual(1);
    expect(row?.emailLastAttemptAt).not.toBeNull();
  });

  it("second send after failure → emailError cleared, emailSentAt updated", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId);

    // First attempt fails.
    sendOrderConfirmation.mockRejectedValueOnce(new Error("transient error"));
    await resendConfirmationEmail(fd(orderId));

    // Second attempt succeeds.
    sendOrderConfirmation.mockResolvedValueOnce(undefined);
    await resendConfirmationEmail(fd(orderId));

    const row = await db.query.ordersTable.findFirst({
      where: eq(ordersTable.id, orderId),
    });

    expect(row?.emailError).toBeNull();
    expect(row?.emailSentAt).not.toBeNull();
  });
});
