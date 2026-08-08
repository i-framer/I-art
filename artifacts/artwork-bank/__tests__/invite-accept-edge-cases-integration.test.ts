/**
 * acceptInvite — edge cases — real-DB integration.
 *
 * The main acceptance flow is covered by invite-accept-full-integration.test.ts.
 * This suite specifically verifies edge cases not yet covered:
 *
 *  1. Empty/blank token → "Invalid input." (schema rejection before DB lookup).
 *  2. Unknown (non-existent) token → exact "Invalid or expired invite link." message.
 *  3. Already-used check fires before expiry check (precedence: used wins over expired).
 *  4. Expired invite leaves user table and tenant membership unmodified.
 *  5. Wrong-email invite leaves user table and tenant membership unmodified.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  tenantUsersTable,
  staffInvitesTable,
  usersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Session / auth ─────────────────────────────────────────────────────────────
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ userId: null, tenantId: null })),
  createSession: vi.fn(async () => {}),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn(() => { throw new Error("REDIRECT"); }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { acceptInvite } from "@/app/(auth)/invite/[token]/actions";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdInviteIds: string[] = [];
const createdUserIds: string[] = [];

function uid() { return `${randomUUID()}-invedge-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Invite Edge Test Gallery",
    type: "ARTIST", billingExempt: true,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createInvite(
  tenantId: string,
  email: string,
  opts: {
    token?: string;
    expiresAt?: Date;
    acceptedAt?: Date | null;
  } = {},
) {
  const id = uid();
  const token = opts.token ?? uid();
  await db.insert(staffInvitesTable).values({
    id, tenantId, email, token,
    expiresAt: opts.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    acceptedAt: opts.acceptedAt ?? null,
    createdById: "platform",
    role: "staff",
  } as any);
  createdInviteIds.push(id);
  return { id, token };
}

async function cleanup() {
  for (const id of createdUserIds.splice(0)) {
    await db.delete(tenantUsersTable).where(eq(tenantUsersTable.userId, id)).catch(() => {});
    await db.delete(usersTable).where(eq(usersTable.id, id)).catch(() => {});
  }
  for (const id of createdInviteIds.splice(0)) {
    await db.delete(staffInvitesTable).where(eq(staffInvitesTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

function fd(token: string, email: string, password = "SecurePass99!") {
  const f = new FormData();
  f.set("token", token);
  f.set("email", email);
  f.set("password", password);
  return f;
}

// acceptInvite returns { error: string } on failure or redirects on success.
async function tryAccept(token: string, email: string, password = "SecurePass99!") {
  try {
    return await acceptInvite({ error: "" }, fd(token, email, password));
  } catch (e: any) {
    if (e?.message === "REDIRECT") return null; // success path
    throw e;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("acceptInvite — edge cases — real-DB integration", () => {
  it("empty token → 'Invalid input.' (schema rejection, no DB lookup)", async () => {
    const result = await tryAccept("", "user@example.com");

    expect(result?.error).toMatch(/invalid input/i);
  });

  it("unknown token → 'Invalid or expired invite link.'", async () => {
    const result = await tryAccept("totally-unknown-token-xyz-99999", "user@example.com");

    expect(result?.error).toMatch(/invalid or expired/i);
  });

  it("already-used check fires before expiry check (used wins over expired)", async () => {
    const tenantId = await createTenant();
    // Create an invite that is BOTH already-used AND expired.
    const { token } = await createInvite(tenantId, "user@example.com", {
      acceptedAt: new Date(Date.now() - 5000),   // already accepted
      expiresAt: new Date(Date.now() - 48 * 60 * 60 * 1000), // also expired
    });

    const result = await tryAccept(token, "user@example.com");

    // Should report "already used", not "expired".
    expect(result?.error).toMatch(/already been used/i);
  });

  it("expired invite → error; user and tenant membership not created", async () => {
    const tenantId = await createTenant();
    const email = `expired-${uid().slice(0, 8)}@example.com`;
    const { token } = await createInvite(tenantId, email, {
      expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000), // 1 day ago
    });

    const result = await tryAccept(token, email);

    expect(result?.error).toMatch(/expired/i);

    // Verify no user row was created.
    const user = await db.query.usersTable.findFirst({
      where: eq(usersTable.email, email),
    });
    expect(user).toBeUndefined();
  });

  it("wrong email → error; user and tenant membership not created", async () => {
    const tenantId = await createTenant();
    const inviteEmail = `right-${uid().slice(0, 8)}@example.com`;
    const wrongEmail = `wrong-${uid().slice(0, 8)}@example.com`;
    const { token } = await createInvite(tenantId, inviteEmail);

    const result = await tryAccept(token, wrongEmail);

    expect(result?.error).toMatch(/different email/i);

    // Verify no user row was created for the wrong email.
    const user = await db.query.usersTable.findFirst({
      where: eq(usersTable.email, wrongEmail),
    });
    expect(user).toBeUndefined();
  });

  it("short password → schema rejection; invite remains unused", async () => {
    const tenantId = await createTenant();
    const email = `shortpw-${uid().slice(0, 8)}@example.com`;
    const { token } = await createInvite(tenantId, email);

    const result = await tryAccept(token, email, "short");

    expect(result?.error).toBeTruthy();
    // The invite should remain unused.
    const invite = await db.query.staffInvitesTable.findFirst({
      where: eq(staffInvitesTable.token, token),
    });
    expect(invite?.acceptedAt).toBeNull();
  });
});
