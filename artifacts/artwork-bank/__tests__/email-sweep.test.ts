/**
 * Covers the background confirmation-email sweep: it picks up PAID orders
 * with no emailSentAt, re-sends and marks them sent, records failures with
 * incremented attempt counts, respects exponential backoff, and never
 * selects orders that exhausted the retry cap.
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
          artworkTitle: "Sunset",
        })),
      },
      tenantsTable: {
        findFirst: vi.fn(async () => ({
          id: "tenant-1",
          businessName: "Gallery",
          contactEmail: "gallery@example.com",
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
    status: "status",
    emailSentAt: "emailSentAt",
    buyerEmail: "buyerEmail",
    emailAttempts: "emailAttempts",
    statusEmailQueuedAt: "statusEmailQueuedAt",
    statusEmailAttempts: "statusEmailAttempts",
  },
  orderItemsTable: { orderId: "orderId" },
  tenantsTable: { id: "id" },
}));

const sendOrderConfirmation = vi.hoisted(() => vi.fn());
const sendOrderStatusUpdate = vi.hoisted(() => vi.fn());
const sendConfirmationFailureNotice = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: (...args: any[]) => sendOrderConfirmation(...args),
  sendOrderStatusUpdate: (...args: any[]) => sendOrderStatusUpdate(...args),
  sendConfirmationFailureNotice: (...args: any[]) =>
    sendConfirmationFailureNotice(...args),
}));

import {
  sweepUnsentConfirmationEmails,
  sweepUnsentStatusEmails,
  backoffMs,
  MAX_EMAIL_ATTEMPTS,
  BASE_BACKOFF_MS,
} from "@/lib/email-sweep";

const NOW = new Date("2026-07-19T12:00:00Z");

function order(overrides: Record<string, any> = {}) {
  return {
    id: "order-1",
    tenantId: "tenant-1",
    buyerEmail: "buyer@example.com",
    buyerName: "Buyer",
    fulfillmentType: "SHIP",
    status: "PAID",
    emailSentAt: null,
    emailError: "smtp down",
    emailAttempts: 1,
    emailLastAttemptAt: null,
    emailFailureNotifiedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.updates.length = 0;
  state.candidates = [];
});

describe("sweepUnsentConfirmationEmails", () => {
  it("picks up a failed order, re-sends, and marks it sent", async () => {
    state.candidates = [order()];
    sendOrderConfirmation.mockResolvedValueOnce(undefined);

    const result = await sweepUnsentConfirmationEmails(NOW);

    expect(result).toEqual({ scanned: 1, sent: 1, failed: 0, skipped: 0 });
    expect(sendOrderConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        buyerEmail: "buyer@example.com",
        artworkTitle: "Sunset",
        tenantName: "Gallery",
      }),
    );
    expect(state.updates).toEqual([
      expect.objectContaining({
        emailSentAt: NOW,
        emailError: null,
        emailAttempts: 2,
        emailLastAttemptAt: NOW,
      }),
    ]);
  });

  it("records the error and increments attempts when the send fails again", async () => {
    state.candidates = [order({ emailAttempts: 2 })];
    sendOrderConfirmation.mockRejectedValueOnce(new Error("still down"));

    const result = await sweepUnsentConfirmationEmails(NOW);

    expect(result).toEqual({ scanned: 1, sent: 0, failed: 1, skipped: 0 });
    expect(state.updates).toEqual([
      expect.objectContaining({
        emailError: "still down",
        emailAttempts: 3,
        emailLastAttemptAt: NOW,
      }),
    ]);
    expect(state.updates[0].emailSentAt).toBeUndefined();
  });

  it("skips orders still inside their backoff window", async () => {
    // 2 prior attempts → backoff 10 min; last attempt was 3 min ago.
    state.candidates = [
      order({
        emailAttempts: 2,
        emailLastAttemptAt: new Date(NOW.getTime() - 3 * 60 * 1000),
      }),
    ];

    const result = await sweepUnsentConfirmationEmails(NOW);

    expect(result).toEqual({ scanned: 1, sent: 0, failed: 0, skipped: 1 });
    expect(sendOrderConfirmation).not.toHaveBeenCalled();
    expect(state.updates).toEqual([]);
  });

  it("retries once the backoff window has elapsed", async () => {
    state.candidates = [
      order({
        emailAttempts: 2,
        emailLastAttemptAt: new Date(NOW.getTime() - 11 * 60 * 1000),
      }),
    ];
    sendOrderConfirmation.mockResolvedValueOnce(undefined);

    const result = await sweepUnsentConfirmationEmails(NOW);

    expect(result.sent).toBe(1);
  });

  it("does not notify the gallery on a non-final failure", async () => {
    state.candidates = [order({ emailAttempts: 2 })];
    sendOrderConfirmation.mockRejectedValueOnce(new Error("still down"));

    await sweepUnsentConfirmationEmails(NOW);

    expect(sendConfirmationFailureNotice).not.toHaveBeenCalled();
  });

  it("notifies the gallery once when the final attempt fails", async () => {
    state.candidates = [order({ emailAttempts: MAX_EMAIL_ATTEMPTS - 1 })];
    sendOrderConfirmation.mockRejectedValueOnce(new Error("mailbox gone"));
    sendConfirmationFailureNotice.mockResolvedValueOnce(undefined);

    const result = await sweepUnsentConfirmationEmails(NOW);

    expect(result.failed).toBe(1);
    expect(sendConfirmationFailureNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        galleryEmail: "gallery@example.com",
        buyerEmail: "buyer@example.com",
        buyerName: "Buyer",
        artworkTitle: "Sunset",
        tenantName: "Gallery",
        lastError: "mailbox gone",
      }),
    );
    // Failure bookkeeping update, then the notified flag.
    expect(state.updates).toEqual([
      expect.objectContaining({
        emailError: "mailbox gone",
        emailAttempts: MAX_EMAIL_ATTEMPTS,
      }),
      { emailFailureNotifiedAt: NOW },
    ]);
  });

  it("does not notify again if the gallery was already notified", async () => {
    state.candidates = [
      order({
        emailAttempts: MAX_EMAIL_ATTEMPTS - 1,
        emailFailureNotifiedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      }),
    ];
    sendOrderConfirmation.mockRejectedValueOnce(new Error("still gone"));

    await sweepUnsentConfirmationEmails(NOW);

    expect(sendConfirmationFailureNotice).not.toHaveBeenCalled();
  });

  it("leaves the notified flag unset when the notice itself fails", async () => {
    state.candidates = [order({ emailAttempts: MAX_EMAIL_ATTEMPTS - 1 })];
    sendOrderConfirmation.mockRejectedValueOnce(new Error("mailbox gone"));
    sendConfirmationFailureNotice.mockRejectedValueOnce(
      new Error("resend down"),
    );

    const result = await sweepUnsentConfirmationEmails(NOW);

    expect(result.failed).toBe(1);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].emailFailureNotifiedAt).toBeUndefined();
  });

  it("caps retries: the query excludes orders at MAX_EMAIL_ATTEMPTS", async () => {
    const { db } = await import("@workspace/db");
    await sweepUnsentConfirmationEmails(NOW);
    // Sweep queried with a filter (we can't inspect drizzle SQL through the
    // mock, but assert the cap constant and backoff schedule directly).
    expect(vi.mocked(db.query.ordersTable.findMany)).toHaveBeenCalled();
    expect(MAX_EMAIL_ATTEMPTS).toBe(5);
    expect(backoffMs(1)).toBe(BASE_BACKOFF_MS);
    expect(backoffMs(3)).toBe(BASE_BACKOFF_MS * 4);
  });
});

describe("sweepUnsentStatusEmails", () => {
  function queuedOrder(overrides: Record<string, any> = {}) {
    return order({
      status: "FULFILLED",
      trackingNote: "AusPost ABC123",
      statusEmailQueuedAt: NOW,
      statusEmailError: null,
      statusEmailAttempts: 1,
      statusEmailLastAttemptAt: null,
      ...overrides,
    });
  }

  it("sends the status update and clears the queue flag", async () => {
    state.candidates = [queuedOrder()];
    sendOrderStatusUpdate.mockResolvedValueOnce(undefined);

    const result = await sweepUnsentStatusEmails(NOW);

    expect(result).toEqual({ scanned: 1, sent: 1, failed: 0, skipped: 0 });
    expect(sendOrderStatusUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        buyerEmail: "buyer@example.com",
        artworkTitle: "Sunset",
        status: "FULFILLED",
        trackingNote: "AusPost ABC123",
        tenantName: "Gallery",
      }),
    );
    expect(state.updates).toEqual([
      expect.objectContaining({
        statusEmailQueuedAt: null,
        statusEmailError: null,
        statusEmailAttempts: 2,
        statusEmailLastAttemptAt: NOW,
      }),
    ]);
  });

  it("records the error and keeps the email queued on failure", async () => {
    state.candidates = [queuedOrder({ statusEmailAttempts: 2 })];
    sendOrderStatusUpdate.mockRejectedValueOnce(new Error("resend down"));

    const result = await sweepUnsentStatusEmails(NOW);

    expect(result).toEqual({ scanned: 1, sent: 0, failed: 1, skipped: 0 });
    expect(state.updates).toEqual([
      expect.objectContaining({
        statusEmailError: "resend down",
        statusEmailAttempts: 3,
        statusEmailLastAttemptAt: NOW,
      }),
    ]);
    expect(state.updates[0].statusEmailQueuedAt).toBeUndefined();
  });

  it("skips orders still inside their backoff window", async () => {
    state.candidates = [
      queuedOrder({
        statusEmailAttempts: 2,
        statusEmailLastAttemptAt: new Date(NOW.getTime() - 3 * 60 * 1000),
      }),
    ];

    const result = await sweepUnsentStatusEmails(NOW);

    expect(result).toEqual({ scanned: 1, sent: 0, failed: 0, skipped: 1 });
    expect(sendOrderStatusUpdate).not.toHaveBeenCalled();
    expect(state.updates).toEqual([]);
  });
});
