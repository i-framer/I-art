/**
 * tenantUsers listing (gallery members) — real-DB integration.
 *
 * Reads from tenantUsersTable joined with usersTable.
 * Used by app/(admin)/settings/team/page.tsx.
 *
 *  1. Members of a tenant are returned in the listing.
 *  2. Members of another tenant are NOT returned.
 *  3. Multiple members of the same tenant are all returned.
 *  4. Owner role is preserved in the listing.
 *  5. Member role is preserved in the listing.
 *  6. Removing a member removes them from the listing.
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, usersTable, tenantUsersTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];

function uid() { return `${randomUUID()}-tuli-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({ id, slug: id, businessName: "Team Test", type: "ARTIST" } as any);
  createdTenantIds.push(id);
  return id;
}

async function createUser() {
  const id = uid();
  await db.insert(usersTable).values({ id, email: `u-${id}@test.com`, passwordHash: "x" } as any);
  createdUserIds.push(id);
  return id;
}

async function addMember(tenantId: string, userId: string, role: "owner" | "member" = "member") {
  await db.insert(tenantUsersTable).values({ tenantId, userId, role } as any);
}

async function listMembers(tenantId: string) {
  return db
    .select({
      userId: tenantUsersTable.userId,
      role: tenantUsersTable.role,
      email: usersTable.email,
    })
    .from(tenantUsersTable)
    .innerJoin(usersTable, eq(usersTable.id, tenantUsersTable.userId))
    .where(eq(tenantUsersTable.tenantId, tenantId));
}

async function cleanup() {
  for (const id of createdUserIds.splice(0)) {
    await db.delete(tenantUsersTable).where(eq(tenantUsersTable.userId, id)).catch(() => {});
    await db.delete(usersTable).where(eq(usersTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantUsersTable).where(eq(tenantUsersTable.tenantId, id)).catch(() => {});
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("tenantUsers listing (gallery members) — real-DB integration", () => {
  it("members of a tenant are returned in the listing", async () => {
    const tenantId = await createTenant();
    const userId   = await createUser();
    await addMember(tenantId, userId);

    const members = await listMembers(tenantId);
    expect(members.map(m => m.userId)).toContain(userId);
  });

  it("members of another tenant are NOT returned", async () => {
    const tenantA  = await createTenant();
    const tenantB  = await createTenant();
    const userA    = await createUser();
    const userB    = await createUser();
    await addMember(tenantA, userA);
    await addMember(tenantB, userB);

    const membersA = await listMembers(tenantA);
    const idsA = membersA.map(m => m.userId);

    expect(idsA).toContain(userA);
    expect(idsA).not.toContain(userB);
  });

  it("multiple members of the same tenant are all returned", async () => {
    const tenantId = await createTenant();
    const user1    = await createUser();
    const user2    = await createUser();
    const user3    = await createUser();
    await addMember(tenantId, user1, "owner");
    await addMember(tenantId, user2);
    await addMember(tenantId, user3);

    const members = await listMembers(tenantId);
    const ids = members.map(m => m.userId);

    expect(ids).toContain(user1);
    expect(ids).toContain(user2);
    expect(ids).toContain(user3);
    expect(members).toHaveLength(3);
  });

  it("owner role is preserved in the listing", async () => {
    const tenantId = await createTenant();
    const ownerId  = await createUser();
    await addMember(tenantId, ownerId, "owner");

    const members = await listMembers(tenantId);
    const owner = members.find(m => m.userId === ownerId);

    expect(owner?.role).toBe("owner");
  });

  it("member role is preserved in the listing", async () => {
    const tenantId  = await createTenant();
    const memberId  = await createUser();
    await addMember(tenantId, memberId, "member");

    const members = await listMembers(tenantId);
    const member = members.find(m => m.userId === memberId);

    expect(member?.role).toBe("member");
  });

  it("removing a member removes them from the listing", async () => {
    const tenantId = await createTenant();
    const userId   = await createUser();
    await addMember(tenantId, userId);

    // Verify they're present.
    const before = await listMembers(tenantId);
    expect(before.map(m => m.userId)).toContain(userId);

    // Remove them.
    await db.delete(tenantUsersTable)
      .where(and(eq(tenantUsersTable.tenantId, tenantId), eq(tenantUsersTable.userId, userId)));

    const after = await listMembers(tenantId);
    expect(after.map(m => m.userId)).not.toContain(userId);
  });
});
