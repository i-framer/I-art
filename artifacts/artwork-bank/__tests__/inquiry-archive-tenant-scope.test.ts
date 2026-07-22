/**
 * Regression tests: archiving is tenant-scoped and archived inquiries
 * never leak into other views or counts.
 *
 * - setInquiryArchived must scope its update by the session tenantId so a
 *   gallery can never archive/unarchive another gallery's inquiry, and a
 *   cross-tenant attempt fails without changing anything.
 * - The inquiries page must exclude archived inquiries from the All/New/
 *   Handled views and show them only under Archived.
 * - The admin sidebar "new" badge count must exclude archived inquiries.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Billing is validated separately (billing-access.test.ts); tenant-scope tests
// run with the subscription guard stubbed out.
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
  hasActiveAccess: () => true,
}));
import * as React from "react";

// The page/layout server components are compiled with the classic JSX
// runtime in this test transform; make React available globally.
(globalThis as any).React = React;

const state = vi.hoisted(() => ({
  updates: [] as { vals: any; where: any }[],
  selectWheres: [] as any[],
  updateMatches: true, // whether the tenant-scoped update matches a row
}));

const tables = vi.hoisted(() => ({
  inquiriesTable: {
    id: "inquiries.id",
    tenantId: "inquiries.tenantId",
    status: "inquiries.status",
    archivedAt: "inquiries.archivedAt",
    createdAt: "inquiries.createdAt",
  },
  inquiryRepliesTable: {
    tenantId: "inquiryReplies.tenantId",
    inquiryId: "inquiryReplies.inquiryId",
    sentAt: "inquiryReplies.sentAt",
  },
  tenantsTable: { id: "tenants.id" },
}));

const tenantFindFirst = vi.hoisted(() => vi.fn());

vi.mock("@workspace/db", () => {
  function chain() {
    const c: any = {
      from: () => c,
      where: (w: any) => {
        state.selectWheres.push(w);
        return c;
      },
      orderBy: () => c,
      limit: () => c,
      offset: () => c,
      then: (res: any, rej: any) => Promise.resolve([]).then(res, rej),
    };
    return c;
  }
  return {
    db: {
      select: vi.fn(() => chain()),
      query: {
        tenantsTable: { findFirst: (opts: any) => tenantFindFirst(opts) },
      },
      update: vi.fn(() => ({
        set: (vals: any) => ({
          where: (where: any) => {
            state.updates.push({ vals, where });
            return {
              returning: () =>
                Promise.resolve(state.updateMatches ? [{ id: "inq-1" }] : []),
            };
          },
        }),
      })),
      insert: vi.fn(() => ({ values: () => Promise.resolve() })),
    },
    ...tables,
  };
});

const getSession = vi.hoisted(() =>
  vi.fn(async () => ({
    userId: "user-1",
    tenantId: "tenant-A",
    email: "a@example.com",
  })),
);
vi.mock("@/lib/auth", () => ({
  getSession: () => getSession(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock("@/app/(auth)/actions", () => ({ logout: vi.fn() }));

import { setInquiryArchived } from "@/app/(admin)/(gated)/inquiries/actions";
import InquiriesPage from "@/app/(admin)/(gated)/inquiries/page";
import AdminLayout from "@/app/(admin)/layout";
import { and, eq, isNull, isNotNull } from "drizzle-orm";

const inq = tables.inquiriesTable;

function formData(entries: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

const tenantA = {
  id: "tenant-A",
  businessName: "Gallery A",
  contactEmail: "gallery-a@example.com",
  type: "GALLERY",
  slug: "gallery-a",
};

beforeEach(() => {
  vi.clearAllMocks();
  state.updates.length = 0;
  state.selectWheres.length = 0;
  state.updateMatches = true;
  getSession.mockResolvedValue({
    userId: "user-1",
    tenantId: "tenant-A",
    email: "a@example.com",
  });
  tenantFindFirst.mockResolvedValue(tenantA);
});

const j = (v: any) => JSON.stringify(v);

describe("setInquiryArchived tenant scoping", () => {
  it("scopes the archive update by the session tenantId", async () => {
    await setInquiryArchived(formData({ inquiryId: "inq-1", archived: "true" }));
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].vals.archivedAt).toBeInstanceOf(Date);
    const expectedWhere = and(
      eq(inq.id as any, "inq-1"),
      eq(inq.tenantId as any, "tenant-A"),
    );
    expect(j(state.updates[0].where)).toEqual(j(expectedWhere));
  });

  it("scopes the unarchive update by the session tenantId and clears archivedAt", async () => {
    await setInquiryArchived(
      formData({ inquiryId: "inq-1", archived: "false" }),
    );
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].vals).toEqual({ archivedAt: null });
    const expectedWhere = and(
      eq(inq.id as any, "inq-1"),
      eq(inq.tenantId as any, "tenant-A"),
    );
    expect(j(state.updates[0].where)).toEqual(j(expectedWhere));
  });

  it("fails with 'Inquiry not found' when another tenant's inquiry doesn't match, changing nothing", async () => {
    getSession.mockResolvedValue({
      userId: "user-2",
      tenantId: "tenant-B",
      email: "b@example.com",
    });
    state.updateMatches = false; // tenant-scoped where matched no rows
    await expect(
      setInquiryArchived(formData({ inquiryId: "inq-1", archived: "true" })),
    ).rejects.toThrow("Inquiry not found.");
    // The attempted update was still scoped by tenant-B, so it could not
    // have touched tenant-A's inquiry.
    const expectedWhere = and(
      eq(inq.id as any, "inq-1"),
      eq(inq.tenantId as any, "tenant-B"),
    );
    expect(j(state.updates[0].where)).toEqual(j(expectedWhere));
  });

  it("rejects an invalid archived value without touching the database", async () => {
    await expect(
      setInquiryArchived(formData({ inquiryId: "inq-1", archived: "yes" })),
    ).rejects.toThrow("Invalid request.");
    expect(state.updates).toEqual([]);
  });

  it("rejects a missing inquiry id without touching the database", async () => {
    await expect(
      setInquiryArchived(formData({ archived: "true" })),
    ).rejects.toThrow("Invalid request.");
    expect(state.updates).toEqual([]);
  });

  it("redirects to /login when unauthenticated", async () => {
    getSession.mockResolvedValue({} as any);
    await expect(
      setInquiryArchived(formData({ inquiryId: "inq-1", archived: "true" })),
    ).rejects.toThrow("REDIRECT:/login");
    expect(state.updates).toEqual([]);
  });
});

async function renderInquiriesPage(status?: string) {
  state.selectWheres.length = 0;
  await InquiriesPage({
    searchParams: Promise.resolve(status ? { status } : {}),
  });
  // Order of selects in the page: rows, total count, new-count badge.
  const [rowsWhere, countWhere, newCountWhere] = state.selectWheres;
  return { rowsWhere, countWhere, newCountWhere };
}

const tenantWhere = eq(inq.tenantId as any, "tenant-A");

describe("inquiries page filters exclude archived inquiries", () => {
  it("All view lists only unarchived inquiries", async () => {
    const { rowsWhere, countWhere } = await renderInquiriesPage();
    const expected = and(tenantWhere, isNull(inq.archivedAt as any));
    expect(j(rowsWhere)).toEqual(j(expected));
    expect(j(countWhere)).toEqual(j(expected));
  });

  it("New view lists only unarchived NEW inquiries", async () => {
    const { rowsWhere } = await renderInquiriesPage("new");
    const expected = and(
      tenantWhere,
      isNull(inq.archivedAt as any),
      eq(inq.status as any, "NEW"),
    );
    expect(j(rowsWhere)).toEqual(j(expected));
  });

  it("Handled view lists only unarchived HANDLED inquiries", async () => {
    const { rowsWhere } = await renderInquiriesPage("handled");
    const expected = and(
      tenantWhere,
      isNull(inq.archivedAt as any),
      eq(inq.status as any, "HANDLED"),
    );
    expect(j(rowsWhere)).toEqual(j(expected));
  });

  it("Archived view lists only archived inquiries for the tenant", async () => {
    const { rowsWhere, countWhere } = await renderInquiriesPage("archived");
    const expected = and(tenantWhere, isNotNull(inq.archivedAt as any));
    expect(j(rowsWhere)).toEqual(j(expected));
    expect(j(countWhere)).toEqual(j(expected));
  });

  it("page 'new' badge count excludes archived inquiries in every view", async () => {
    for (const status of [undefined, "new", "handled", "archived"]) {
      const { newCountWhere } = await renderInquiriesPage(status);
      const expected = and(
        tenantWhere,
        eq(inq.status as any, "NEW"),
        isNull(inq.archivedAt as any),
      );
      expect(j(newCountWhere)).toEqual(j(expected));
    }
  });
});

describe("admin sidebar new-inquiry badge", () => {
  it("counts only unarchived NEW inquiries for the session tenant", async () => {
    await AdminLayout({ children: null });
    expect(state.selectWheres).toHaveLength(1);
    const expected = and(
      tenantWhere,
      eq(inq.status as any, "NEW"),
      isNull(inq.archivedAt as any),
    );
    expect(j(state.selectWheres[0])).toEqual(j(expected));
  });
});
