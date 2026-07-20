/**
 * Regression tests: acceptInvite (staff invite acceptance) must only ever
 * enroll the user into the invite's OWN tenant with the invite's OWN role,
 * and must reject expired, already-used, or wrong-email tokens without
 * writing anything to the database.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const state = vi.hoisted(() => ({
  inserts: [] as { table: any; vals: any }[],
  updates: [] as { table: any; vals: any; where: any }[],
  inviteFindWhere: null as any,
  session: {} as Record<string, any>,
  sessionSaved: false,
}));

const tables = vi.hoisted(() => ({
  usersTable: { id: "users.id", email: "users.email" },
  tenantUsersTable: {
    tenantId: "tenantUsers.tenantId",
    userId: "tenantUsers.userId",
  },
  staffInvitesTable: {
    id: "staffInvites.id",
    token: "staffInvites.token",
    tenantId: "staffInvites.tenantId",
  },
}));

const inviteFindFirst = vi.hoisted(() => vi.fn());
const userFindFirst = vi.hoisted(() => vi.fn());
const tenantUserFindFirst = vi.hoisted(() => vi.fn());

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      staffInvitesTable: {
        findFirst: (opts: any) => {
          state.inviteFindWhere = opts?.where;
          return inviteFindFirst(opts);
        },
      },
      usersTable: { findFirst: (opts: any) => userFindFirst(opts) },
      tenantUsersTable: { findFirst: (opts: any) => tenantUserFindFirst(opts) },
    },
    insert: vi.fn((table: any) => ({
      values: (vals: any) => {
        state.inserts.push({ table, vals });
        return {
          returning: () =>
            Promise.resolve([{ id: "user-new", email: vals.email }]),
          then: (resolve: any) => resolve(undefined),
        };
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
  },
  ...tables,
}));

vi.mock("@/lib/auth", () => ({
  hashPassword: vi.fn(async () => "hashed-pw"),
  verifyPassword: vi.fn(async (pw: string) => pw === "correct-password"),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({})),
}));

vi.mock("iron-session", () => ({
  getIronSession: vi.fn(async () => ({
    ...state.session,
    save: async () => {
      state.sessionSaved = true;
    },
    set userId(v: any) {
      state.session.userId = v;
    },
    set tenantId(v: any) {
      state.session.tenantId = v;
    },
    set role(v: any) {
      state.session.role = v;
    },
    set email(v: any) {
      state.session.email = v;
    },
  })),
}));

import { acceptInvite } from "@/app/(auth)/invite/[token]/actions";

const FUTURE = new Date(Date.now() + 24 * 60 * 60 * 1000);
const PAST = new Date(Date.now() - 60 * 1000);

const validInvite = {
  id: "invite-1",
  token: "tok-abc",
  tenantId: "tenant-B",
  role: "staff",
  email: "new@example.com",
  acceptedAt: null,
  expiresAt: FUTURE,
};

function inviteForm(
  overrides: Partial<{ token: string; email: string; password: string }> = {},
) {
  const fd = new FormData();
  fd.set("token", overrides.token ?? "tok-abc");
  fd.set("email", overrides.email ?? "new@example.com");
  fd.set("password", overrides.password ?? "correct-password");
  // smuggled fields that must be ignored
  fd.set("tenantId", "tenant-EVIL");
  fd.set("role", "owner");
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.inserts.length = 0;
  state.updates.length = 0;
  state.inviteFindWhere = null;
  state.session = {};
  state.sessionSaved = false;
  inviteFindFirst.mockResolvedValue(validInvite);
  userFindFirst.mockResolvedValue(undefined);
  tenantUserFindFirst.mockResolvedValue(undefined);
});

describe("acceptInvite tenant scoping", () => {
  it("enrolls a new user only into the invite's own tenant and role, ignoring smuggled form fields", async () => {
    await expect(
      acceptInvite({ error: "" }, inviteForm()),
    ).rejects.toThrow("REDIRECT:/dashboard");

    const tuInserts = state.inserts.filter(
      (i) => i.table === tables.tenantUsersTable,
    );
    expect(tuInserts).toHaveLength(1);
    expect(tuInserts[0].vals).toEqual({
      tenantId: "tenant-B",
      userId: "user-new",
      role: "staff",
    });
    // session is bound to the invite's tenant/role, never the smuggled ones
    expect(state.session.tenantId).toBe("tenant-B");
    expect(state.session.role).toBe("staff");
    expect(state.sessionSaved).toBe(true);
  });

  it("enrolls an existing user only into the invite's tenant, scoped by both tenantId and userId on the membership check", async () => {
    userFindFirst.mockResolvedValue({
      id: "user-7",
      email: "new@example.com",
      passwordHash: "hash",
    });

    await expect(
      acceptInvite({ error: "" }, inviteForm()),
    ).rejects.toThrow("REDIRECT:/dashboard");

    const tuInserts = state.inserts.filter(
      (i) => i.table === tables.tenantUsersTable,
    );
    expect(tuInserts).toHaveLength(1);
    expect(tuInserts[0].vals).toEqual({
      tenantId: "tenant-B",
      userId: "user-7",
      role: "staff",
    });
  });

  it("does not create a duplicate membership row if the user already belongs to the tenant", async () => {
    userFindFirst.mockResolvedValue({
      id: "user-7",
      email: "new@example.com",
      passwordHash: "hash",
    });
    tenantUserFindFirst.mockResolvedValue({
      tenantId: "tenant-B",
      userId: "user-7",
    });

    await expect(
      acceptInvite({ error: "" }, inviteForm()),
    ).rejects.toThrow("REDIRECT:/dashboard");

    expect(
      state.inserts.filter((i) => i.table === tables.tenantUsersTable),
    ).toEqual([]);
    // invite is still marked accepted
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].table).toBe(tables.staffInvitesTable);
  });

  it("marks only the matched invite as accepted", async () => {
    await expect(
      acceptInvite({ error: "" }, inviteForm()),
    ).rejects.toThrow("REDIRECT:/dashboard");

    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].table).toBe(tables.staffInvitesTable);
    expect(state.updates[0].vals.acceptedAt).toBeInstanceOf(Date);
  });
});

describe("acceptInvite token rejection", () => {
  it("rejects an unknown token and writes nothing", async () => {
    inviteFindFirst.mockResolvedValue(undefined);
    const res = await acceptInvite({ error: "" }, inviteForm());
    expect(res.error).toMatch(/Invalid or expired/);
    expect(state.inserts).toEqual([]);
    expect(state.updates).toEqual([]);
    expect(state.sessionSaved).toBe(false);
  });

  it("rejects an already-used token and writes nothing", async () => {
    inviteFindFirst.mockResolvedValue({
      ...validInvite,
      acceptedAt: new Date(),
    });
    const res = await acceptInvite({ error: "" }, inviteForm());
    expect(res.error).toMatch(/already been used/);
    expect(state.inserts).toEqual([]);
    expect(state.updates).toEqual([]);
    expect(state.sessionSaved).toBe(false);
  });

  it("rejects an expired token and writes nothing", async () => {
    inviteFindFirst.mockResolvedValue({ ...validInvite, expiresAt: PAST });
    const res = await acceptInvite({ error: "" }, inviteForm());
    expect(res.error).toMatch(/expired/);
    expect(state.inserts).toEqual([]);
    expect(state.updates).toEqual([]);
    expect(state.sessionSaved).toBe(false);
  });

  it("rejects a token used with a different email (foreign invite) and writes nothing", async () => {
    const res = await acceptInvite(
      { error: "" },
      inviteForm({ email: "attacker@example.com" }),
    );
    expect(res.error).toMatch(/different email/);
    expect(state.inserts).toEqual([]);
    expect(state.updates).toEqual([]);
    expect(state.sessionSaved).toBe(false);
  });

  it("rejects a wrong password for an existing account and writes nothing", async () => {
    userFindFirst.mockResolvedValue({
      id: "user-7",
      email: "new@example.com",
      passwordHash: "hash",
    });
    const res = await acceptInvite(
      { error: "" },
      inviteForm({ password: "wrong-password" }),
    );
    expect(res.error).toMatch(/Incorrect password/);
    expect(state.inserts).toEqual([]);
    expect(state.updates).toEqual([]);
    expect(state.sessionSaved).toBe(false);
  });

  it("looks the invite up by its token only", async () => {
    const { eq } = await import("drizzle-orm");
    await expect(
      acceptInvite({ error: "" }, inviteForm()),
    ).rejects.toThrow("REDIRECT:/dashboard");
    expect(JSON.stringify(state.inviteFindWhere)).toEqual(
      JSON.stringify(eq(tables.staffInvitesTable.token as any, "tok-abc")),
    );
  });
});
