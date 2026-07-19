/**
 * Covers the failed-then-retried confirmation email path: after a webhook
 * records emailError, the admin "Resend confirmation email" action re-sends
 * and clears the error / sets emailSentAt on success, or re-records the
 * error on another failure.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const state = vi.hoisted(() => ({
  updates: [] as any[],
}));

const tables = vi.hoisted(() => ({
  ordersTable: { id: "id", tenantId: "tenantId" },
  orderItemsTable: { orderId: "orderId" },
  tenantsTable: { id: "id" },
}));

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      ordersTable: { findFirst: vi.fn() },
      orderItemsTable: { findFirst: vi.fn() },
      tenantsTable: { findFirst: vi.fn() },
    },
    update: vi.fn(() => ({
      set: (vals: any) => {
        state.updates.push(vals);
        return { where: () => Promise.resolve() };
      },
    })),
  },
  ...tables,
}));

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn().mockResolvedValue({ userId: "u1", tenantId: "tenant-1" }),
}));

const sendOrderConfirmation = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: (...args: any[]) => sendOrderConfirmation(...args),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import { db } from "@workspace/db";
import { resendConfirmationEmail } from "@/app/(admin)/orders/[id]/actions";

function form() {
  const fd = new FormData();
  fd.set("orderId", "order-1");
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.updates.length = 0;
  vi.mocked(db.query.ordersTable.findFirst).mockResolvedValue({
    id: "order-1",
    tenantId: "tenant-1",
    buyerEmail: "buyer@example.com",
    buyerName: "Buyer",
    fulfillmentType: "SHIP",
    emailError: "smtp down",
    emailSentAt: null,
  } as any);
  vi.mocked(db.query.orderItemsTable.findFirst).mockResolvedValue({
    orderId: "order-1",
    artworkTitle: "Sunset",
  } as any);
  vi.mocked(db.query.tenantsTable.findFirst).mockResolvedValue({
    id: "tenant-1",
    businessName: "Gallery",
  } as any);
});

describe("resendConfirmationEmail (retry after failed webhook send)", () => {
  it("re-sends and records emailSentAt, clearing the previous error", async () => {
    sendOrderConfirmation.mockResolvedValueOnce(undefined);
    await resendConfirmationEmail(form());

    expect(sendOrderConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        buyerEmail: "buyer@example.com",
        artworkTitle: "Sunset",
        tenantName: "Gallery",
      }),
    );
    const update = state.updates.find((u) => "emailSentAt" in u);
    expect(update).toBeTruthy();
    expect(update.emailSentAt).toBeInstanceOf(Date);
    expect(update.emailError).toBeNull();
  });

  it("records a fresh emailError when the retry fails again", async () => {
    sendOrderConfirmation.mockRejectedValueOnce(new Error("still down"));
    await resendConfirmationEmail(form());

    const update = state.updates.find((u) => "emailError" in u);
    expect(update).toBeTruthy();
    expect(update.emailError).toContain("still down");
    expect(update.emailSentAt).toBeUndefined();
  });
});
