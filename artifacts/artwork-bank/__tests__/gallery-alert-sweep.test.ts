/**
 * Tests for sweepUnsentGalleryAlerts: retries the gallery failure-notification
 * for orders whose buyer confirmation email has exhausted all retries but the
 * gallery has not yet been notified (emailFailureNotifiedAt IS NULL).
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

describe("sweepUnsentGalleryAlerts", () => {
  it("returns empty result when there are no exhausted orders", async () => {
    state.candidates = [];
    const result = await sweepUnsentGalleryAlerts(NOW);
    expect(result).toEqual({ scanned: 0, sent: 0, failed: 0, skipped: 0 });
    expect(sendConfirmationFailureNotice).not.toHaveBeenCalled();
  });

  it("sends the gallery alert and marks emailFailureNotifiedAt", async () => {
    state.candidates = [exhaustedOrder()];
    sendConfirmationFailureNotice.mockResolvedValueOnce(undefined);

    const result = await sweepUnsentGalleryAlerts(NOW);

    expect(result).toEqual({ scanned: 1, sent: 1, failed: 0, skipped: 0 });
    expect(sendConfirmationFailureNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        galleryEmail: "jane@janesmith.studio",
        buyerEmail: "buyer@example.com",
        artworkTitle: "Blue Mountains",
        orderRef: "ORDER-1",
        tenantName: "Jane Smith Studio",
        lastError: "smtp timeout",
      }),
    );
    expect(state.updates).toEqual([
      expect.objectContaining({ emailFailureNotifiedAt: NOW }),
    ]);
  });

  it("counts as failed and leaves emailFailureNotifiedAt unset when the send throws", async () => {
    state.candidates = [exhaustedOrder()];
    sendConfirmationFailureNotice.mockRejectedValueOnce(
      new Error("SMTP connection refused"),
    );

    const result = await sweepUnsentGalleryAlerts(NOW);

    expect(result).toEqual({ scanned: 1, sent: 0, failed: 1, skipped: 0 });
    // No update should set emailFailureNotifiedAt — so it stays null and will
    // be retried on the next sweep run.
    expect(state.updates).toHaveLength(0);
  });

  it("skips (and marks done) orders whose tenant has no contactEmail", async () => {
    state.candidates = [exhaustedOrder()];
    // Override the tenant mock to return no contactEmail
    const { db } = await import("@workspace/db");
    (db.query.tenantsTable.findFirst as any).mockResolvedValueOnce({
      id: "tenant-1",
      businessName: "Silent Gallery",
      contactEmail: null,
    });

    const result = await sweepUnsentGalleryAlerts(NOW);

    expect(result).toEqual({ scanned: 1, sent: 0, failed: 0, skipped: 1 });
    expect(sendConfirmationFailureNotice).not.toHaveBeenCalled();
    // Should still mark emailFailureNotifiedAt so the order isn't re-selected.
    expect(state.updates).toEqual([
      expect.objectContaining({ emailFailureNotifiedAt: NOW }),
    ]);
  });

  it("handles multiple orders in one pass", async () => {
    state.candidates = [
      exhaustedOrder({ id: "order-1" }),
      exhaustedOrder({ id: "order-2", emailError: "DNS error" }),
    ];
    sendConfirmationFailureNotice.mockResolvedValue(undefined);

    const result = await sweepUnsentGalleryAlerts(NOW);

    expect(result).toEqual({ scanned: 2, sent: 2, failed: 0, skipped: 0 });
    expect(sendConfirmationFailureNotice).toHaveBeenCalledTimes(2);
    expect(state.updates).toHaveLength(2);
  });

  it("continues processing remaining orders when one send fails", async () => {
    state.candidates = [
      exhaustedOrder({ id: "order-1" }),
      exhaustedOrder({ id: "order-2" }),
    ];
    sendConfirmationFailureNotice
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(undefined);

    const result = await sweepUnsentGalleryAlerts(NOW);

    expect(result).toEqual({ scanned: 2, sent: 1, failed: 1, skipped: 0 });
  });
});
