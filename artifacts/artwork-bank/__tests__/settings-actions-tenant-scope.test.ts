/**
 * Regression tests: settings & team admin actions (updateTenantSettings,
 * createInvite, custom-domain actions, removeTeamMember, startStripeOnboarding)
 * must scope every lookup and mutation by the session's tenantId so a gallery
 * can never edit another gallery's business details, domain, or staff list.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const state = vi.hoisted(() => ({
  updates: [] as { table: any; vals: any; where: any }[],
  deletes: [] as { table: any; where: any }[],
  inserts: [] as { table: any; vals: any }[],
  tenantFindWhere: null as any,
}));

const tables = vi.hoisted(() => ({
  tenantsTable: {
    id: "tenants.id",
    customDomain: "tenants.customDomain",
  },
  staffInvitesTable: { tenantId: "staffInvites.tenantId" },
  tenantUsersTable: {
    tenantId: "tenantUsers.tenantId",
    userId: "tenantUsers.userId",
  },
}));

const tenantFindFirst = vi.hoisted(() => vi.fn());

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      tenantsTable: {
        findFirst: (opts: any) => {
          state.tenantFindWhere = opts?.where;
          return tenantFindFirst(opts);
        },
      },
    },
    insert: vi.fn((table: any) => ({
      values: (vals: any) => {
        state.inserts.push({ table, vals });
        return Promise.resolve();
      },
    })),
    update: vi.fn((table: any) => ({
      set: (vals: any) => ({
        where: (where: any) => {
          state.updates.push({ table, vals, where });
          return Promise.resolve();
        },
      }),
    })),
    delete: vi.fn((table: any) => ({
      where: (where: any) => {
        state.deletes.push({ table, where });
        return Promise.resolve();
      },
    })),
  },
  ...tables,
}));

const getSession = vi.hoisted(() =>
  vi.fn(async () => ({ userId: "user-1", tenantId: "tenant-A", role: "owner" })),
);
vi.mock("@/lib/auth", () => ({
  getSession: () => getSession(),
  generateToken: () => "tok-123",
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("node:dns/promises", () => ({
  resolveCname: vi.fn(async () => {
    throw new Error("ENODATA");
  }),
}));

vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(async () => {
    throw new Error("not configured");
  }),
}));

import {
  updateTenantSettings,
  createInvite,
  saveCustomDomain,
  removeCustomDomain,
  verifyCustomDomain,
  removeTeamMember,
  startStripeOnboarding,
  startSubscriptionCheckout,
  type InviteResultState,
} from "@/app/(admin)/settings/actions";
import { and, eq } from "drizzle-orm";

const prevInvite: InviteResultState = {
  error: "",
  success: false,
  inviteUrl: "",
  email: "",
};

function settingsForm() {
  const fd = new FormData();
  fd.set("businessName", "Gallery B");
  fd.set("themeColor", "#123456");
  fd.set("aboutText", "About");
  fd.set("contactEmail", "b@example.com");
  return fd;
}

const asTenantB = (role = "owner") =>
  getSession.mockResolvedValue({
    userId: "user-2",
    tenantId: "tenant-B",
    role,
  } as any);

beforeEach(() => {
  vi.clearAllMocks();
  state.updates.length = 0;
  state.deletes.length = 0;
  state.inserts.length = 0;
  state.tenantFindWhere = null;
  getSession.mockResolvedValue({
    userId: "user-1",
    tenantId: "tenant-A",
    role: "owner",
  } as any);
  tenantFindFirst.mockResolvedValue(undefined);
});

describe("updateTenantSettings tenant scoping", () => {
  it("only ever updates the session's own tenant row", async () => {
    asTenantB();
    await expect(updateTenantSettings(settingsForm())).rejects.toThrow(
      "REDIRECT:/settings?saved=1",
    );
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].table).toBe(tables.tenantsTable);
    // where clause carries tenant-B, so tenant-A's row can never match
    expect(JSON.stringify(state.updates[0].where)).toEqual(
      JSON.stringify(eq(tables.tenantsTable.id as any, "tenant-B")),
    );
  });

  it("never accepts a tenant id from form data", async () => {
    const fd = settingsForm();
    fd.set("tenantId", "tenant-B");
    fd.set("id", "tenant-B");
    await expect(updateTenantSettings(fd)).rejects.toThrow(
      "REDIRECT:/settings?saved=1",
    );
    expect(JSON.stringify(state.updates[0].where)).toEqual(
      JSON.stringify(eq(tables.tenantsTable.id as any, "tenant-A")),
    );
  });
});

describe("createInvite tenant scoping", () => {
  it("always inserts the invite under the session tenantId", async () => {
    asTenantB();
    const fd = new FormData();
    fd.set("email", "new@example.com");
    fd.set("role", "staff");
    // even if a caller smuggles a tenantId field, it is ignored
    fd.set("tenantId", "tenant-A");
    const res = await createInvite(prevInvite, fd);
    expect(res.success).toBe(true);
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0].table).toBe(tables.staffInvitesTable);
    expect(state.inserts[0].vals.tenantId).toBe("tenant-B");
  });

  it("rejects non-owners and inserts nothing", async () => {
    asTenantB("staff");
    const fd = new FormData();
    fd.set("email", "new@example.com");
    fd.set("role", "owner");
    const res = await createInvite(prevInvite, fd);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Only owners/);
    expect(state.inserts).toEqual([]);
  });
});

describe("custom domain actions tenant scoping", () => {
  it("saveCustomDomain refuses a domain owned by another tenant and modifies nothing", async () => {
    tenantFindFirst.mockResolvedValue({
      id: "tenant-A",
      customDomain: "www.gallery-a.com",
    });
    asTenantB();
    const fd = new FormData();
    fd.set("customDomain", "www.gallery-a.com");
    const res = await saveCustomDomain({ error: null }, fd);
    expect(res).toEqual({
      error: "This domain is already in use by another gallery.",
    });
    expect(state.updates).toEqual([]);
  });

  it("saveCustomDomain scopes the update to the session tenant", async () => {
    tenantFindFirst.mockResolvedValue(undefined);
    asTenantB();
    const fd = new FormData();
    fd.set("customDomain", "www.gallery-b.com");
    await expect(saveCustomDomain({ error: null }, fd)).rejects.toThrow(
      "REDIRECT:/settings?domain_status=saved",
    );
    expect(state.updates).toHaveLength(1);
    expect(JSON.stringify(state.updates[0].where)).toEqual(
      JSON.stringify(eq(tables.tenantsTable.id as any, "tenant-B")),
    );
  });

  it("removeCustomDomain only clears the session tenant's domain", async () => {
    asTenantB();
    await expect(removeCustomDomain()).rejects.toThrow("REDIRECT:/settings");
    expect(state.updates).toHaveLength(1);
    expect(JSON.stringify(state.updates[0].where)).toEqual(
      JSON.stringify(eq(tables.tenantsTable.id as any, "tenant-B")),
    );
    expect(state.updates[0].vals).toMatchObject({ customDomain: null });
  });

  it("verifyCustomDomain looks up and updates only the session tenant", async () => {
    tenantFindFirst.mockResolvedValue({
      id: "tenant-B",
      customDomain: "www.gallery-b.com",
    });
    asTenantB();
    await expect(verifyCustomDomain()).rejects.toThrow(
      "REDIRECT:/settings?domain_status=unverified",
    );
    expect(JSON.stringify(state.tenantFindWhere)).toEqual(
      JSON.stringify(eq(tables.tenantsTable.id as any, "tenant-B")),
    );
    expect(state.updates).toHaveLength(1);
    expect(JSON.stringify(state.updates[0].where)).toEqual(
      JSON.stringify(eq(tables.tenantsTable.id as any, "tenant-B")),
    );
  });
});

describe("removeTeamMember tenant scoping", () => {
  it("scopes the delete by the session tenantId so another gallery's staff can't be removed", async () => {
    asTenantB();
    await removeTeamMember("user-9");
    expect(state.deletes).toHaveLength(1);
    expect(state.deletes[0].table).toBe(tables.tenantUsersTable);
    expect(JSON.stringify(state.deletes[0].where)).toEqual(
      JSON.stringify(
        and(
          eq(tables.tenantUsersTable.tenantId as any, "tenant-B"),
          eq(tables.tenantUsersTable.userId as any, "user-9"),
        ),
      ),
    );
  });

  it("rejects non-owners and deletes nothing", async () => {
    asTenantB("staff");
    await removeTeamMember("user-9");
    expect(state.deletes).toEqual([]);
  });

  it("refuses to remove yourself", async () => {
    await removeTeamMember("user-1");
    expect(state.deletes).toEqual([]);
  });
});

describe("startStripeOnboarding tenant scoping", () => {
  it("looks up only the session tenant and modifies nothing when Stripe is unavailable", async () => {
    tenantFindFirst.mockResolvedValue({ id: "tenant-B", stripeAccountId: null });
    asTenantB();
    await expect(startStripeOnboarding()).rejects.toThrow(
      "REDIRECT:/settings?stripe=not_configured",
    );
    expect(JSON.stringify(state.tenantFindWhere)).toEqual(
      JSON.stringify(eq(tables.tenantsTable.id as any, "tenant-B")),
    );
    expect(state.updates).toEqual([]);
  });

  it("rejects staff sessions with an unauthorized redirect and touches nothing", async () => {
    asTenantB("staff");
    await expect(startStripeOnboarding()).rejects.toThrow(
      "REDIRECT:/settings?stripe=unauthorized",
    );
    expect(state.updates).toEqual([]);
  });
});

describe("owner-only guards on destructive settings actions", () => {
  it("saveCustomDomain rejects staff and returns an error without touching the DB", async () => {
    asTenantB("staff");
    const fd = new FormData();
    fd.set("customDomain", "www.gallery-b.com");
    const res = await saveCustomDomain({ error: null }, fd);
    expect(res).toEqual({ error: "Only owners can manage custom domains." });
    expect(state.updates).toEqual([]);
  });

  it("removeCustomDomain rejects staff with an unauthorized redirect and touches nothing", async () => {
    asTenantB("staff");
    await expect(removeCustomDomain()).rejects.toThrow(
      "REDIRECT:/settings?error=unauthorized",
    );
    expect(state.updates).toEqual([]);
  });

  it("startSubscriptionCheckout rejects staff with an unauthorized redirect and touches nothing", async () => {
    asTenantB("staff");
    await expect(startSubscriptionCheckout()).rejects.toThrow(
      "REDIRECT:/settings/billing?billing=unauthorized",
    );
    expect(state.updates).toEqual([]);
  });
});
