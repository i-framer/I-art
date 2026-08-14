/**
 * Stripe webhook — charge.refunded — real-DB integration.
 *
 * Verifies that the handleChargeRefunded handler correctly syncs external
 * Stripe refunds (issued via the Stripe dashboard, not the in-app action) to
 * the orders table.
 *
 * Uses STRIPE_WEBHOOK_DEV_BYPASS=true so no signature verification is needed.
 *
 * Scenarios covered:
 *  1. Partial refund → refundedAmountCents updated; status stays PAID; no email queued.
 *  2. Full refund → refundedAmountCents = totalCents; status → CANCELLED; buyer email queued.
 *  3. No matching order (unknown payment_intent) → 200, no DB write.
 *  4. Duplicate event (same amount already recorded) → idempotent, no update.
 *  5. Out-of-order event (lower amount arrives after higher) → skipped, preserves higher total.
 *  6. Full refund on already-CANCELLED order → refundedAmountCents updated; status unchanged.
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

vi.stubEnv("STRIPE_WEBHOOK_DEV_BYPASS", "true");

vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: vi.fn(async () => {}),
  sendBillingAlertNotification: vi.fn(async () => {}),
  sendOrderStatusUpdate: vi.fn(async () => {}),
  sendPartialRefundNotification: vi.fn(async () => {}),
}));
vi.mock("@/lib/slack", () => ({
  sendBillingAlertSlackNotification: vi.fn(async () => ({ ok: true })),
  sendRefundDbFailureSlackNotification: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/base-url", () => ({ getTenantUrl: vi.fn(() => "https://gallery.test/orders") }));
vi.mock("@/lib/iframer", () => ({
  createIFramerJob: vi.fn(async () => ({ ok: true })),
  IFramerError: class IFramerError extends Error {},
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (_key: string) => null,
  })),
}));

import { POST } from "@/app/api/stripe/webhook/route";

// ── Helpers ───────────────────────────────────────────────────────────────────
const RUN = Date.now();
let seq = 0;
function uid() { return `${randomUUID()}-cr-${RUN}-${++seq}`; }

const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdOrderIds: string[] = [];

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "ChargeRefund Test Gallery",
    type: "ARTIST", billingExempt: true,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Test Artwork", sku: `sku-${id}`,
    status: "AVAILABLE", price: 10_000,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createPaidOrder({
  tenantId,
  totalCents = 10_000,
  status = "PAID" as "PAID" | "FULFILLED" | "CANCELLED",
  refundedAmountCents = null as number | null,
}: {
  tenantId: string;
  totalCents?: number;
  status?: "PAID" | "FULFILLED" | "CANCELLED";
  refundedAmountCents?: number | null;
}) {
  const orderId = uid();
  const artworkId = await createArtwork(tenantId);
  const paymentIntentId = `pi_${uid()}`;
  await db.insert(ordersTable).values({
    id: orderId,
    tenantId,
    stripePaymentIntentId: paymentIntentId,
    stripeSessionId: `cs_${uid()}`,
    status,
    fulfillmentType: "PICKUP",
    totalCents,
    refundedAmountCents,
    buyerEmail: "buyer@example.com",
    buyerName: "Test Buyer",
  } as any);
  await db.insert(orderItemsTable).values({
    id: uid(),
    orderId,
    tenantId,
    artworkId,
    artworkTitle: "Test Artwork",
    priceCents: totalCents,
  } as any);
  createdOrderIds.push(orderId);
  return { orderId, paymentIntentId };
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

afterEach(cleanup);
afterAll(cleanup);

function chargeRefundedEvent(
  paymentIntentId: string,
  {
    chargeId,
    amountRefunded,
    fullyRefunded,
    refundId = `re_${uid()}`,
  }: {
    chargeId?: string;
    amountRefunded: number;
    fullyRefunded: boolean;
    refundId?: string;
  },
) {
  return {
    id: `evt_${uid()}`,
    type: "charge.refunded",
    data: {
      object: {
        id: chargeId ?? `ch_${uid()}`,
        payment_intent: paymentIntentId,
        amount: 10_000,
        amount_refunded: amountRefunded,
        refunded: fullyRefunded,
        refunds: {
          data: [{ id: refundId, amount: amountRefunded, status: "succeeded" }],
        },
      },
    },
  };
}

function makeRequest(event: object): Request {
  return new Request("http://localhost/api/stripe/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Stripe webhook — charge.refunded — real-DB integration", () => {
  it("partial refund: updates refundedAmountCents; status stays PAID; no email queued", async () => {
    const tenantId = await createTenant();
    const { orderId, paymentIntentId } = await createPaidOrder({ tenantId, totalCents: 10_000 });

    const res = await POST(makeRequest(chargeRefundedEvent(paymentIntentId, {
      amountRefunded: 3_000,
      fullyRefunded: false,
      refundId: "re_partial_test",
    })));

    expect(res.status).toBe(200);

    const row = await db.query.ordersTable.findFirst({
      where: eq(ordersTable.id, orderId),
      columns: { refundedAmountCents: true, status: true, stripeRefundId: true, statusEmailQueuedAt: true },
    });
    expect(row?.refundedAmountCents).toBe(3_000);
    expect(row?.status).toBe("PAID");
    expect(row?.stripeRefundId).toBe("re_partial_test");
    // Partial refund does not queue the status email.
    expect(row?.statusEmailQueuedAt).toBeNull();
  });

  it("full refund: refundedAmountCents = totalCents; status → CANCELLED; buyer email queued", async () => {
    const tenantId = await createTenant();
    const { orderId, paymentIntentId } = await createPaidOrder({ tenantId, totalCents: 10_000 });

    const res = await POST(makeRequest(chargeRefundedEvent(paymentIntentId, {
      amountRefunded: 10_000,
      fullyRefunded: true,
      refundId: "re_full_test",
    })));

    expect(res.status).toBe(200);

    const row = await db.query.ordersTable.findFirst({
      where: eq(ordersTable.id, orderId),
      columns: {
        refundedAmountCents: true, status: true, stripeRefundId: true,
        statusEmailQueuedAt: true, statusEmailAttempts: true,
      },
    });
    expect(row?.refundedAmountCents).toBe(10_000);
    expect(row?.status).toBe("CANCELLED");
    expect(row?.stripeRefundId).toBe("re_full_test");
    // Buyer status email should be queued for the sweep.
    expect(row?.statusEmailQueuedAt).not.toBeNull();
    expect(row?.statusEmailAttempts).toBe(0);
  });

  it("unknown payment_intent → 200, no DB write", async () => {
    const tenantId = await createTenant();
    const { orderId } = await createPaidOrder({ tenantId });

    const res = await POST(makeRequest(chargeRefundedEvent("pi_unknown_xyz", {
      amountRefunded: 5_000,
      fullyRefunded: false,
    })));

    expect(res.status).toBe(200);

    // Original order must be untouched.
    const row = await db.query.ordersTable.findFirst({
      where: eq(ordersTable.id, orderId),
      columns: { refundedAmountCents: true },
    });
    expect(row?.refundedAmountCents).toBeNull();
  });

  it("duplicate event (same amount already recorded) → idempotent, no second write", async () => {
    const tenantId = await createTenant();
    const { orderId, paymentIntentId } = await createPaidOrder({
      tenantId,
      refundedAmountCents: 3_000, // already has this total recorded
    });

    const res = await POST(makeRequest(chargeRefundedEvent(paymentIntentId, {
      amountRefunded: 3_000, // same value → should skip
      fullyRefunded: false,
      refundId: "re_dup_test",
    })));

    expect(res.status).toBe(200);

    const row = await db.query.ordersTable.findFirst({
      where: eq(ordersTable.id, orderId),
      columns: { refundedAmountCents: true, stripeRefundId: true },
    });
    // Value stays at 3_000 but stripeRefundId is NOT overwritten (no update ran).
    expect(row?.refundedAmountCents).toBe(3_000);
    // stripeRefundId was null in the initial row and still should be null since the
    // guard prevented an update.
    expect(row?.stripeRefundId).toBeNull();
  });

  it("out-of-order event (lower amount) → skipped, preserves higher DB total", async () => {
    const tenantId = await createTenant();
    const { orderId, paymentIntentId } = await createPaidOrder({
      tenantId,
      refundedAmountCents: 7_000, // already at $70 (from a later partial refund)
    });

    // A stale webhook arrives for a $30 partial refund — should be ignored.
    const res = await POST(makeRequest(chargeRefundedEvent(paymentIntentId, {
      amountRefunded: 3_000, // lower → skip
      fullyRefunded: false,
    })));

    expect(res.status).toBe(200);

    const row = await db.query.ordersTable.findFirst({
      where: eq(ordersTable.id, orderId),
      columns: { refundedAmountCents: true },
    });
    expect(row?.refundedAmountCents).toBe(7_000); // preserved
  });

  it("full refund on already-CANCELLED order: updates refundedAmountCents only (status unchanged)", async () => {
    const tenantId = await createTenant();
    const { orderId, paymentIntentId } = await createPaidOrder({
      tenantId,
      totalCents: 10_000,
      status: "CANCELLED",
      refundedAmountCents: null,
    });

    const res = await POST(makeRequest(chargeRefundedEvent(paymentIntentId, {
      amountRefunded: 10_000,
      fullyRefunded: true,
      refundId: "re_already_cancelled",
    })));

    expect(res.status).toBe(200);

    const row = await db.query.ordersTable.findFirst({
      where: eq(ordersTable.id, orderId),
      columns: { refundedAmountCents: true, status: true },
    });
    expect(row?.refundedAmountCents).toBe(10_000);
    // Status was already CANCELLED; the SET includes status='CANCELLED' which is
    // a no-op on an already-cancelled order — status should remain CANCELLED.
    expect(row?.status).toBe("CANCELLED");
  });
});
