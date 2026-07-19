/**
 * Regression tests: replyToInquiry must scope inquiry lookups by the
 * session's tenantId so a gallery can never reply to another gallery's
 * buyers. Also covers input validation, HANDLED status on success, and
 * that an email failure leaves the inquiry untouched.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const state = vi.hoisted(() => ({
  inserts: [] as any[],
  updates: [] as { vals: any; where: any }[],
  inquiryFindWhere: null as any,
  updateMatches: true, // whether the tenant-scoped update matches a row
}));

const tables = vi.hoisted(() => ({
  inquiriesTable: { id: "inquiries.id", tenantId: "inquiries.tenantId", status: "inquiries.status" },
  inquiryRepliesTable: {},
  tenantsTable: { id: "tenants.id" },
}));

const inquiryFindFirst = vi.hoisted(() => vi.fn());
const tenantFindFirst = vi.hoisted(() => vi.fn());

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      inquiriesTable: {
        findFirst: (opts: any) => {
          state.inquiryFindWhere = opts?.where;
          return inquiryFindFirst(opts);
        },
      },
      tenantsTable: { findFirst: (opts: any) => tenantFindFirst(opts) },
    },
    insert: vi.fn(() => ({
      values: (vals: any) => {
        state.inserts.push(vals);
        return Promise.resolve();
      },
    })),
    update: vi.fn(() => ({
      set: (vals: any) => ({
        where: (where: any) => {
          state.updates.push({ vals, where });
          return {
            returning: () =>
              Promise.resolve(state.updateMatches ? [{ id: "inq-1" }] : []),
            then: (res: any) => Promise.resolve(undefined).then(res),
          };
        },
      }),
    })),
  },
  ...tables,
}));

const getSession = vi.hoisted(() =>
  vi.fn(async () => ({ userId: "user-1", tenantId: "tenant-A" })),
);
vi.mock("@/lib/auth", () => ({
  getSession: () => getSession(),
}));

const sendInquiryReply = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => {
  class EmailSendError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "EmailSendError";
    }
  }
  return {
    EmailSendError,
    sendInquiryReply: (...args: any[]) => sendInquiryReply(...args),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

import { replyToInquiry, setInquiryStatus } from "@/app/(admin)/inquiries/actions";
import { EmailSendError } from "@/lib/email";
import { and, eq } from "drizzle-orm";

const idle = { status: "idle" as const };

function formData(entries: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

const inquiryA = {
  id: "inq-1",
  tenantId: "tenant-A",
  buyerEmail: "buyer@example.com",
  buyerName: "Buyer",
  message: "Is this available?",
  artworkTitle: "Sunset",
  status: "NEW",
};

const tenantA = {
  id: "tenant-A",
  businessName: "Gallery A",
  contactEmail: "gallery-a@example.com",
};

beforeEach(() => {
  vi.clearAllMocks();
  state.inserts.length = 0;
  state.updates.length = 0;
  state.inquiryFindWhere = null;
  state.updateMatches = true;
  getSession.mockResolvedValue({ userId: "user-1", tenantId: "tenant-A" });
  tenantFindFirst.mockResolvedValue(tenantA);
  // Simulate real tenant scoping: only return the inquiry if the where
  // clause matches the tenant-scoped condition for tenant-A + inq-1.
  inquiryFindFirst.mockImplementation(async (opts: any) => {
    const expected = and(
      eq(tables.inquiriesTable.id as any, "inq-1"),
      eq(tables.inquiriesTable.tenantId as any, "tenant-A"),
    );
    return JSON.stringify(opts?.where) === JSON.stringify(expected)
      ? inquiryA
      : undefined;
  });
  sendInquiryReply.mockResolvedValue(undefined);
});

describe("replyToInquiry tenant scoping", () => {
  it("returns 'Inquiry not found' for another tenant's inquiry and sends nothing", async () => {
    getSession.mockResolvedValue({ userId: "user-2", tenantId: "tenant-B" });
    const res = await replyToInquiry(idle, formData({
      inquiryId: "inq-1",
      replyMessage: "Hello",
    }));
    expect(res).toEqual({ status: "error", message: "Inquiry not found." });
    expect(sendInquiryReply).not.toHaveBeenCalled();
    expect(state.inserts).toEqual([]);
    expect(state.updates).toEqual([]);
  });

  it("always includes the session tenantId in the inquiry lookup", async () => {
    await replyToInquiry(idle, formData({ inquiryId: "inq-1", replyMessage: "Hi" }));
    const expected = and(
      eq(tables.inquiriesTable.id as any, "inq-1"),
      eq(tables.inquiriesTable.tenantId as any, "tenant-A"),
    );
    expect(JSON.stringify(state.inquiryFindWhere)).toEqual(
      JSON.stringify(expected),
    );
  });

  it("returns 'Inquiry not found' for a nonexistent inquiry id", async () => {
    const res = await replyToInquiry(idle, formData({
      inquiryId: "no-such-id",
      replyMessage: "Hello",
    }));
    expect(res).toEqual({ status: "error", message: "Inquiry not found." });
    expect(sendInquiryReply).not.toHaveBeenCalled();
  });
});

describe("setInquiryStatus tenant scoping", () => {
  it("scopes the status update by the session tenantId", async () => {
    await setInquiryStatus(formData({ inquiryId: "inq-1", status: "HANDLED" }));
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].vals).toEqual({ status: "HANDLED" });
    const expectedWhere = and(
      eq(tables.inquiriesTable.id as any, "inq-1"),
      eq(tables.inquiriesTable.tenantId as any, "tenant-A"),
    );
    expect(JSON.stringify(state.updates[0].where)).toEqual(
      JSON.stringify(expectedWhere),
    );
  });

  it("throws 'Inquiry not found' when another tenant's inquiry doesn't match", async () => {
    state.updateMatches = false; // tenant-scoped where matched no rows
    await expect(
      setInquiryStatus(formData({ inquiryId: "inq-1", status: "HANDLED" })),
    ).rejects.toThrow("Inquiry not found.");
  });

  it("rejects an invalid status value", async () => {
    await expect(
      setInquiryStatus(formData({ inquiryId: "inq-1", status: "ARCHIVED" })),
    ).rejects.toThrow("Invalid request.");
    expect(state.updates).toEqual([]);
  });
});

describe("replyToInquiry input validation", () => {
  it("rejects a missing inquiry id", async () => {
    const res = await replyToInquiry(idle, formData({ replyMessage: "Hi" }));
    expect(res).toEqual({ status: "error", message: "Invalid request." });
    expect(sendInquiryReply).not.toHaveBeenCalled();
  });

  it("rejects an empty reply message", async () => {
    const res = await replyToInquiry(idle, formData({
      inquiryId: "inq-1",
      replyMessage: "   ",
    }));
    expect(res).toEqual({
      status: "error",
      message: "Reply message cannot be empty.",
    });
    expect(sendInquiryReply).not.toHaveBeenCalled();
  });

  it("rejects an overlong reply message (> 5000 chars)", async () => {
    const res = await replyToInquiry(idle, formData({
      inquiryId: "inq-1",
      replyMessage: "x".repeat(5001),
    }));
    expect(res.status).toBe("error");
    expect(res.message).toMatch(/too long/i);
    expect(sendInquiryReply).not.toHaveBeenCalled();
  });
});

describe("replyToInquiry send flow", () => {
  it("sends the reply, records it, and marks the inquiry HANDLED", async () => {
    const res = await replyToInquiry(idle, formData({
      inquiryId: "inq-1",
      replyMessage: "It's available!",
    }));
    expect(res).toEqual({ status: "sent" });
    expect(sendInquiryReply).toHaveBeenCalledWith(
      expect.objectContaining({
        buyerEmail: "buyer@example.com",
        replyMessage: "It's available!",
        tenantName: "Gallery A",
        galleryEmail: "gallery-a@example.com",
      }),
    );
    expect(state.inserts).toEqual([
      {
        tenantId: "tenant-A",
        inquiryId: "inq-1",
        message: "It's available!",
      },
    ]);
    // Status update is tenant-scoped and sets HANDLED
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].vals).toEqual({ status: "HANDLED" });
    const expectedWhere = and(
      eq(tables.inquiriesTable.id as any, "inq-1"),
      eq(tables.inquiriesTable.tenantId as any, "tenant-A"),
    );
    expect(JSON.stringify(state.updates[0].where)).toEqual(
      JSON.stringify(expectedWhere),
    );
  });

  it("returns the EmailSendError message and leaves status unchanged on email failure", async () => {
    sendInquiryReply.mockRejectedValueOnce(
      new EmailSendError("Resend error 500"),
    );
    const res = await replyToInquiry(idle, formData({
      inquiryId: "inq-1",
      replyMessage: "Hello",
    }));
    expect(res).toEqual({ status: "error", message: "Resend error 500" });
    expect(state.inserts).toEqual([]); // reply not recorded
    expect(state.updates).toEqual([]); // status untouched
  });

  it("returns a generic error and leaves status unchanged on unexpected failure", async () => {
    sendInquiryReply.mockRejectedValueOnce(new Error("network down"));
    const res = await replyToInquiry(idle, formData({
      inquiryId: "inq-1",
      replyMessage: "Hello",
    }));
    expect(res).toEqual({
      status: "error",
      message: "Failed to send reply. Please try again.",
    });
    expect(state.inserts).toEqual([]);
    expect(state.updates).toEqual([]);
  });
});
