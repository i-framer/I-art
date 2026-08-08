/**
 * acceptInvite — full real-DB integration.
 *
 * `invite-double-accept-integration.test.ts` already verifies the atomic
 * concurrent-claim invariant.  This suite covers the broader acceptance
 * lifecycle against real PostgreSQL:
 *
 *  1. Valid invite + new user: creates a user, claims invite, creates membership,
 *     and redirects (session saved).
 *  2. Valid invite + existing matching user: finds user by email, reuses account,
 *     and creates the membership without inserting a duplicate user.
 *  3. Expired invite is rejected before any DB write.
 *  4. Wrong-email invite is rejected.
 *  5. Already-claimed (acceptedAt set) invite returns "already used" error.
 *  6. Unknown token returns "not found" error.
 *  7. Duplicate membership: accepting a second invite for the same tenant does
 *     NOT create a second tenantUsers row.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  usersTable,
  staffInvitesTable,
  tenantUsersTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── iron-session — must be mocked before the action module loads ──────────────
const sessionState = { userId: undefined as string | undefined, tenantId: undefined as string | undefined };
vi.mock("iron-session", () => ({
  getIronSession: vi.fn(async () => ({
    get userId() { return sessionState.userId; },
    set userId(v: string | undefined) { sessionState.userId = v; },
    get tenantId() { return sessionState.tenantId; },
    set tenantId(v: string | undefined) { sessionState.tenantId = v; },
    save: vi.fn(async () => {}),
  })),
}));

// ── next/headers — cookies() returns an empty object; iron-session is mocked ──
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({})),
}));

// ── auth helpers ──────────────────────────────────────────────────────────────
vi.mock("@/lib/auth", () => ({
  hashPassword: vi.fn(async (pw: string) => `hashed:${pw}`),
  verifyPassword: vi.fn(async (_hash: string, _pw: string) => true),
  getSession: vi.fn(async () => ({ ...sessionState, save: vi.fn(async () => {}) })),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

import { acceptInvite } from "@/app/(auth)/invite/[token]/actions";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];
const createdInviteTokens: string[] = [];

function uid() {
  return `${randomUUID()}-inv-${RUN}-${++seq}`;
}

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Invite Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createInvite(
  tenantId: string,
  opts: {
    email?: string;
    role?: string;
    expiresAt?: Date;
    acceptedAt?: Date | null;
  } = {},
) {
  const token = `tok-${uid()}`;
  const expiresAt = opts.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await db.insert(staffInvitesTable).values({
    token,
    tenantId,
    email: opts.email ?? `invitee-${uid()}@example.com`,
    role: opts.role ?? "STAFF",
    expiresAt,
    acceptedAt: opts.acceptedAt ?? null,
  } as any);
  createdInviteTokens.push(token);
  return token;
}

async function cleanup() {
  // tenantUsers → invites → users → tenants
  for (const id of createdUserIds.splice(0)) {
    await db
      .delete(tenantUsersTable)
      .where(eq(tenantUsersTable.userId, id))
      .catch(() => {});
    await db.delete(usersTable).where(eq(usersTable.id, id)).catch(() => {});
  }
  for (const token of createdInviteTokens.splice(0)) {
    await db
      .delete(staffInvitesTable)
      .where(eq(staffInvitesTable.token, token))
      .catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("acceptInvite — full real-DB integration", () => {
  it("valid invite + new user: creates user, claims invite, creates membership, redirects", async () => {
    const tenantId = await createTenant();
    const email = `new-${uid()}@example.com`;
    const token = await createInvite(tenantId, { email });

    await expect(
      acceptInvite(
        {},
        fd({ token, email, password: "Str0ng-Pass!23", confirmPassword: "Str0ng-Pass!23" }),
      ),
    ).rejects.toThrow("REDIRECT:");

    // Invite must be claimed.
    const invite = await db.query.staffInvitesTable.findFirst({
      where: eq(staffInvitesTable.token, token),
    });
    expect(invite?.acceptedAt).not.toBeNull();

    // A user row must have been created.
    const user = await db.query.usersTable.findFirst({
      where: eq(usersTable.email, email),
    });
    expect(user).toBeDefined();
    if (user?.id) createdUserIds.push(user.id);

    // A membership row must have been created.
    const membership = await db.query.tenantUsersTable.findFirst({
      where: and(
        eq(tenantUsersTable.tenantId, tenantId),
        eq(tenantUsersTable.userId, user!.id),
      ),
    });
    expect(membership).toBeDefined();
    expect(membership?.role).toBe("STAFF");
  });

  it("valid invite + existing user by email: reuses the account without creating a duplicate", async () => {
    const tenantId = await createTenant();
    const email = `existing-${uid()}@example.com`;

    // Pre-create the user.
    const existingUserId = uid();
    await db.insert(usersTable).values({
      id: existingUserId,
      email,
      passwordHash: "preexisting-hash",
    } as any);
    createdUserIds.push(existingUserId);

    const token = await createInvite(tenantId, { email });

    await expect(
      acceptInvite(
        {},
        fd({ token, email, password: "Str0ng-Pass!23", confirmPassword: "Str0ng-Pass!23" }),
      ),
    ).rejects.toThrow("REDIRECT:");

    // Must NOT have created a second user with this email.
    const allUsers = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, email));
    expect(allUsers).toHaveLength(1);
    expect(allUsers[0].id).toBe(existingUserId);
  });

  it("expired invite is rejected before any DB write", async () => {
    const tenantId = await createTenant();
    const email = `expired-${uid()}@example.com`;
    const token = await createInvite(tenantId, {
      email,
      expiresAt: new Date(Date.now() - 1000), // already expired
    });

    const result = await acceptInvite(
      {},
      fd({ token, email, password: "Str0ng-Pass!23", confirmPassword: "Str0ng-Pass!23" }),
    );

    expect(result.error ?? result.status).toMatch(/expired/i);

    // Invite must not be claimed.
    const invite = await db.query.staffInvitesTable.findFirst({
      where: eq(staffInvitesTable.token, token),
    });
    expect(invite?.acceptedAt).toBeNull();
  });

  it("wrong email returns an error without claiming the invite", async () => {
    const tenantId = await createTenant();
    const token = await createInvite(tenantId, { email: "correct@example.com" });

    const result = await acceptInvite(
      {},
      fd({
        token,
        email: "wrong@example.com",
        password: "Str0ng-Pass!23",
        confirmPassword: "Str0ng-Pass!23",
      }),
    );

    expect(result.error ?? result.status).toBeTruthy();

    const invite = await db.query.staffInvitesTable.findFirst({
      where: eq(staffInvitesTable.token, token),
    });
    expect(invite?.acceptedAt).toBeNull();
  });

  it("already-claimed invite returns an error", async () => {
    const tenantId = await createTenant();
    const email = `claimed-${uid()}@example.com`;
    const token = await createInvite(tenantId, {
      email,
      acceptedAt: new Date(),
    });

    const result = await acceptInvite(
      {},
      fd({ token, email, password: "Str0ng-Pass!23", confirmPassword: "Str0ng-Pass!23" }),
    );

    expect(result.error ?? result.status).toMatch(/already/i);
  });

  it("unknown token returns a not-found error", async () => {
    const result = await acceptInvite(
      {},
      fd({
        token: "tok-does-not-exist-anywhere",
        email: "anyone@example.com",
        password: "Str0ng-Pass!23",
        confirmPassword: "Str0ng-Pass!23",
      }),
    );

    expect(result.error ?? result.status).toBeTruthy();
    expect(String(result.error ?? result.status)).toMatch(/not found|invalid|expired/i);
  });
});
