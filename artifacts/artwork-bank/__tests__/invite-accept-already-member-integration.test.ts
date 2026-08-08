/**
 * Invite accept — existing user already a member — real-DB integration.
 *
 * When a user accepts an invite but is already a member of that tenant,
 * the system should not create a duplicate tenantUsers row.
 *
 * The invite accept flow:
 *   app/(auth)/actions.ts acceptInvite(token, email, password) or
 *   app/(auth)/accept-invite/actions.ts
 *
 * These tests exercise the DB directly to verify the membership uniqueness
 * contract, since the auth flow depends on the schema constraint or business
 * logic guard against duplicate membership.
 *
 *  1. Accepting an invite when already a STAFF member → no duplicate row.
 *  2. Accepting an invite when already an OWNER → no duplicate row created.
 *  3. After accepting with existing membership, row count stays at 1 per user+tenant.
 *  4. Distinct users can each have membership in the same tenant.
 *  5. After dedup, original role is preserved.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db, tenantsTable, usersTable, tenantUsersTable, invitesTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];
const createdInviteTokens: string[] = [];

function uid() { return `${randomUUID()}-iaamit-${RUN}-${++seq}`; }
function token() { return uid().replace(/-/g, ""); }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Invite Dup Test", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createUser(email?: string) {
  const id = uid();
  await db.insert(usersTable).values({
    id, email: email ?? `user-${id}@test.com`, passwordHash: "hash",
  } as any);
  createdUserIds.push(id);
  return id;
}

async function createMembership(tenantId: string, userId: string, role: "OWNER" | "STAFF") {
  await db.insert(tenantUsersTable).values({ tenantId, userId, role } as any);
}

async function createInvite(tenantId: string, inviteToken: string) {
  await db.insert(invitesTable).values({
    token: inviteToken,
    tenantId,
    role: "STAFF",
    email: null,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  } as any);
  createdInviteTokens.push(inviteToken);
}

async function membershipCount(tenantId: string, userId: string) {
  const rows = await db.query.tenantUsersTable.findMany({
    where: and(
      eq(tenantUsersTable.tenantId, tenantId),
      eq(tenantUsersTable.userId, userId),
    ),
  });
  return rows.length;
}

async function cleanup() {
  for (const t of createdInviteTokens.splice(0)) {
    await db.delete(invitesTable).where(eq(invitesTable.token, t)).catch(() => {});
  }
  for (const id of createdTenantIds) {
    await db.delete(tenantUsersTable).where(eq(tenantUsersTable.tenantId, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
  for (const id of createdUserIds.splice(0)) {
    await db.delete(usersTable).where(eq(usersTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Invite accept — duplicate membership prevention — real-DB integration", () => {
  it("existing STAFF membership: only one tenantUsers row exists per user+tenant pair", async () => {
    const tenantId = await createTenant();
    const userId   = await createUser();

    // Pre-create membership.
    await createMembership(tenantId, userId, "STAFF");

    // Attempt to insert again (simulating what a naïve accept-invite would do).
    // Schema-level unique constraint or conflict-handling should prevent duplicate.
    try {
      await db.insert(tenantUsersTable).values({ tenantId, userId, role: "STAFF" } as any);
    } catch {
      // Unique constraint violation expected — this is the correct behavior.
    }

    const count = await membershipCount(tenantId, userId);
    expect(count).toBe(1);
  });

  it("existing OWNER membership: only one tenantUsers row exists per user+tenant pair", async () => {
    const tenantId = await createTenant();
    const userId   = await createUser();

    await createMembership(tenantId, userId, "OWNER");

    try {
      await db.insert(tenantUsersTable).values({ tenantId, userId, role: "STAFF" } as any);
    } catch {
      // Unique constraint violation expected.
    }

    const count = await membershipCount(tenantId, userId);
    expect(count).toBe(1);
  });

  it("after dedup attempt, row count stays at 1 per user+tenant", async () => {
    const tenantId = await createTenant();
    const userId   = await createUser();

    await createMembership(tenantId, userId, "STAFF");

    // Three attempts to add the same membership.
    for (let i = 0; i < 3; i++) {
      try {
        await db.insert(tenantUsersTable).values({ tenantId, userId, role: "STAFF" } as any);
      } catch { /* expected */ }
    }

    expect(await membershipCount(tenantId, userId)).toBe(1);
  });

  it("distinct users can each have membership in the same tenant", async () => {
    const tenantId = await createTenant();
    const userA    = await createUser();
    const userB    = await createUser();

    await createMembership(tenantId, userA, "OWNER");
    await createMembership(tenantId, userB, "STAFF");

    expect(await membershipCount(tenantId, userA)).toBe(1);
    expect(await membershipCount(tenantId, userB)).toBe(1);
  });

  it("after dedup, original role is preserved on the surviving row", async () => {
    const tenantId = await createTenant();
    const userId   = await createUser();

    await createMembership(tenantId, userId, "OWNER");

    try {
      await db.insert(tenantUsersTable).values({ tenantId, userId, role: "STAFF" } as any);
    } catch { /* expected */ }

    const rows = await db.query.tenantUsersTable.findMany({
      where: and(
        eq(tenantUsersTable.tenantId, tenantId),
        eq(tenantUsersTable.userId, userId),
      ),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe("OWNER"); // original role preserved
  });
});
