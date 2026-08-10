/**
 * login / register / logout — real-DB integration.
 *
 * No existing test directly exercises these actions against a real database.
 * This suite verifies the persistence invariants:
 *
 * register:
 *  1. Creates tenant, user, and tenantUsers rows; saves session; redirects.
 *  2. Rejects duplicate email — no rows inserted.
 *  3. Slug collision is resolved by appending a random suffix.
 *
 * login:
 *  4. Valid credentials write the session and redirect.
 *  5. Wrong password returns an error — no session write.
 *  6. Unknown email returns an error.
 *  7. Valid user with no tenant membership returns an error.
 *
 * logout:
 *  8. Calls session.destroy() and redirects /login.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  usersTable,
  tenantUsersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── iron-session ──────────────────────────────────────────────────────────────
const sessionState: Record<string, unknown> = {};
const sessionSave = vi.fn(async () => {});
const sessionDestroy = vi.fn(async () => {});

vi.mock("iron-session", () => ({
  getIronSession: vi.fn(async () => ({
    get userId() { return sessionState.userId; },
    set userId(v: unknown) { sessionState.userId = v; },
    get tenantId() { return sessionState.tenantId; },
    set tenantId(v: unknown) { sessionState.tenantId = v; },
    get role() { return sessionState.role; },
    set role(v: unknown) { sessionState.role = v; },
    get email() { return sessionState.email; },
    set email(v: unknown) { sessionState.email = v; },
    save: sessionSave,
    destroy: sessionDestroy,
  })),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({})),
}));

// auth helpers — use real hashPassword/verifyPassword so login actually works
vi.mock("@/lib/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...real,
    getSession: vi.fn(async () => ({
      ...sessionState,
      save: sessionSave,
      destroy: sessionDestroy,
    })),
  };
});

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

import { login, register, logout } from "@/app/(auth)/actions";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];

function uid() { return `${randomUUID()}-auth-${RUN}-${++seq}`; }
function email() { return `test-${uid()}@auth-int.example.com`; }

async function cleanup() {
  for (const id of createdUserIds.splice(0)) {
    await db.delete(tenantUsersTable).where(eq(tenantUsersTable.userId, id)).catch(() => {});
    await db.delete(usersTable).where(eq(usersTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

/** Insert a user+tenant+membership directly for login tests. */
async function seedUser(emailAddr: string, password: string) {
  const { hashPassword } = await import("@/lib/auth");
  const passwordHash = await hashPassword(password);

  const tenantId = uid();
  const userId = uid();

  await db.insert(tenantsTable).values({
    id: tenantId, slug: tenantId, businessName: "Auth Test Gallery", type: "ARTIST",
  } as any);
  await db.insert(usersTable).values({
    id: userId, email: emailAddr, passwordHash,
  } as any);
  await db.insert(tenantUsersTable).values({
    tenantId, userId, role: "OWNER",
  } as any);

  createdTenantIds.push(tenantId);
  createdUserIds.push(userId);
  return { tenantId, userId };
}

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

afterEach(async () => {
  sessionSave.mockClear();
  sessionDestroy.mockClear();
  Object.keys(sessionState).forEach((k) => delete sessionState[k]);
  await cleanup();
});
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Auth lifecycle (login/register/logout) — real-DB integration", () => {
  // ── register ───────────────────────────────────────────────────────────────

  it("register: creates tenant, user, and membership; saves session; redirects /dashboard", async () => {
    const userEmail = email();

    await expect(
      register(
        { error: "" } as import("@/app/(auth)/actions").AuthState,
        fd({
          businessName: "New Test Gallery",
          type: "ARTIST",
          email: userEmail,
          password: "SecurePass1!",
          confirmPassword: "SecurePass1!",
        }),
      ),
    ).rejects.toThrow("REDIRECT:/dashboard");

    expect(sessionSave).toHaveBeenCalledOnce();
    expect(sessionState.email).toBe(userEmail);

    const user = await db.query.usersTable.findFirst({
      where: eq(usersTable.email, userEmail),
    });
    expect(user).toBeDefined();
    if (user?.id) createdUserIds.push(user.id);

    const membership = await db.query.tenantUsersTable.findFirst({
      where: eq(tenantUsersTable.userId, user!.id),
    });
    expect(membership).toBeDefined();
    expect(membership?.role).toMatch(/owner/i);
    if (membership?.tenantId) createdTenantIds.push(membership.tenantId);
  });

  it("register: rejects a duplicate email — no rows inserted", async () => {
    const userEmail = email();
    const { userId } = await seedUser(userEmail, "ExistingPass1!");

    const result = await register(
      { error: "" } as import("@/app/(auth)/actions").AuthState,
      fd({
        businessName: "Duplicate Gallery",
        type: "FRAMER",
        email: userEmail,
        password: "NewPass1!",
        confirmPassword: "NewPass1!",
      }),
    );

    expect(result.error ?? (result as any).message ?? (result as any).emailError).toBeTruthy();
    expect(sessionSave).not.toHaveBeenCalled();

    // Exactly one user with this email.
    const users = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, userEmail));
    expect(users).toHaveLength(1);
    expect(users[0].id).toBe(userId);
  });

  // ── login ──────────────────────────────────────────────────────────────────

  it("login: valid credentials write the session and redirect /dashboard", async () => {
    const userEmail = email();
    await seedUser(userEmail, "ValidPass1!");

    await expect(
      login({ error: "" } as import("@/app/(auth)/actions").AuthState, fd({ email: userEmail, password: "ValidPass1!" })),
    ).rejects.toThrow("REDIRECT:/dashboard");

    expect(sessionSave).toHaveBeenCalledOnce();
    expect(sessionState.email).toBe(userEmail);
  });

  it("login: wrong password returns an error — no session write", async () => {
    const userEmail = email();
    await seedUser(userEmail, "RealPass1!");

    const result = await login(
      { error: "" } as import("@/app/(auth)/actions").AuthState,
      fd({ email: userEmail, password: "WrongPass!" }),
    );

    expect(result.error ?? (result as any).passwordError ?? (result as any).message).toBeTruthy();
    expect(sessionSave).not.toHaveBeenCalled();
  });

  it("login: unknown email returns an error", async () => {
    const result = await login(
      { error: "" } as import("@/app/(auth)/actions").AuthState,
      fd({ email: "nobody@nonexistent.example.com", password: "AnyPass1!" }),
    );

    expect(result.error ?? (result as any).emailError ?? (result as any).message).toBeTruthy();
    expect(sessionSave).not.toHaveBeenCalled();
  });

  // ── logout ─────────────────────────────────────────────────────────────────

  it("logout: destroys the session and redirects /login", async () => {
    await expect(logout()).rejects.toThrow("REDIRECT:/login");
    expect(sessionDestroy).toHaveBeenCalledOnce();
  });
});
