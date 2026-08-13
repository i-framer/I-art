/**
 * Exhibition & Show Planner — billing guard  (Task #81)
 *
 * Verifies the billing guard on createShow:
 *  - unsubscribed/cancelled → redirect to /settings/billing
 *  - billingExempt / active / trialing → allowed through
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const tenantRow = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      tenantsTable: { findFirst: vi.fn(async () => tenantRow.current) },
      exhibitionShowsTable: { findFirst: vi.fn(async () => null) },
    },
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(async () => [{ id: "show-1" }]),
      })),
    })),
  },
  tenantsTable: {},
  exhibitionShowsTable: {},
  eq: vi.fn(),
  and: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ userId: "u1", tenantId: "t1" })),
}));

const redirectSpy = vi.hoisted(() =>
  vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
);
vi.mock("next/navigation", () => ({ redirect: redirectSpy }));

import { hasActiveAccess } from "@/lib/billing";
vi.mock("@/lib/billing", () => ({ hasActiveAccess: vi.fn() }));

import { createShow } from "@/app/(admin)/(gated)/exhibitions/actions";

function makeForm(title = "Test Show"): FormData {
  const fd = new FormData();
  fd.set("title", title);
  return fd;
}

describe("createShow billing guard (Task #81)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantRow.current = null;
    redirectSpy.mockImplementation((url: string) => { throw new Error(`REDIRECT:${url}`); });
  });

  it("redirects to /settings/billing when subscription is null", async () => {
    tenantRow.current = { id: "t1", billingExempt: false, subscriptionStatus: null };
    vi.mocked(hasActiveAccess).mockReturnValue(false);

    await expect(createShow(makeForm())).rejects.toThrow("REDIRECT:/settings/billing");
  });

  it("redirects to /settings/billing when subscription is canceled", async () => {
    tenantRow.current = { id: "t1", billingExempt: false, subscriptionStatus: "canceled" };
    vi.mocked(hasActiveAccess).mockReturnValue(false);

    await expect(createShow(makeForm())).rejects.toThrow("REDIRECT:/settings/billing");
  });

  it("allows show creation when billingExempt=true", async () => {
    tenantRow.current = { id: "t1", billingExempt: true, subscriptionStatus: null };
    vi.mocked(hasActiveAccess).mockReturnValue(true);

    try { await createShow(makeForm()); } catch (e: any) {
      expect(e.message).not.toContain("/settings/billing");
    }
  });

  it("allows show creation when subscription is active", async () => {
    tenantRow.current = { id: "t1", billingExempt: false, subscriptionStatus: "active" };
    vi.mocked(hasActiveAccess).mockReturnValue(true);

    try { await createShow(makeForm()); } catch (e: any) {
      expect(e.message).not.toContain("/settings/billing");
    }
  });

  it("allows show creation when subscription is trialing", async () => {
    tenantRow.current = { id: "t1", billingExempt: false, subscriptionStatus: "trialing" };
    vi.mocked(hasActiveAccess).mockReturnValue(true);

    try { await createShow(makeForm()); } catch (e: any) {
      expect(e.message).not.toContain("/settings/billing");
    }
  });

  it("redirects to /login when no session user", async () => {
    const { getSession } = await import("@/lib/auth");
    vi.mocked(getSession).mockResolvedValueOnce({ userId: undefined, tenantId: "t1" } as any);

    await expect(createShow(makeForm())).rejects.toThrow("REDIRECT:/login");
  });
});
