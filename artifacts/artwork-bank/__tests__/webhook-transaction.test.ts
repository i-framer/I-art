/**
 * Regression tests: handleCheckoutCompleted must create the order, order item,
 * and mark the artwork SOLD inside a single DB transaction so a mid-way
 * failure can never leave a paid order half-recorded. Also covers idempotent
 * retries (Stripe redelivering the same event) and non-fatal email failures.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Fake transactional db ────────────────────────────────────────────────────
// Records operations issued through the transaction callback. If the callback
// throws, the "committed" list stays empty (rollback semantics).
const state = vi.hoisted(() => ({
  committed: [] as string[],
  orderValues: [] as any[],
  failOn: null as string | null, // e.g. "insert:orderItems"
  directUpdates: [] as any[], // db.update(...).set(vals) outside the transaction
}));

const tables = vi.hoisted(() => ({
  ordersTable: { stripeSessionId: "stripeSessionId", id: "id" },
  orderItemsTable: {},
  artworksTable: { id: "id", tenantId: "tenantId", status: "status" },
  tenantsTable: { id: "id" },
}));

const transactionSpy = vi.hoisted(() =>
  vi.fn(async (cb: any) => {
    const staged: string[] = [];
    const tx = {
      insert: (table: any) => ({
        values: (vals: any) => {
          const name = table === tables.ordersTable ? "orders" : "orderItems";
          if (state.failOn === `insert:${name}`)
            throw new Error(`boom ${name}`);
          staged.push(`insert:${name}`);
          if (name === "orders") state.orderValues.push(vals);
          return {
            returning: () => Promise.resolve([{ id: "order-1", ...vals }]),
            then: (res: any) => Promise.resolve(undefined).then(res),
          };
        },
      }),
      update: () => ({
        set: () => ({
          where: () => {
            if (state.failOn === "update:artworks")
              throw new Error("boom artworks");
            staged.push("update:artworks");
            return Promise.resolve();
          },
        }),
      }),
    };
    const result = await cb(tx); // throws → nothing committed
    state.committed.push(...staged);
    return result;
  }),
);

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      ordersTable: { findFirst: vi.fn() },
      artworksTable: { findFirst: vi.fn() },
      tenantsTable: { findFirst: vi.fn() },
    },
    transaction: (cb: any) => transactionSpy(cb),
    // direct insert should NOT be used for order creation anymore
    insert: vi.fn(() => {
      throw new Error("order writes must go through db.transaction");
    }),
    update: vi.fn(() => ({
      set: (vals: any) => {
        state.directUpdates.push(vals);
        return { where: () => Promise.resolve() };
      },
    })),
  },
  ...tables,
}));

vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(),
  getStripeWebhookSecret: vi.fn().mockResolvedValue(null),
  calcApplicationFee: (cents: number) => Math.round(cents * 0.05),
  StripeNotConfiguredError: class StripeNotConfiguredError extends Error {},
}));

const sendOrderConfirmation = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: (...args: any[]) => sendOrderConfirmation(...args),
}));

vi.mock("@/lib/iframer", () => ({
  createIFramerJob: vi.fn(),
  IFramerError: class IFramerError extends Error {},
}));

const mockHeaders = vi.hoisted(() => vi.fn());
vi.mock("next/headers", () => ({
  headers: () => mockHeaders(),
}));

import { db } from "@workspace/db";
import { POST as webhookPOST } from "@/app/api/stripe/webhook/route";

function completedEvent() {
  return {
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_1",
        payment_intent: "pi_1",
        amount_total: 12_000,
        customer_details: { email: "buyer@example.com", name: "Buyer" },
        metadata: {
          artworkId: "art-1",
          tenantId: "tenant-1",
          fulfillmentType: "SHIP",
          freightMethodName: "Australia Post",
          freightClass: "MEDIUM",
          freightCents: "2500",
        },
      },
    },
  };
}

function post() {
  return webhookPOST(
    new Request("http://localhost/api/stripe/webhook", {
      method: "POST",
      body: JSON.stringify(completedEvent()),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.committed.length = 0;
  state.orderValues.length = 0;
  state.failOn = null;
  state.directUpdates.length = 0;
  process.env.STRIPE_WEBHOOK_DEV_BYPASS = "true";
  mockHeaders.mockResolvedValue(new Headers());
  vi.mocked(db.query.ordersTable.findFirst).mockResolvedValue(undefined as any);
  vi.mocked(db.query.artworksTable.findFirst).mockResolvedValue({
    id: "art-1",
    title: "Sunset",
    price: 12_000,
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

describe("checkout.session.completed transactional handling", () => {
  it("commits order, order item, and artwork SOLD in one transaction", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(state.committed).toEqual([
      "insert:orders",
      "insert:orderItems",
      "update:artworks",
    ]);
    expect(sendOrderConfirmation).toHaveBeenCalledTimes(1);
    expect(state.orderValues[0]).toMatchObject({
      freightMethodName: "Australia Post",
      freightClass: "MEDIUM",
      freightCents: 2500,
      totalCents: 12_000,
    });
  });

  it("rolls back everything and returns 500 when the order item insert fails", async () => {
    state.failOn = "insert:orderItems";
    const res = await post();
    expect(res.status).toBe(500); // Stripe will retry
    expect(state.committed).toEqual([]); // nothing committed
    expect(sendOrderConfirmation).not.toHaveBeenCalled();
  });

  it("rolls back everything and returns 500 when the artwork SOLD update fails", async () => {
    state.failOn = "update:artworks";
    const res = await post();
    expect(res.status).toBe(500);
    expect(state.committed).toEqual([]);
    expect(sendOrderConfirmation).not.toHaveBeenCalled();
  });

  it("is idempotent: a retried event for an existing order writes nothing", async () => {
    vi.mocked(db.query.ordersTable.findFirst).mockResolvedValue({
      id: "order-1",
    } as any);
    const res = await post();
    expect(res.status).toBe(200);
    expect(transactionSpy).not.toHaveBeenCalled();
    expect(state.committed).toEqual([]);
    expect(sendOrderConfirmation).not.toHaveBeenCalled();
  });

  it("still returns 200 when the confirmation email fails after commit", async () => {
    sendOrderConfirmation.mockRejectedValueOnce(new Error("smtp down"));
    const res = await post();
    expect(res.status).toBe(200);
    expect(state.committed).toEqual([
      "insert:orders",
      "insert:orderItems",
      "update:artworks",
    ]);
  });

  it("records emailSentAt when the confirmation email succeeds", async () => {
    sendOrderConfirmation.mockResolvedValueOnce(undefined);
    const res = await post();
    expect(res.status).toBe(200);
    const emailUpdate = state.directUpdates.find((u) => "emailSentAt" in u);
    expect(emailUpdate).toBeTruthy();
    expect(emailUpdate.emailSentAt).toBeInstanceOf(Date);
    expect(emailUpdate.emailError).toBeNull();
  });

  it("persists emailError (not just a log) when the confirmation email fails", async () => {
    sendOrderConfirmation.mockRejectedValueOnce(new Error("smtp down"));
    const res = await post();
    expect(res.status).toBe(200);
    const emailUpdate = state.directUpdates.find((u) => "emailError" in u);
    expect(emailUpdate).toBeTruthy();
    expect(emailUpdate.emailError).toContain("smtp down");
    expect(emailUpdate.emailSentAt).toBeUndefined();
  });
});
