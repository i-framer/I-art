/**
 * notifyBuyerOfPartialRefund — email failure — real-DB integration.
 *
 * Task #148: "Show galleries when a buyer's partial refund notification failed to send."
 *
 * `notifyBuyerOfPartialRefund` is an internal function called by `refundOrder`
 * when a partial refund is issued. This suite exercises it end-to-end via the
 * exported `refundOrder` action with real PostgreSQL:
 *
 *  1. Failed notification → statusEmailError persisted, lastAttemptAt non-null.
 *  2. Successful notification → statusEmailError null, lastAttemptAt updated.
 *  3. Refund DB state (refundedAmountCents, refundedAt) is preserved regardless
 *     of email outcome.
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
const mockSession = { userId: "u-pref-owner", tenantId: "PLACEHOLDER", role: "owner" };
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
}));
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
}));

// ── Stripe — success for the refund, controlled per test ──────────────────────
const stripeRefundsCreate = vi.hoisted(() =>
  vi.fn(async () => ({ id: "re_test_partial_001" })),
);
const stripeRefundsList = vi.hoisted(() =>
  vi.fn(async () => ({ data: [] })),
);
vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(async () => ({
    refunds: { create: stripeRefundsCreate, list: stripeRefundsList },
  })),
  StripeNotConfiguredError: class extends Error {},
}));

// ── Email — controlled per-test ───────────────────────────────────────────────
const sendPartialRefundNotification = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return { ...actual, sendPartialRefundNotification };
});

// ── Slack — no-op (alert fired if DB update fails, not relevant here) ─────────
vi.mock("@/lib/slack", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/slack")>();
  return { ...actual, sendRefundDbFailureSlackNotification: vi.fn(async () => {}) };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

import { refundOrder } from "@/app/(admin)/(gated)/orders/[id]/actions";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdOrderIds: string[] = [];

function uid() { return `${randomUUID()}-pref-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id,
    businessName: "Partial Refund Test Gallery",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: "active",
    contactEmail: "gallery@example.com",
  } as any);
  createdTenantIds.push(id);
  mockSession.tenantId = id;
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Refundable Artwork", sku: `sku-${id}`, status: "SOLD",
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createOrder(tenantId: string, opts: { artworkId: string }) {
  const id = uid();
  // stripePaymentIntentId is required by refundOrder; set a mock PI id.
  await db.insert(ordersTable).values({
    id, tenantId,
    buyerEmail: "buyer@example.com",
    buyerName: "Test Buyer",
    totalCents: 10000,
    status: "PAID",
    fulfillmentType: "PICKUP",
    stripePaymentIntentId: `pi_test_${id.slice(0, 8)}`,
  } as any);
  await db.insert(orderItemsTable).values({
    id: uid(), orderId: id, artworkId: opts.artworkId, tenantId,
    artworkTitle: "Refundable Artwork", priceCents: 10000,
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
  sendPartialRefundNotification.mockReset();
  stripeRefundsCreate.mockReset();
  stripeRefundsList.mockReset();
  await cleanup();
});
afterAll(cleanup);

function fd(orderId: string, refundAmountDollars: string) {
  const f = new FormData();
  f.set("orderId", orderId);
  f.set("refundAmountDollars", refundAmountDollars);
  return f;
}

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("notifyBuyerOfPartialRefund — email failure — real-DB integration", () => {
  it("failed notification → statusEmailError persisted, lastAttemptAt non-null", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, { artworkId });

    stripeRefundsList.mockResolvedValueOnce({ data: [] });
    stripeRefundsCreate.mockResolvedValueOnce({ id: "re_test_001" });
    sendPartialRefundNotification.mockRejectedValueOnce(new Error("SMTP timeout"));

    // Partial refund: $50 of $100 total — triggers notifyBuyerOfPartialRefund.
    try {
      await refundOrder(fd(orderId, "50"));
    } catch {
      // redirect() is thrown — expected
    }

    const row = await db.query.ordersTable.findFirst({
      where: eq(ordersTable.id, orderId),
    });

    // Refund DB state is persisted regardless of email outcome.
    expect(row?.refundedAmountCents).toBe(5000);
    expect(row?.refundedAt).not.toBeNull();

    // Email failure is persisted.
    expect(row?.statusEmailError).toBeTruthy();
    expect(row?.statusEmailError).toContain("SMTP timeout");
    expect(row?.statusEmailLastAttemptAt).not.toBeNull();
  });

  it("successful notification → statusEmailError null, lastAttemptAt updated", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, { artworkId });

    stripeRefundsList.mockResolvedValueOnce({ data: [] });
    stripeRefundsCreate.mockResolvedValueOnce({ id: "re_test_002" });
    sendPartialRefundNotification.mockResolvedValueOnce(undefined);

    try {
      await refundOrder(fd(orderId, "50"));
    } catch {
      // redirect() — expected
    }

    const row = await db.query.ordersTable.findFirst({
      where: eq(ordersTable.id, orderId),
    });

    expect(row?.refundedAmountCents).toBe(5000);
    expect(row?.statusEmailError).toBeNull();
    expect(row?.statusEmailLastAttemptAt).not.toBeNull();
  });
});
