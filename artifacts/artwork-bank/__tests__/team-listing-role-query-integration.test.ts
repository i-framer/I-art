/**
 * Team listing role query — real-DB integration.
 *
 * app/(admin)/settings/team/page.tsx queries tenantUsersTable by tenantId,
 * then loads each user's email from usersTable.
 *
 * This suite verifies the query contract:
 *
 *  1. All team members are returned with their role and email.
 *  2. Owner role is returned correctly for the owner row.
 *  3. Staff role is returned correctly for a staff row.
 *  4. Foreign-tenant members are not included.
 *  5. The query returns member userId, role, and email for each member.
 *  6. Removing a member removes them from the listing.
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, usersTable, tenantUsersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];
const createdMembershipIds: string[] = []; // track (tenantId, userId) pairs

function uid() { return `${randomUUID()}-tlrq-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Team Listing Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createUser(email?: string) {
  const id = uid();
  await db.insert(usersTable).values({
    id, email: email ?? `user-${id}@test.com`, passwordHash: "x",
  } as any);
  createdUserIds.push(id);
  return id;
}

async function addMember(tenantId: string, userId: string, role: "owner" | "staff") {
  await db.insert(tenantUsersTable).values({ tenantId, userId, role } as any);
  createdMembershipIds.push(`${tenantId}:${userId}`);
}

/** Mirror the team page query. */
async function teamListing(tenantId: string, _currentUserId: string) {
  const memberships = await db.query.tenantUsersTable.findMany({
    where: eq(tenantUsersTable.tenantId, tenantId),
  });
  const memberDetails = await Promise.all(
    memberships.map(async (m) => {
      const user = await db.query.usersTable.findFirst({
        where: eq(usersTable.id, m.userId),
      });
      return {
        userId: m.userId,
        role: m.role,
        email: user?.email ?? m.userId,
      };
    }),
  );
  return memberDetails;
}

async function cleanup() {
  for (const pair of createdMembershipIds.splice(0)) {
    const [tenantId, userId] = pair.split(":");
    if (tenantId && userId) {
      await db.delete(tenantUsersTable)
        .where(eq(tenantUsersTable.tenantId, tenantId) as any)
        .catch(() => {});
    }
  }
  for (const id of createdUserIds.splice(0)) {
    await db.delete(usersTable).where(eq(usersTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Team listing role query — real-DB integration", () => {
  it("all team members are returned with their role and email", async () => {
    const tenantId = await createTenant();
    const ownerId  = await createUser("owner@test.com");
    const staffId  = await createUser("staff@test.com");
    await addMember(tenantId, ownerId, "owner");
    await addMember(tenantId, staffId, "staff");

    const members = await teamListing(tenantId, ownerId);
    const ownerEntry = members.find(m => m.userId === ownerId);
    const staffEntry = members.find(m => m.userId === staffId);

    expect(ownerEntry?.role).toBe("owner");
    expect(ownerEntry?.email).toBe("owner@test.com");
    expect(staffEntry?.role).toBe("staff");
    expect(staffEntry?.email).toBe("staff@test.com");
  });

  it("owner role is returned correctly for the owner row", async () => {
    const tenantId = await createTenant();
    const ownerId  = await createUser("gallery-owner@test.com");
    await addMember(tenantId, ownerId, "owner");

    const members = await teamListing(tenantId, ownerId);
    expect(members.find(m => m.userId === ownerId)?.role).toBe("owner");
  });

  it("staff role is returned correctly for a staff row", async () => {
    const tenantId = await createTenant();
    const ownerId  = await createUser("owner2@test.com");
    const staffId  = await createUser("gallery-staff@test.com");
    await addMember(tenantId, ownerId, "owner");
    await addMember(tenantId, staffId, "staff");

    const members = await teamListing(tenantId, ownerId);
    expect(members.find(m => m.userId === staffId)?.role).toBe("staff");
  });

  it("foreign-tenant members are not included in the listing", async () => {
    const ownTenantId     = await createTenant();
    const foreignTenantId = await createTenant();
    const ownUserId       = await createUser("own-user@test.com");
    const foreignUserId   = await createUser("foreign-user@test.com");
    await addMember(ownTenantId, ownUserId, "owner");
    await addMember(foreignTenantId, foreignUserId, "owner");

    const members = await teamListing(ownTenantId, ownUserId);
    const userIds = members.map(m => m.userId);

    expect(userIds).toContain(ownUserId);
    expect(userIds).not.toContain(foreignUserId);
  });

  it("removing a member removes them from the listing", async () => {
    const tenantId = await createTenant();
    const ownerId  = await createUser("keep@test.com");
    const staffId  = await createUser("remove@test.com");
    await addMember(tenantId, ownerId, "owner");
    await addMember(tenantId, staffId, "staff");

    // Confirm both appear.
    const before = await teamListing(tenantId, ownerId);
    expect(before.map(m => m.userId)).toContain(staffId);

    // Remove staff member.
    await db.delete(tenantUsersTable)
      .where(eq(tenantUsersTable.userId, staffId) as any);
    createdMembershipIds.splice(
      createdMembershipIds.indexOf(`${tenantId}:${staffId}`), 1,
    );

    const after = await teamListing(tenantId, ownerId);
    expect(after.map(m => m.userId)).not.toContain(staffId);
    expect(after.map(m => m.userId)).toContain(ownerId);
  });
});
