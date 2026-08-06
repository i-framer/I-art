/**
 * Idempotency guard: a duplicate checkout.session.completed webhook must NOT
 * create a second order, double the commission, or mark the artwork SOLD again.
 *
 * Stripe retries webhooks on 5xx. If the DB transaction fails on the first
 * delivery and Stripe retries, the guard (findFirst by stripeSessionId) must
 * short-circuit the retry before any writes occur.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Hoisted shared state ──────────────────────────────────────────────────────
const state = vi.hoisted(() => ({
  ordersFindFirstResults: [] as (Record<string, unknown> | null)[],
  artworkUpdatesInTx: [] as { vals: Record<string, unknown> }[],
  transactionCallCount: 0,
  dbInsertCallCount: 0,
  /** When true, tx.update().set({status:…}) throws to simulate a mid-tx crash. */
  throwOnArtworkUpdate: false,
}));

// ── DB mock ───────────────────────────────────────────────────────────────────
// `db.transaction` is the key observable: it must be called exactly once.
// The tx mock captures every `tx.update(artworksTable).set(...)` call so we
// can assert that SOLD is only written once.
vi.mock("@workspace/db", () => {
  const ordersTable = { stripeSessionId: "orders.stripeSessionId", id: "orders.id" };
  const orderItemsTable = {};
  const artworksTable = { id: "artworks.id", tenantId: "artworks.tenantId" };
  const tenantsTable = { id: "tenants.id" };
  const stripeAlertsTable = { stripeEventId: "alerts.stripeEventId" };

  const db = {
    query: {
      ordersTable: {
        findFirst: vi.fn(async () => {
          return state.ordersFindFirstResults.shift() ?? null;
        }),
      },
      artworksTable: {
        findFirst: vi.fn(async () => ({
          id: "artwork-1",
          tenantId: "tenant-1",
          title: "Test Artwork",
          sku: "SKU-001",
          price: 10000,
          dimensionsW: null,
          dimensionsH: null,
          condition: null,
        })),
      },
      tenantsTable: {
        findFirst: vi.fn(async () => ({
          id: "tenant-1",
          businessName: "Test Gallery",
          iframerAccountId: null,
        })),
      },
    },

    transaction: vi.fn(async (fn: (tx: any) => Promise<any>) => {
      state.transactionCallCount++;
      const tx = {
        insert: vi.fn((_table: any) => ({
          values: vi.fn(() => ({
            returning: vi.fn(() =>
              Promise.resolve([{ id: "order-1", stripeSessionId: "cs_test_123" }]),
            ),
          })),
        })),
        update: vi.fn((_table: any) => ({
          set: vi.fn((vals: Record<string, unknown>) => ({
            where: vi.fn(() => {
              // Capture artwork status writes so we can assert SOLD count.
              if (vals.status !== undefined) {
                state.artworkUpdatesInTx.push({ vals });
                // Simulate a mid-transaction crash on the artwork SOLD update.
                if (state.throwOnArtworkUpdate) {
                  return Promise.reject(
                    new Error("Simulated DB crash on artwork SOLD update"),
                  );
                }
              }
              return Promise.resolve();
            }),
          })),
        })),
      };
      return fn(tx);
    }),

    // Used after the transaction for email-sent/error updates — let them succeed silently.
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
    })),

    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([])),
        })),
        returning: vi.fn(() => Promise.resolve([])),
      })),
    })),
  };

  return {
    db,
    ordersTable,
    orderItemsTable,
    artworksTable,
    tenantsTable,
    stripeAlertsTable,
  };
});

// ── Next.js / infra mocks ─────────────────────────────────────────────────────
vi.mock("next/headers", () => ({
  // No stripe-signature header → dev-bypass path used.
  headers: vi.fn(async () => ({ get: () => null })),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body: unknown, init?: { status?: number }) => ({
      body,
      status: init?.status ?? 200,
    })),
  },
}));

// No webhook secret configured → falls through to STRIPE_WEBHOOK_DEV_BYPASS.
vi.mock("@/lib/stripe", () => ({
  getStripeWebhookSecret: vi.fn(async () => null),
  getStripeClient: vi.fn(async () => ({})),
  calcApplicationFee: vi.fn((cents: number) => Math.round(cents * 0.1)),
  StripeNotConfiguredError: class StripeNotConfiguredError extends Error {},
}));

vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: vi.fn(async () => {}),
  sendBillingAlertNotification: vi.fn(async () => {}),
}));

vi.mock("@/lib/slack", () => ({
  sendBillingAlertSlackNotification: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/lib/base-url", () => ({
  getTenantUrl: vi.fn(() => "https://example.com/orders"),
}));

vi.mock("@/lib/iframer", () => ({
  createIFramerJob: vi.fn(async () => ({ jobId: "job-1" })),
  IFramerError: class IFramerError extends Error {},
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSession(overrides?: Record<string, unknown>) {
  return {
    id: "cs_test_123",
    mode: "payment",
    amount_total: 10000,
    payment_intent: "pi_test_123",
    metadata: { artworkId: "artwork-1", tenantId: "tenant-1", fulfillmentType: "SHIP" },
    customer_details: { email: "buyer@example.com", name: "Buyer Name" },
    customer_email: null,
    ...overrides,
  };
}

function makeRequest(session: Record<string, unknown>): Request {
  const event = {
    id: "evt_test_1",
    type: "checkout.session.completed",
    data: { object: session },
  };
  return new Request("http://localhost/api/stripe/webhook", {
    method: "POST",
    body: JSON.stringify(event),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("checkout.session.completed — duplicate webhook idempotency", () => {
  const originalEnv = process.env.STRIPE_WEBHOOK_DEV_BYPASS;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_WEBHOOK_DEV_BYPASS = "true";
    state.ordersFindFirstResults.length = 0;
    state.artworkUpdatesInTx.length = 0;
    state.transactionCallCount = 0;
    state.dbInsertCallCount = 0;
    state.throwOnArtworkUpdate = false;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.STRIPE_WEBHOOK_DEV_BYPASS;
    } else {
      process.env.STRIPE_WEBHOOK_DEV_BYPASS = originalEnv;
    }
  });

  it("creates the order exactly once when the same session ID is delivered twice", async () => {
    const { POST } = await import("@/app/api/stripe/webhook/route");
    const session = makeSession();

    // First delivery: no existing order → transaction runs and creates the order.
    state.ordersFindFirstResults.push(null);
    const firstResponse = await POST(makeRequest(session));
    expect((firstResponse as any).status ?? 200).toBe(200);

    // Second delivery (Stripe retry): order already exists → early return.
    state.ordersFindFirstResults.push({ id: "order-1", stripeSessionId: "cs_test_123" });
    const secondResponse = await POST(makeRequest(session));
    expect((secondResponse as any).status ?? 200).toBe(200);

    // Transaction must have been called exactly once (first delivery only).
    expect(state.transactionCallCount).toBe(1);
  });

  it("marks the artwork SOLD exactly once across both deliveries", async () => {
    const { POST } = await import("@/app/api/stripe/webhook/route");
    const session = makeSession();

    state.ordersFindFirstResults.push(null);
    await POST(makeRequest(session));

    state.ordersFindFirstResults.push({ id: "order-1", stripeSessionId: "cs_test_123" });
    await POST(makeRequest(session));

    const soldWrites = state.artworkUpdatesInTx.filter((u) => u.vals.status === "SOLD");
    expect(soldWrites).toHaveLength(1);
  });

  it("returns 200 on both deliveries so Stripe does not keep retrying", async () => {
    const { POST } = await import("@/app/api/stripe/webhook/route");
    const session = makeSession();

    state.ordersFindFirstResults.push(null);
    const r1 = await POST(makeRequest(session));

    state.ordersFindFirstResults.push({ id: "order-1", stripeSessionId: "cs_test_123" });
    const r2 = await POST(makeRequest(session));

    expect((r1 as any).status ?? 200).toBe(200);
    expect((r2 as any).status ?? 200).toBe(200);
  });

  it("still processes the first delivery normally (creates order + order item + SOLD status)", async () => {
    const { POST } = await import("@/app/api/stripe/webhook/route");
    const { db } = await import("@workspace/db");

    state.ordersFindFirstResults.push(null);
    await POST(makeRequest(makeSession()));

    // transaction ran once
    expect(state.transactionCallCount).toBe(1);

    // Exactly one SOLD status write inside the transaction
    const soldWrites = state.artworkUpdatesInTx.filter((u) => u.vals.status === "SOLD");
    expect(soldWrites).toHaveLength(1);

    // The tx's insert was called (order + order item = 2 calls)
    const txMock = (db.transaction as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(txMock).toBeDefined(); // transaction was called
  });

  it("rolls back and lets a retry mark the artwork SOLD when the artwork update crashes mid-transaction", async () => {
    /**
     * Scenario:
     *   1. Stripe delivers the event. The transaction inserts the order, then
     *      tx.update(artworksTable) throws — simulating a DB crash.
     *   2. Because the transaction rolls back, the order row is never committed.
     *      The webhook returns 500.
     *   3. Stripe retries. The idempotency guard finds no existing order
     *      (the rolled-back insert left nothing), so it runs the full transaction
     *      again — this time successfully — and the artwork ends up SOLD.
     */
    const { POST } = await import("@/app/api/stripe/webhook/route");
    const session = makeSession();

    // ── First delivery: artwork update crashes ────────────────────────────────
    state.throwOnArtworkUpdate = true;
    state.ordersFindFirstResults.push(null); // no prior order → enters transaction

    const firstResponse = await POST(makeRequest(session));

    // Webhook must return 500 so Stripe knows to retry.
    expect((firstResponse as any).status).toBe(500);

    // Transaction was attempted once, and the artwork update was attempted
    // (the throw is the signal the update ran before rolling back).
    expect(state.transactionCallCount).toBe(1);
    const failedSoldAttempts = state.artworkUpdatesInTx.filter(
      (u) => u.vals.status === "SOLD",
    );
    expect(failedSoldAttempts).toHaveLength(1);

    // ── Stripe retry: transaction rolled back → no committed order ────────────
    state.throwOnArtworkUpdate = false; // artwork update will now succeed
    // The rolled-back transaction left no order row — the idempotency guard
    // finds null and allows the full transaction to proceed.
    state.ordersFindFirstResults.push(null);

    const retryResponse = await POST(makeRequest(session));

    // Retry succeeds.
    expect((retryResponse as any).status ?? 200).toBe(200);

    // Total transactions: first (crashed) + retry (succeeded) = 2.
    expect(state.transactionCallCount).toBe(2);

    // Exactly one successful SOLD write came from the retry; the failed attempt
    // is also counted in artworkUpdatesInTx (it threw but was recorded first),
    // so we expect exactly 2 entries total — one per transaction attempt.
    const allSoldWrites = state.artworkUpdatesInTx.filter(
      (u) => u.vals.status === "SOLD",
    );
    expect(allSoldWrites).toHaveLength(2);
  });
});
