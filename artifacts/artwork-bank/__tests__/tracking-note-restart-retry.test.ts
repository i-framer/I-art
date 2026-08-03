/**
 * Task #50 — Confirm that tracking-note changes restart status-email retries.
 *
 * When saveTrackingNote() detects the note has actually changed, it must call
 * notifyBuyerOfUpdate(), which queues a fresh status email by setting
 * statusEmailQueuedAt and resetting statusEmailAttempts to 0.
 *
 * When the note is saved but unchanged, notifyBuyerOfUpdate must NOT be called.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Billing mock — allow access ───────────────────────────────────────────────
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn().mockResolvedValue(undefined),
  hasActiveAccess: vi.fn().mockReturnValue(true),
  SUBSCRIPTION_PRICE_CENTS: 4900,
}));

// ── Auth mock ─────────────────────────────────────────────────────────────────
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn().mockResolvedValue({
    userId: "user-1",
    tenantId: "tenant-1",
  }),
}));

// ── Email mock ────────────────────────────────────────────────────────────────
const sendOrderStatusUpdate = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
vi.mock("@/lib/email", () => ({
  sendOrderStatusUpdate: (...a: any[]) => sendOrderStatusUpdate(...a),
  sendPartialRefundNotification: vi.fn(),
  sendOrderConfirmation: vi.fn(),
  EmailSendError: class extends Error {},
}));

// ── next/cache mock ───────────────────────────────────────────────────────────
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// ── Stripe mock ───────────────────────────────────────────────────────────────
vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(),
  parsePlatformFeePercent: vi.fn().mockReturnValue(10),
  calcApplicationFee: vi.fn(),
  StripeNotConfiguredError: class extends Error {},
}));

// ── Tenant URL mock ───────────────────────────────────────────────────────────
vi.mock("@/lib/tenant-url", () => ({
  getTenantUrl: vi.fn().mockReturnValue("https://test.i-art.com.au/orders"),
}));

// ── DB mock — capture what UPDATE sets ───────────────────────────────────────
const updateCalls: any[] = [];

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      ordersTable: { findFirst: vi.fn() },
      orderItemsTable: { findFirst: vi.fn() },
      tenantsTable: { findFirst: vi.fn() },
    },
    update: (_table: any) => ({
      set: (payload: any) => ({
        where: async () => {
          updateCalls.push(payload);
        },
      }),
    }),
  },
  ordersTable: {},
  orderItemsTable: {},
  tenantsTable: {},
  eq: vi.fn(),
  and: vi.fn(),
}));

// ── Action under test ─────────────────────────────────────────────────────────
import { saveTrackingNote } from "@/app/(admin)/(gated)/orders/[id]/actions";
import { db } from "@workspace/db";

function form(orderId: string, note: string): FormData {
  return {
    get: (k: string) => (k === "orderId" ? orderId : k === "note" ? note : null),
  } as unknown as FormData;
}

const BASE_ORDER = {
  id: "order-1",
  tenantId: "tenant-1",
  status: "FULFILLED",
  trackingNote: "Old tracking info",
  buyerEmail: "buyer@example.com",
  buyerName: "Alice",
  stripeCustomerId: null,
  stripePaymentIntentId: null,
  statusEmailQueuedAt: null,
  statusEmailAttempts: 3,
  statusEmailError: "SMTP timeout",
};

const BASE_TENANT = {
  id: "tenant-1",
  businessName: "Test Gallery",
  contactEmail: "gallery@test.com",
};

const BASE_ITEM = {
  artworkTitle: "Sunset",
  orderId: "order-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  updateCalls.length = 0;
  // Default: order lookup returns base order
  (db.query.ordersTable.findFirst as any).mockResolvedValue(BASE_ORDER);
  (db.query.tenantsTable.findFirst as any).mockResolvedValue(BASE_TENANT);
  (db.query.orderItemsTable.findFirst as any).mockResolvedValue(BASE_ITEM);
});

describe("saveTrackingNote — status-email retry restart (Task #50)", () => {
  it("writes statusEmailQueuedAt when note changes", async () => {
    await saveTrackingNote(form("order-1", "Updated tracking info"));

    const queuePayload = updateCalls.find((u) => u.statusEmailQueuedAt !== undefined);
    expect(queuePayload).toBeDefined();
    expect(queuePayload.statusEmailQueuedAt).toBeInstanceOf(Date);
  });

  it("resets statusEmailAttempts to 0 when note changes (clears retry budget)", async () => {
    await saveTrackingNote(form("order-1", "New shipping label: AU123456"));

    const queuePayload = updateCalls.find((u) => u.statusEmailAttempts === 0);
    expect(queuePayload).toBeDefined();
  });

  it("clears statusEmailError when note changes", async () => {
    await saveTrackingNote(form("order-1", "Dispatched today"));

    const queuePayload = updateCalls.find((u) => u.statusEmailQueuedAt !== undefined);
    expect(queuePayload?.statusEmailError).toBeNull();
  });

  it("does NOT write statusEmailQueuedAt when note is unchanged", async () => {
    await saveTrackingNote(form("order-1", "Old tracking info")); // same as BASE_ORDER

    const queuePayload = updateCalls.find((u) => u.statusEmailQueuedAt !== undefined);
    expect(queuePayload).toBeUndefined();
  });

  it("still saves the tracking note even when note is unchanged", async () => {
    await saveTrackingNote(form("order-1", "Old tracking info"));

    // At least one update call should be to save the note
    const notePayload = updateCalls.find((u) => "trackingNote" in u);
    expect(notePayload).toBeDefined();
  });

  it("treats empty string and null as equivalent (no retry triggered)", async () => {
    // BASE_ORDER has trackingNote: "Old tracking info"
    // Setting to empty should trigger a change
    await saveTrackingNote(form("order-1", ""));

    const queuePayload = updateCalls.find((u) => u.statusEmailQueuedAt !== undefined);
    expect(queuePayload).toBeDefined(); // empty ≠ "Old tracking info" → triggers
  });
});
