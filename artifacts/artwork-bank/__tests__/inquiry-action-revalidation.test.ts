/**
 * Inquiry actions — success paths, revalidation, and auth gates.
 *
 * Existing tests cover tenant isolation and invalid inputs.
 * These tests confirm:
 *  - setInquiryStatus and setInquiryArchived call revalidatePath after success
 *  - Both actions redirect to /login for unauthenticated sessions
 *  - Both throw "Inquiry not found" when the UPDATE returns 0 rows
 *  - setInquiryStatus rejects invalid status values
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Auth mock ─────────────────────────────────────────────────────────────────
const getSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ getSession }));

// ── Billing mock ──────────────────────────────────────────────────────────────
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn().mockResolvedValue(undefined),
}));

// ── DB mock ───────────────────────────────────────────────────────────────────
let dbUpdateReturning: unknown[] = [{ id: "inq-1" }];
let lastUpdateVals: Record<string, unknown> = {};

vi.mock("@workspace/db", () => ({
  db: {
    update: () => ({
      set: (vals: Record<string, unknown>) => {
        lastUpdateVals = vals;
        return {
          where: () => ({
            returning: async () => dbUpdateReturning,
          }),
        };
      },
    }),
    query: {
      tenantsTable: { findFirst: vi.fn().mockResolvedValue(null) },
    },
    insert: () => ({ values: vi.fn().mockResolvedValue(undefined) }),
  },
  inquiriesTable: { id: "inq.id", tenantId: "inq.tenantId", status: "inq.status", archivedAt: "inq.archivedAt" },
  inquiryRepliesTable: {},
  tenantsTable: {},
  eq: vi.fn(),
  and: vi.fn(),
  inArray: vi.fn(),
}));

// ── next/cache + navigation mocks ─────────────────────────────────────────────
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath }));

const REDIRECTS: string[] = [];
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    REDIRECTS.push(url);
    throw new Error(`REDIRECT:${url}`);
  },
}));

// ── Email mock (needed by module) ─────────────────────────────────────────────
vi.mock("@/lib/email", () => ({
  sendInquiryReply: vi.fn().mockResolvedValue(undefined),
  EmailSendError: class extends Error {},
}));

import { setInquiryStatus, setInquiryArchived } from "@/app/(admin)/(gated)/inquiries/actions";

function formData(fields: Record<string, string>): FormData {
  return { get: (k: string) => fields[k] ?? null } as unknown as FormData;
}

async function run(fn: () => Promise<void>) {
  try { await fn(); return { ok: true }; }
  catch (e: any) {
    if (e?.message?.startsWith("REDIRECT:")) return { ok: false, redirect: e.message.slice("REDIRECT:".length) };
    throw e;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  REDIRECTS.length = 0;
  lastUpdateVals = {};
  dbUpdateReturning = [{ id: "inq-1" }];
  getSession.mockResolvedValue({ userId: "u-1", tenantId: "tenant-A", role: "owner" });
});

// ── setInquiryStatus ──────────────────────────────────────────────────────────

describe("setInquiryStatus", () => {
  it("redirects to /login for unauthenticated callers", async () => {
    getSession.mockResolvedValueOnce({ userId: null, tenantId: "" });
    const r = await run(() => setInquiryStatus(formData({ inquiryId: "i-1", status: "HANDLED" })));
    expect(r.redirect).toBe("/login");
  });

  it("throws for an invalid status value", async () => {
    await expect(
      setInquiryStatus(formData({ inquiryId: "i-1", status: "DELETED" })),
    ).rejects.toThrow("Invalid request.");
  });

  it("throws for a missing inquiryId", async () => {
    await expect(
      setInquiryStatus(formData({ status: "HANDLED" })),
    ).rejects.toThrow("Invalid request.");
  });

  it("throws 'Inquiry not found' when UPDATE returns 0 rows", async () => {
    dbUpdateReturning = [];
    await expect(
      setInquiryStatus(formData({ inquiryId: "ghost", status: "HANDLED" })),
    ).rejects.toThrow("Inquiry not found.");
  });

  it("calls revalidatePath('/inquiries') after successful update", async () => {
    await setInquiryStatus(formData({ inquiryId: "i-1", status: "HANDLED" }));
    expect(revalidatePath).toHaveBeenCalledWith("/inquiries");
  });

  it("calls revalidatePath('/', 'layout') after successful update", async () => {
    await setInquiryStatus(formData({ inquiryId: "i-1", status: "NEW" }));
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("persists the correct status value (NEW or HANDLED)", async () => {
    await setInquiryStatus(formData({ inquiryId: "i-1", status: "HANDLED" }));
    expect(lastUpdateVals).toMatchObject({ status: "HANDLED" });
  });
});

// ── setInquiryArchived ────────────────────────────────────────────────────────

describe("setInquiryArchived", () => {
  it("redirects to /login for unauthenticated callers", async () => {
    getSession.mockResolvedValueOnce({ userId: null, tenantId: "" });
    const r = await run(() => setInquiryArchived(formData({ inquiryId: "i-1", archived: "true" })));
    expect(r.redirect).toBe("/login");
  });

  it("throws for an invalid archived value", async () => {
    await expect(
      setInquiryArchived(formData({ inquiryId: "i-1", archived: "yes" })),
    ).rejects.toThrow("Invalid request.");
  });

  it("throws 'Inquiry not found' when UPDATE returns 0 rows", async () => {
    dbUpdateReturning = [];
    await expect(
      setInquiryArchived(formData({ inquiryId: "ghost", archived: "true" })),
    ).rejects.toThrow("Inquiry not found.");
  });

  it("calls revalidatePath('/inquiries') after successful update", async () => {
    await setInquiryArchived(formData({ inquiryId: "i-1", archived: "true" }));
    expect(revalidatePath).toHaveBeenCalledWith("/inquiries");
  });

  it("calls revalidatePath('/', 'layout') after successful update", async () => {
    await setInquiryArchived(formData({ inquiryId: "i-1", archived: "false" }));
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("sets archivedAt to a Date when archived=true", async () => {
    await setInquiryArchived(formData({ inquiryId: "i-1", archived: "true" }));
    expect(lastUpdateVals.archivedAt).toBeInstanceOf(Date);
  });

  it("sets archivedAt to null when archived=false (unarchive)", async () => {
    await setInquiryArchived(formData({ inquiryId: "i-1", archived: "false" }));
    expect(lastUpdateVals.archivedAt).toBeNull();
  });
});
