/**
 * Regression tests: bulkSetInquiriesArchived is tenant-scoped.
 *
 * The bulk update must combine inArray(id, ids) with
 * eq(tenantId, session.tenantId) so a gallery passing a mix of its own and
 * another gallery's inquiry IDs can only ever change its own rows. Also
 * covers the empty-selection and >200-cap validation paths.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Billing is validated separately (billing-access.test.ts); tenant-scope tests
// run with the subscription guard stubbed out.
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
  hasActiveAccess: () => true,
}));

const state = vi.hoisted(() => ({
  updates: [] as { vals: any; where: any }[],
}));

const tables = vi.hoisted(() => ({
  inquiriesTable: {
    id: "inquiries.id",
    tenantId: "inquiries.tenantId",
    status: "inquiries.status",
    archivedAt: "inquiries.archivedAt",
  },
  inquiryRepliesTable: {},
  tenantsTable: { id: "tenants.id" },
}));

vi.mock("@workspace/db", () => ({
  db: {
    update: vi.fn(() => ({
      set: (vals: any) => ({
        where: (where: any) => {
          state.updates.push({ vals, where });
          return Promise.resolve();
        },
      }),
    })),
  },
  ...tables,
}));

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
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

import { bulkSetInquiriesArchived } from "@/app/(admin)/(gated)/inquiries/actions";
import { and, eq, inArray } from "drizzle-orm";

const inq = tables.inquiriesTable;
const j = (v: any) => JSON.stringify(v);

beforeEach(() => {
  vi.clearAllMocks();
  state.updates.length = 0;
  getSession.mockResolvedValue({
    userId: "user-1",
    tenantId: "tenant-A",
    email: "a@example.com",
  });
});

describe("bulkSetInquiriesArchived tenant scoping", () => {
  it("scopes a mixed own/foreign ID selection to the session tenant", async () => {
    // "foreign-1"/"foreign-2" belong to another gallery; the tenant filter
    // in the WHERE clause is what prevents them from being touched.
    const ids = ["own-1", "foreign-1", "own-2", "foreign-2"];
    await bulkSetInquiriesArchived(ids, true);

    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].vals.archivedAt).toBeInstanceOf(Date);
    const expectedWhere = and(
      inArray(inq.id as any, ids),
      eq(inq.tenantId as any, "tenant-A"),
    );
    expect(j(state.updates[0].where)).toEqual(j(expectedWhere));
  });

  it("scopes unarchiving by tenant and clears archivedAt", async () => {
    await bulkSetInquiriesArchived(["own-1", "foreign-1"], false);

    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].vals).toEqual({ archivedAt: null });
    const expectedWhere = and(
      inArray(inq.id as any, ["own-1", "foreign-1"]),
      eq(inq.tenantId as any, "tenant-A"),
    );
    expect(j(state.updates[0].where)).toEqual(j(expectedWhere));
  });

  it("uses tenant-B's session tenantId when tenant-B attempts the update", async () => {
    getSession.mockResolvedValue({
      userId: "user-2",
      tenantId: "tenant-B",
      email: "b@example.com",
    });
    await bulkSetInquiriesArchived(["tenant-A-inq-1"], true);

    expect(state.updates).toHaveLength(1);
    const expectedWhere = and(
      inArray(inq.id as any, ["tenant-A-inq-1"]),
      eq(inq.tenantId as any, "tenant-B"),
    );
    // Scoped by tenant-B, so tenant-A's row cannot match.
    expect(j(state.updates[0].where)).toEqual(j(expectedWhere));
  });

  it("dedupes and drops empty/non-string IDs before updating", async () => {
    await bulkSetInquiriesArchived(
      ["own-1", "own-1", "", "own-2", 42 as any, null as any],
      true,
    );
    expect(state.updates).toHaveLength(1);
    const expectedWhere = and(
      inArray(inq.id as any, ["own-1", "own-2"]),
      eq(inq.tenantId as any, "tenant-A"),
    );
    expect(j(state.updates[0].where)).toEqual(j(expectedWhere));
  });

  it("silently no-ops on an empty selection without touching the database", async () => {
    await expect(bulkSetInquiriesArchived([], true)).resolves.not.toThrow();
    expect(state.updates).toEqual([]);
  });

  it("silently no-ops on a selection that is only empty strings without touching the database", async () => {
    await expect(
      bulkSetInquiriesArchived(["", ""], true),
    ).resolves.not.toThrow();
    expect(state.updates).toEqual([]);
  });

  it("rejects more than 200 unique IDs without touching the database", async () => {
    const ids = Array.from({ length: 201 }, (_, i) => `inq-${i}`);
    await expect(bulkSetInquiriesArchived(ids, true)).rejects.toThrow(
      "Too many inquiries selected at once.",
    );
    expect(state.updates).toEqual([]);
  });

  it("allows exactly 200 unique IDs", async () => {
    const ids = Array.from({ length: 200 }, (_, i) => `inq-${i}`);
    await bulkSetInquiriesArchived(ids, true);
    expect(state.updates).toHaveLength(1);
  });

  it("redirects to /login when unauthenticated, touching nothing", async () => {
    getSession.mockResolvedValue({} as any);
    await expect(bulkSetInquiriesArchived(["own-1"], true)).rejects.toThrow(
      "REDIRECT:/login",
    );
    expect(state.updates).toEqual([]);
  });
});
