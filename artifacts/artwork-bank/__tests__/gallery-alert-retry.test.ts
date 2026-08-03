/**
 * Task #49 — Retry the gallery alert if it fails to send the first time.
 *
 * sweepUnsentGalleryAlerts is designed to be retryable: when the
 * sendConfirmationFailureNotice call throws on the first sweep, the function
 * leaves emailFailureNotifiedAt null so the order is re-selected on the NEXT
 * sweep run. When that second run succeeds, emailFailureNotifiedAt is stamped.
 *
 * This "two-pass retry" test explicitly exercises that path — the first sweep
 * sees a failure and writes nothing; the second sweep succeeds and marks the
 * order as notified.
 *
 * Covers:
 *  - First sweep: send throws → result counts 1 failed, emailFailureNotifiedAt stays null
 *  - Second sweep: send succeeds → result counts 1 sent, emailFailureNotifiedAt is set
 *  - The email function is called TWICE across both sweep runs (once per run)
 *  - The timestamp written on the successful second run matches the NOW passed in
 *  - Partial success across two orders: one permanently fails, one succeeds on retry
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const state = vi.hoisted(() => ({
  updates: [] as any[],
  candidates: [] as any[],
}));

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      ordersTable: {
        findMany: vi.fn(async () => state.candidates),
      },
      orderItemsTable: {
        findFirst: vi.fn(async () => ({
          orderId: "order-1",
          artworkTitle: "Blue Mountains",
        })),
      },
      tenantsTable: {
        findFirst: vi.fn(async () => ({
          id: "tenant-1",
          businessName: "Jane Smith Studio",
          contactEmail: "jane@janesmith.studio",
        })),
      },
    },
    update: vi.fn(() => ({
      set: (vals: any) => {
        state.updates.push(vals);
        return { where: () => Promise.resolve() };
      },
    })),
  },
  ordersTable: {
    id: "id",
    emailAttempts: "emailAttempts",
    emailFailureNotifiedAt: "emailFailureNotifiedAt",
    buyerEmail: "buyerEmail",
    tenantId: "tenantId",
  },
  orderItemsTable: { orderId: "orderId" },
  tenantsTable: { id: "id" },
}));

const sendConfirmationFailureNotice = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: vi.fn(),
  sendOrderStatusUpdate: vi.fn(),
  sendConfirmationFailureNotice: (...args: any[]) =>
    sendConfirmationFailureNotice(...args),
}));

vi.mock("@/lib/base-url", () => ({
  getTenantUrl: vi.fn(() => "https://jane-smith-studio.i-art.com.au/orders"),
}));

import { sweepUnsentGalleryAlerts, MAX_EMAIL_ATTEMPTS } from "@/lib/email-sweep";

const NOW = new Date("2026-08-03T10:00:00Z");
const LATER = new Date("2026-08-03T10:05:00Z");

function exhaustedOrder(overrides: Record<string, any> = {}) {
  return {
    id: "order-1",
    tenantId: "tenant-1",
    buyerEmail: "buyer@example.com",
    buyerName: "Art Buyer",
    emailAttempts: MAX_EMAIL_ATTEMPTS,
    emailFailureNotifiedAt: null,
    emailError: "smtp timeout",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.updates.length = 0;
  state.candidates = [];
});

describe("sweepUnsentGalleryAlerts — two-pass retry (Task #49)", () => {
  it("first sweep: send throws → failed count=1, emailFailureNotifiedAt stays null", async () => {
    state.candidates = [exhaustedOrder()];
    sendConfirmationFailureNotice.mockRejectedValueOnce(new Error("SMTP timeout"));

    const result = await sweepUnsentGalleryAlerts(NOW);

    // First run: 1 failed, 0 sent
    expect(result).toEqual({ scanned: 1, sent: 0, failed: 1, skipped: 0 });

    // emailFailureNotifiedAt was NOT written — order stays selectable for next sweep
    const notifiedUpdate = state.updates.find((u) => u.emailFailureNotifiedAt);
    expect(notifiedUpdate).toBeUndefined();
  });

  it("second sweep: send succeeds → sent count=1, emailFailureNotifiedAt is stamped", async () => {
    // Second sweep: same candidate is still visible (emailFailureNotifiedAt=null)
    state.candidates = [exhaustedOrder()];
    sendConfirmationFailureNotice.mockResolvedValueOnce(undefined);

    const result = await sweepUnsentGalleryAlerts(LATER);

    expect(result).toEqual({ scanned: 1, sent: 1, failed: 0, skipped: 0 });

    // emailFailureNotifiedAt was written with the sweep timestamp
    const notifiedUpdate = state.updates.find((u) => u.emailFailureNotifiedAt);
    expect(notifiedUpdate?.emailFailureNotifiedAt).toEqual(LATER);
  });

  it("email function is called once per sweep run across both passes", async () => {
    // Pass 1: fails
    state.candidates = [exhaustedOrder()];
    sendConfirmationFailureNotice.mockRejectedValueOnce(new Error("Timeout"));
    await sweepUnsentGalleryAlerts(NOW);
    expect(sendConfirmationFailureNotice).toHaveBeenCalledTimes(1);

    // Reset for pass 2
    vi.clearAllMocks();
    state.updates.length = 0;
    state.candidates = [exhaustedOrder()];
    sendConfirmationFailureNotice.mockResolvedValueOnce(undefined);
    await sweepUnsentGalleryAlerts(LATER);
    expect(sendConfirmationFailureNotice).toHaveBeenCalledTimes(1);
  });

  it("handles two orders: one permanently fails, the other succeeds on retry", async () => {
    state.candidates = [
      exhaustedOrder({ id: "order-A" }),
      exhaustedOrder({ id: "order-B", emailError: "DNS failure" }),
    ];
    // order-A fails, order-B succeeds
    sendConfirmationFailureNotice
      .mockRejectedValueOnce(new Error("SMTP refused"))
      .mockResolvedValueOnce(undefined);

    const result = await sweepUnsentGalleryAlerts(NOW);

    expect(result).toEqual({ scanned: 2, sent: 1, failed: 1, skipped: 0 });

    // Only order-B has emailFailureNotifiedAt written
    const notifiedUpdates = state.updates.filter((u) => u.emailFailureNotifiedAt);
    expect(notifiedUpdates).toHaveLength(1);
    expect(notifiedUpdates[0]?.emailFailureNotifiedAt).toEqual(NOW);
  });

  it("the successful second-pass timestamp matches the NOW passed to the sweep", async () => {
    const CUSTOM_NOW = new Date("2026-08-04T08:30:00Z");
    state.candidates = [exhaustedOrder()];
    sendConfirmationFailureNotice.mockResolvedValueOnce(undefined);

    await sweepUnsentGalleryAlerts(CUSTOM_NOW);

    const notifiedUpdate = state.updates.find((u) => u.emailFailureNotifiedAt);
    expect(notifiedUpdate?.emailFailureNotifiedAt).toEqual(CUSTOM_NOW);
  });
});
