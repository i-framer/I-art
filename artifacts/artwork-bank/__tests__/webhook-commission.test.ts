/**
 * Confirms that the 5% platform commission (applicationFeeCents) is recorded
 * correctly in the order after a successful checkout.session.completed event.
 *
 * The webhook calls calcApplicationFee(session.amount_total) and stores the
 * result in ordersTable.applicationFeeCents. These tests verify the correct
 * cent value is persisted — including the rounding edge case — so the formula
 * cannot silently drift to 0 or an incorrect value.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Hoisted state ─────────────────────────────────────────────────────────────
// Captures the `vals` object passed to tx.insert(ordersTable).values(vals) so
// we can assert applicationFeeCents without going through the DB layer.
const insertedOrderVals = vi.hoisted(() => ({ current: null as any }));

const tables = vi.hoisted(() => ({
  ordersTable: { stripeSessionId: "stripeSessionId", id: "id" },
  orderItemsTable: {},
  artworksTable: { id: "id", tenantId: "tenantId", status: "status" },
  tenantsTable: { id: "id" },
}));

// ── Mocks ─────────────────────────────────────────────────────────────────────
vi.mock("@workspace/db", () => ({
  db: {
    query: {
      ordersTable: { findFirst: vi.fn() },
      artworksTable: { findFirst: vi.fn() },
      tenantsTable: { findFirst: vi.fn() },
    },
    transaction: vi.fn(async (cb: any) => {
      const tx = {
        insert: (table: any) => ({
          values: (vals: any) => {
            // Capture order insert values for assertion
            if (table === tables.ordersTable) {
              insertedOrderVals.current = vals;
            }
            return {
              returning: () =>
                Promise.resolve([{ id: "order-1", ...vals }]),
            };
          },
        }),
        update: () => ({
          set: () => ({
            where: () => Promise.resolve(),
          }),
        }),
      };
      return cb(tx);
    }),
    insert: vi.fn(() => {
      throw new Error("order writes must go through db.transaction");
    }),
    update: vi.fn(() => ({
      set: () => ({ where: () => Promise.resolve() }),
    })),
  },
  ...tables,
}));

// Use the REAL calcApplicationFee so the test also catches formula drift
vi.mock("@/lib/stripe", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/stripe")>();
  return {
    getStripeClient: vi.fn(),
    getStripeWebhookSecret: vi.fn().mockResolvedValue(null),
    calcApplicationFee: real.calcApplicationFee,
    StripeNotConfiguredError: class StripeNotConfiguredError extends Error {},
  };
});

vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/iframer", () => ({
  createIFramerJob: vi.fn(),
  IFramerError: class IFramerError extends Error {},
}));

vi.mock("@/lib/base-url", () => ({
  getTenantUrl: vi.fn(() => "https://gallery.example.com/orders"),
}));

vi.mock("@/lib/slack", () => ({
  sendBillingAlertSlackNotification: vi.fn(),
}));

const mockHeaders = vi.hoisted(() => vi.fn());
vi.mock("next/headers", () => ({
  headers: () => mockHeaders(),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────
import { db } from "@workspace/db";
import { POST as webhookPOST } from "@/app/api/stripe/webhook/route";

function makeEvent(amountTotal: number) {
  return {
    type: "checkout.session.completed",
    data: {
      object: {
        id: `cs_test_${amountTotal}`,
        payment_intent: "pi_1",
        mode: "payment",
        amount_total: amountTotal,
        customer_details: { email: "buyer@example.com", name: "Buyer" },
        metadata: {
          artworkId: "art-1",
          tenantId: "tenant-1",
          fulfillmentType: "SHIP",
        },
      },
    },
  };
}

function post(amountTotal: number) {
  return webhookPOST(
    new Request("http://localhost/api/stripe/webhook", {
      method: "POST",
      body: JSON.stringify(makeEvent(amountTotal)),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  insertedOrderVals.current = null;
  process.env.STRIPE_WEBHOOK_DEV_BYPASS = "true";
  mockHeaders.mockResolvedValue(new Headers());

  vi.mocked(db.query.ordersTable.findFirst).mockResolvedValue(undefined as any);
  vi.mocked(db.query.artworksTable.findFirst).mockResolvedValue({
    id: "art-1",
    title: "Sunset",
    price: 10_000,
    sku: "SKU-1",
    dimensionsW: null,
    dimensionsH: null,
    condition: null,
  } as any);
  vi.mocked(db.query.tenantsTable.findFirst).mockResolvedValue({
    id: "tenant-1",
    businessName: "Gallery",
    iframerAccountId: null,
  } as any);
});

afterEach(() => {
  delete process.env.STRIPE_WEBHOOK_DEV_BYPASS;
});

// ── Tests ─────────────────────────────────────────────────────────────────────
describe("checkout.session.completed — applicationFeeCents", () => {
  it("records 5% of 10 000 cents (=$100) as 500 cents commission", async () => {
    const res = await post(10_000);
    expect(res.status).toBe(200);
    expect(insertedOrderVals.current).not.toBeNull();
    // 10 000 × 0.05 = 500 exactly
    expect(insertedOrderVals.current.applicationFeeCents).toBe(500);
  });

  it("rounds 9 999 cents correctly — Math.round(9999 × 0.05) = 500", async () => {
    vi.mocked(db.query.artworksTable.findFirst).mockResolvedValue({
      id: "art-1",
      title: "Sunset",
      price: 9_999,
      sku: "SKU-1",
      dimensionsW: null,
      dimensionsH: null,
      condition: null,
    } as any);

    const res = await post(9_999);
    expect(res.status).toBe(200);
    expect(insertedOrderVals.current).not.toBeNull();
    // 9 999 × 0.05 = 499.95 → rounds to 500
    expect(insertedOrderVals.current.applicationFeeCents).toBe(
      Math.round(9_999 * 0.05),
    );
    expect(insertedOrderVals.current.applicationFeeCents).toBe(500);
  });

  it("stores zero fee when amount_total is null rather than throwing", async () => {
    const event = {
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_null_total",
          payment_intent: "pi_1",
          mode: "payment",
          amount_total: null,
          customer_details: { email: "buyer@example.com", name: "Buyer" },
          metadata: {
            artworkId: "art-1",
            tenantId: "tenant-1",
            fulfillmentType: "SHIP",
          },
        },
      },
    };
    const res = await webhookPOST(
      new Request("http://localhost/api/stripe/webhook", {
        method: "POST",
        body: JSON.stringify(event),
      }),
    );
    expect(res.status).toBe(200);
    expect(insertedOrderVals.current).not.toBeNull();
    // When amount_total is null the code uses null for applicationFeeCents
    expect(insertedOrderVals.current.applicationFeeCents).toBeNull();
  });

  it("stores the commission alongside the full order total", async () => {
    const res = await post(12_000);
    expect(res.status).toBe(200);
    expect(insertedOrderVals.current.totalCents).toBe(12_000);
    // 12 000 × 0.05 = 600
    expect(insertedOrderVals.current.applicationFeeCents).toBe(600);
  });
});
