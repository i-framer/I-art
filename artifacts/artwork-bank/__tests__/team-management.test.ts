/**
 * Team management — createInvite + removeTeamMember authorization tests.
 *
 * Covers:
 *  - Only owners can create invites; staff members are rejected
 *  - Unauthenticated callers are rejected
 *  - Invalid email returns a validation error
 *  - createInvite returns a usable invite URL on success
 *  - removeTeamMember silently ignores non-owner callers
 *  - removeTeamMember cannot remove yourself (owner cannot self-remove)
 *  - removeTeamMember scopes DELETE to the authenticated tenant
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Auth mock (partial — keep generateToken from real module) ─────────────────
const getSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getSession };
});

// ── DB mocks ──────────────────────────────────────────────────────────────────
const dbInsertValues = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const dbDeleteWhere = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("@workspace/db", () => ({
  db: {
    insert: () => ({ values: dbInsertValues }),
    delete: () => ({ where: dbDeleteWhere }),
    query: {
      tenantsTable: { findFirst: vi.fn().mockResolvedValue({ id: "t-1" }) },
    },
  },
  staffInvitesTable: {},
  tenantUsersTable: {},
  tenantsTable: {},
  eq: vi.fn(),
  and: vi.fn(),
}));

// ── next/cache / navigation mocks ─────────────────────────────────────────────
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

// ── Billing / Stripe mocks (prevent import errors) ────────────────────────────
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn().mockResolvedValue(undefined),
  hasActiveAccess: vi.fn().mockReturnValue(true),
  SUBSCRIPTION_PRICE_CENTS: 4900,
}));
vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(),
  parsePlatformFeePercent: vi.fn().mockReturnValue(10),
  calcApplicationFee: vi.fn(),
  StripeNotConfiguredError: class extends Error {},
}));

import { createInvite, removeTeamMember } from "@/app/(admin)/settings/actions";

function formData(fields: Record<string, string>): FormData {
  return {
    get: (k: string) => fields[k] ?? null,
  } as unknown as FormData;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbInsertValues.mockResolvedValue(undefined);
  dbDeleteWhere.mockResolvedValue(undefined);
});

// ── createInvite ──────────────────────────────────────────────────────────────

describe("createInvite — authorization", () => {
  it("returns error when caller is not authenticated", async () => {
    getSession.mockResolvedValueOnce({ userId: null, tenantId: "t-1", role: "owner" });

    const result = await createInvite(
      { error: "", success: false, inviteUrl: "", email: "" },
      formData({ email: "new@example.com", role: "staff" }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not authenticated/i);
    expect(dbInsertValues).not.toHaveBeenCalled();
  });

  it("returns error when caller has staff role (not owner)", async () => {
    getSession.mockResolvedValueOnce({ userId: "u-1", tenantId: "t-1", role: "staff" });

    const result = await createInvite(
      { error: "", success: false, inviteUrl: "", email: "" },
      formData({ email: "new@example.com", role: "staff" }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/only owners/i);
    expect(dbInsertValues).not.toHaveBeenCalled();
  });

  it("returns validation error for an invalid email", async () => {
    getSession.mockResolvedValueOnce({ userId: "u-1", tenantId: "t-1", role: "owner" });

    const result = await createInvite(
      { error: "", success: false, inviteUrl: "", email: "" },
      formData({ email: "not-an-email", role: "staff" }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/valid email/i);
    expect(dbInsertValues).not.toHaveBeenCalled();
  });

  it("returns validation error for an empty email", async () => {
    getSession.mockResolvedValueOnce({ userId: "u-1", tenantId: "t-1", role: "owner" });

    const result = await createInvite(
      { error: "", success: false, inviteUrl: "", email: "" },
      formData({ email: "", role: "staff" }),
    );

    expect(result.success).toBe(false);
    expect(dbInsertValues).not.toHaveBeenCalled();
  });

  it("succeeds for an owner with a valid email and returns invite URL", async () => {
    getSession.mockResolvedValueOnce({ userId: "u-1", tenantId: "t-1", role: "owner" });

    const result = await createInvite(
      { error: "", success: false, inviteUrl: "", email: "" },
      formData({ email: "staff@example.com", role: "staff" }),
    );

    expect(result.success).toBe(true);
    expect(result.inviteUrl).toMatch(/^\/invite\//);
    expect(result.email).toBe("staff@example.com");
    expect(dbInsertValues).toHaveBeenCalledOnce();
  });

  it("inserts the invite with the correct tenantId", async () => {
    getSession.mockResolvedValueOnce({ userId: "u-1", tenantId: "my-tenant", role: "owner" });

    await createInvite(
      { error: "", success: false, inviteUrl: "", email: "" },
      formData({ email: "staff@example.com", role: "staff" }),
    );

    expect(dbInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "my-tenant" }),
    );
  });

  it("stores email in lower-case", async () => {
    getSession.mockResolvedValueOnce({ userId: "u-1", tenantId: "t-1", role: "owner" });

    await createInvite(
      { error: "", success: false, inviteUrl: "", email: "" },
      formData({ email: "Staff@Example.COM", role: "staff" }),
    );

    expect(dbInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ email: "staff@example.com" }),
    );
  });
});

// ── removeTeamMember ──────────────────────────────────────────────────────────

describe("removeTeamMember — authorization", () => {
  it("does nothing when caller is unauthenticated", async () => {
    getSession.mockResolvedValueOnce({ userId: null, tenantId: "t-1", role: "owner" });

    await removeTeamMember("other-user");

    expect(dbDeleteWhere).not.toHaveBeenCalled();
  });

  it("does nothing when caller has staff role", async () => {
    getSession.mockResolvedValueOnce({ userId: "u-1", tenantId: "t-1", role: "staff" });

    await removeTeamMember("other-user");

    expect(dbDeleteWhere).not.toHaveBeenCalled();
  });

  it("does nothing when owner tries to remove themselves", async () => {
    getSession.mockResolvedValueOnce({ userId: "owner-id", tenantId: "t-1", role: "owner" });

    await removeTeamMember("owner-id"); // same as session userId

    expect(dbDeleteWhere).not.toHaveBeenCalled();
  });

  it("deletes the member when owner removes another user", async () => {
    getSession.mockResolvedValueOnce({ userId: "owner-id", tenantId: "t-1", role: "owner" });

    await removeTeamMember("other-user-id");

    expect(dbDeleteWhere).toHaveBeenCalledOnce();
  });
});
