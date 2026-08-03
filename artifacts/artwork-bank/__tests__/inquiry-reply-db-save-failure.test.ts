/**
 * Task #51 — Don't lose a sent inquiry reply if DB save fails after email send.
 *
 * When the email to the buyer succeeds but the DB INSERT into inquiryReplies
 * fails (e.g. a transient DB error), the action must:
 *  - Return { status: "sent_not_saved" } so the UI can warn the staff member
 *  - NOT return { status: "error" } — that would imply the email wasn't sent
 *  - NOT return { status: "sent" } — that would silently hide the data loss
 *  - Log the error so ops can spot it
 *
 * It should also NOT update the inquiry status to HANDLED, because the reply
 * isn't recorded, so the conversation shouldn't be closed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Billing mock — allow access by default ────────────────────────────────────
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn().mockResolvedValue(undefined),
  hasActiveAccess: vi.fn().mockReturnValue(true),
  SUBSCRIPTION_PRICE_CENTS: 4900,
}));

// ── Session mock ──────────────────────────────────────────────────────────────
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn().mockResolvedValue({
    userId: "user-1",
    tenantId: "tenant-1",
  }),
}));

// ── DB mock ───────────────────────────────────────────────────────────────────
const dbInsert = vi.hoisted(() => vi.fn());
const dbUpdate = vi.hoisted(() => vi.fn());
const dbFindFirst = vi.hoisted(() => vi.fn());

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      inquiriesTable: { findFirst: dbFindFirst },
      tenantsTable: { findFirst: dbFindFirst },
    },
    insert: () => ({ values: dbInsert }),
    update: () => ({ set: () => ({ where: dbUpdate }) }),
  },
  inquiriesTable: {},
  inquiryRepliesTable: {},
  tenantsTable: {},
  usersTable: {},
  eq: vi.fn(),
  and: vi.fn(),
}));

// ── Email mock ────────────────────────────────────────────────────────────────
const sendInquiryReply = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({
  sendInquiryReply: (...a: any[]) => sendInquiryReply(...a),
  EmailSendError: class EmailSendError extends Error {},
}));

// ── next/cache mock ───────────────────────────────────────────────────────────
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { replyToInquiry } from "@/app/(admin)/(gated)/inquiries/actions";

const BASE_INQUIRY = {
  id: "inq-1",
  tenantId: "tenant-1",
  buyerEmail: "buyer@example.com",
  buyerName: "Alice",
  artworkTitle: "Sunset",
  message: "Is this available?",
};
const BASE_TENANT = {
  id: "tenant-1",
  businessName: "Test Gallery",
  contactEmail: "gallery@test.com",
};

function makeFormData(inquiryId: string, message: string): FormData {
  return {
    get: (k: string) =>
      k === "inquiryId" ? inquiryId : k === "replyMessage" ? message : null,
  } as unknown as FormData;
}

beforeEach(() => {
  vi.clearAllMocks();
  sendInquiryReply.mockResolvedValue(undefined);
  dbUpdate.mockResolvedValue(undefined);
  // Default: findFirst returns inquiry on 1st call, tenant on 2nd call
  dbFindFirst
    .mockResolvedValueOnce(BASE_INQUIRY)
    .mockResolvedValueOnce(BASE_TENANT);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("replyToInquiry — DB save failure after email (Task #51)", () => {
  it("returns sent_not_saved when DB insert throws after email succeeds", async () => {
    dbInsert.mockRejectedValueOnce(new Error("deadlock detected"));

    const result = await replyToInquiry({ status: "idle" }, makeFormData("inq-1", "Hello!"));

    expect(result.status).toBe("sent_not_saved");
    expect(result.message).toMatch(/sent to the buyer/i);
    expect(result.message).toMatch(/could not be saved/i);
  });

  it("still sends the email before the DB insert attempt", async () => {
    dbInsert.mockRejectedValueOnce(new Error("db down"));

    await replyToInquiry({ status: "idle" }, makeFormData("inq-1", "Hello!"));

    expect(sendInquiryReply).toHaveBeenCalledOnce();
  });

  it("does NOT mark inquiry as HANDLED when DB insert fails", async () => {
    dbInsert.mockRejectedValueOnce(new Error("db down"));

    await replyToInquiry({ status: "idle" }, makeFormData("inq-1", "Hello!"));

    // dbUpdate drives both the insert-values path and the inquiry status update.
    // When the insert fails, the subsequent UPDATE should not run.
    expect(dbUpdate).not.toHaveBeenCalled();
  });

  it("logs the error when DB insert fails after email send", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    dbInsert.mockRejectedValueOnce(new Error("connection reset"));

    await replyToInquiry({ status: "idle" }, makeFormData("inq-1", "Hello!"));

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Email sent but DB record failed"),
      expect.any(String),
      expect.any(String),
      expect.stringContaining("connection reset"),
    );
  });

  it("returns sent (not sent_not_saved) when everything works normally", async () => {
    dbInsert.mockResolvedValueOnce(undefined);

    const result = await replyToInquiry({ status: "idle" }, makeFormData("inq-1", "Hello!"));

    expect(result.status).toBe("sent");
  });

  it("returns error (not sent_not_saved) when the email fails", async () => {
    sendInquiryReply.mockRejectedValueOnce(new Error("SMTP timeout"));

    const result = await replyToInquiry({ status: "idle" }, makeFormData("inq-1", "Hello!"));

    // Email failed before send — DB was never reached
    expect(result.status).toBe("error");
    expect(dbInsert).not.toHaveBeenCalled();
  });
});
