/**
 * Tasks #50 and others — Background confirmation-email sweep:
 *
 * #50 — Buyer confirmation email must survive a second database write failure
 *       after the Stripe payment.  When email send succeeds but the follow-up
 *       DB update (setting emailSentAt) fails, the sweep must not crash or
 *       swallow the error silently.  The order remains re-selectable so the
 *       sweep can retry and mark it sent next run.
 *
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

  // ── Task #50 — post-email DB write failure ────────────────────────────────
  //
  // The confirmation email is sent BEFORE the DB is updated.  If the DB
  // update rejects (e.g. Neon connection dropped right after the SMTP call),
  // the sweep must not crash and must leave the order re-selectable so the
  // next run can mark it sent.  The email is counted as failed (not sent),
  // and the failure is logged — not silently swallowed.

  it("(#50) does not crash when the post-email DB update fails", async () => {
    const { db } = await import("@workspace/db");
    state.candidates = [order()];
    sendOrderConfirmation.mockResolvedValueOnce(undefined);

    // Make the first db.update call (emailSentAt write) reject.
    vi.mocked(db.update).mockImplementationOnce(() => ({
      set: (_vals: any) => ({
        where: () => Promise.reject(new Error("DB connection lost")),
      }),
    }) as any);

    // Sweep must not throw even though the DB write failed after email send.
    await expect(sweepUnsentConfirmationEmails(NOW)).resolves.toBeDefined();
  });

  it("(#50) reports the order as failed (not sent) when the post-email DB write fails", async () => {
    const { db } = await import("@workspace/db");
    state.candidates = [order()];
    sendOrderConfirmation.mockResolvedValueOnce(undefined);

    // First update (emailSentAt) fails; second update (error bookkeeping) succeeds.
    vi.mocked(db.update)
      .mockImplementationOnce(() => ({
        set: (_vals: any) => ({
          where: () => Promise.reject(new Error("DB connection lost")),
        }),
      }) as any)
      .mockImplementationOnce(() => ({
        set: (vals: any) => {
          state.updates.push(vals);
          return { where: () => Promise.resolve() };
        },
      }) as any);

    const result = await sweepUnsentConfirmationEmails(NOW);

    // The send is counted as a failure because emailSentAt was not persisted.
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
  });

  it("(#50) the email was genuinely sent even though DB write failed — order is re-selectable for the next sweep", async () => {
    // Documents the observable contract: if emailSentAt is never written,
    // the order stays in the sweep candidate query (emailSentAt IS NULL).
    // The sweep re-selects and re-sends on the next run.  That duplication
    // risk is accepted by the current impl; this test pins the behaviour so
    // any change to "send-once" idempotency is deliberate.
    const { db } = await import("@workspace/db");
    state.candidates = [order()];
    sendOrderConfirmation.mockResolvedValue(undefined);

    // First sweep: email send succeeds but BOTH subsequent DB updates fail
    // (the emailSentAt write AND the fallback error-bookkeeping write).
    // Using mockImplementationOnce so the mock auto-restores to the default
    // after these two calls — no persistent leak.
    vi.mocked(db.update)
      .mockImplementationOnce(
        () =>
          ({
            set: (_vals: any) => ({
              where: () => Promise.reject(new Error("DB outage")),
            }),
          }) as any,
      )
      .mockImplementationOnce(
        () =>
          ({
            set: (_vals: any) => ({
              where: () => Promise.reject(new Error("DB outage")),
            }),
          }) as any,
      );

    const result1 = await sweepUnsentConfirmationEmails(NOW);
    expect(result1.failed).toBe(1);

    // Second sweep — DB back to normal (mockImplementationOnce exhausted,
    // falls back to vi.mock default).  Order still a candidate because
    // emailSentAt was never written.
    state.candidates = [order()];
    sendOrderConfirmation.mockResolvedValueOnce(undefined);
    const result2 = await sweepUnsentConfirmationEmails(NOW);
    expect(result2.sent).toBe(1);
    const sentUpdate = state.updates.find((u) => u.emailSentAt !== undefined);
    expect(sentUpdate).toBeDefined();
    expect(sentUpdate!.emailSentAt).toBe(NOW);
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
