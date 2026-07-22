/**
 * Platform admin (comp accounts) access control:
 * - isPlatformAdmin fails closed when PLATFORM_ADMIN_EMAILS is unset/empty.
 * - Only allowlisted emails pass; tenant owners/staff do not.
 * - setBillingExempt rejects non-platform-admin sessions and never touches
 *   the database; allows platform admins and updates the right tenant.
 * - tenantBillingStatus maps exempt/subscription state to display status.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@workspace/db", () => {
  const returning = vi.fn();
  const where = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  return {
    db: { update },
    tenantsTable: { id: "id" },
    __mocks: { update, set, where, returning },
  };
});

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { getSession } from "@/lib/auth";
import {
  isPlatformAdmin,
  tenantBillingStatus,
} from "@/lib/platform-admin";
import { setBillingExempt } from "@/app/platform/actions";

const dbModule = (await import("@workspace/db")) as unknown as {
  __mocks: {
    update: ReturnType<typeof vi.fn>;
    returning: ReturnType<typeof vi.fn>;
  };
};

const ORIGINAL_ENV = process.env.PLATFORM_ADMIN_EMAILS;

function makeForm(entries: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PLATFORM_ADMIN_EMAILS;
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.PLATFORM_ADMIN_EMAILS;
  else process.env.PLATFORM_ADMIN_EMAILS = ORIGINAL_ENV;
});

describe("isPlatformAdmin", () => {
  it("fails closed when the allowlist env var is unset", () => {
    expect(isPlatformAdmin("owner@example.com")).toBe(false);
  });

  it("fails closed when the allowlist is empty", () => {
    process.env.PLATFORM_ADMIN_EMAILS = "  , ";
    expect(isPlatformAdmin("owner@example.com")).toBe(false);
  });

  it("matches allowlisted emails case-insensitively, with whitespace", () => {
    process.env.PLATFORM_ADMIN_EMAILS = " Owner@Example.com , second@x.com";
    expect(isPlatformAdmin("owner@example.COM")).toBe(true);
    expect(isPlatformAdmin("second@x.com")).toBe(true);
    expect(isPlatformAdmin("tenant-admin@gallery.com")).toBe(false);
  });

  it("rejects null/undefined/empty emails", () => {
    process.env.PLATFORM_ADMIN_EMAILS = "owner@example.com";
    expect(isPlatformAdmin(null)).toBe(false);
    expect(isPlatformAdmin(undefined)).toBe(false);
    expect(isPlatformAdmin("")).toBe(false);
  });
});

describe("tenantBillingStatus", () => {
  it("returns exempt when billingExempt, regardless of subscription", () => {
    expect(
      tenantBillingStatus({ billingExempt: true, subscriptionStatus: "canceled" }),
    ).toBe("exempt");
  });

  it("returns the subscription status when not exempt", () => {
    expect(
      tenantBillingStatus({ billingExempt: false, subscriptionStatus: "active" }),
    ).toBe("active");
    expect(
      tenantBillingStatus({ billingExempt: false, subscriptionStatus: "past_due" }),
    ).toBe("past_due");
  });

  it("returns none when there is no subscription", () => {
    expect(
      tenantBillingStatus({ billingExempt: false, subscriptionStatus: null }),
    ).toBe("none");
  });
});

describe("setBillingExempt", () => {
  it("rejects unauthenticated callers without touching the database", async () => {
    vi.mocked(getSession).mockResolvedValue({} as never);
    await expect(
      setBillingExempt(makeForm({ tenantId: "t1", exempt: "true" })),
    ).rejects.toThrow(/platform admin/i);
    expect(dbModule.__mocks.update).not.toHaveBeenCalled();
  });

  it("rejects tenant owners who are not allowlisted", async () => {
    process.env.PLATFORM_ADMIN_EMAILS = "platform@example.com";
    vi.mocked(getSession).mockResolvedValue({
      userId: "u1",
      tenantId: "t1",
      role: "owner",
      email: "gallery-owner@example.com",
    } as never);
    await expect(
      setBillingExempt(makeForm({ tenantId: "t1", exempt: "true" })),
    ).rejects.toThrow(/platform admin/i);
    expect(dbModule.__mocks.update).not.toHaveBeenCalled();
  });

  it("lets a platform admin comp a tenant", async () => {
    process.env.PLATFORM_ADMIN_EMAILS = "platform@example.com";
    vi.mocked(getSession).mockResolvedValue({
      userId: "u1",
      tenantId: "t1",
      role: "owner",
      email: "platform@example.com",
    } as never);
    dbModule.__mocks.returning.mockResolvedValue([{ id: "t2" }]);

    await setBillingExempt(makeForm({ tenantId: "t2", exempt: "true" }));
    expect(dbModule.__mocks.update).toHaveBeenCalledTimes(1);
  });

  it("throws when the tenant does not exist", async () => {
    process.env.PLATFORM_ADMIN_EMAILS = "platform@example.com";
    vi.mocked(getSession).mockResolvedValue({
      userId: "u1",
      email: "platform@example.com",
    } as never);
    dbModule.__mocks.returning.mockResolvedValue([]);

    await expect(
      setBillingExempt(makeForm({ tenantId: "missing", exempt: "false" })),
    ).rejects.toThrow(/not found/i);
  });

  it("rejects malformed input", async () => {
    process.env.PLATFORM_ADMIN_EMAILS = "platform@example.com";
    vi.mocked(getSession).mockResolvedValue({
      userId: "u1",
      email: "platform@example.com",
    } as never);

    await expect(
      setBillingExempt(makeForm({ exempt: "true" })),
    ).rejects.toThrow(/tenantId/i);
    await expect(
      setBillingExempt(makeForm({ tenantId: "t1", exempt: "yes" })),
    ).rejects.toThrow(/exempt/i);
    expect(dbModule.__mocks.update).not.toHaveBeenCalled();
  });
});
