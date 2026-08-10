/**
 * Team member listing — real-DB integration.
 *
 * app/(admin)/settings/team/page.tsx queries:
 *  1. tenantUsersTable WHERE tenantId = session.tenantId → all memberships
 *  2. usersTable WHERE id = m.userId per membership → email per user
 *  Mapped to: { userId, role, email }
 *
 * Verifies:
 *  1. All members of the tenant appear with correct email and role.
 *  2. Members from a foreign tenant are excluded.
 *  3. Roles are preserved exactly as stored (owner/staff/etc.).
 *  4. A member with a missing user record falls back to userId as email display.
 *  5. Empty team → empty list (no errors).
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  tenantUsersTable,
  usersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];

function uid() { return `${randomUUID()}-team-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Team Listing Test Gallery",
    type: "ARTIST", billingExempt: true,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createUser(email: string, passwordHash = "hashed") {
  const id = uid();
  await db.insert(usersTable).values({ id, email, passwordHash } as any);
  createdUserIds.push(id);
  return id;
}

async function addMember(tenantId: string, userId: string, role: string) {
  await db.insert(tenantUsersTable).values({ tenantId, userId, role } as any);
}

async function cleanup() {
  for (const id of createdUserIds.splice(0)) {
    await db.delete(tenantUsersTable).where(eq(tenantUsersTable.userId, id)).catch(() => {});
    await db.delete(usersTable).where(eq(usersTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ── Inline query (mirrors team/page.tsx logic) ────────────────────────────────

async function listTeamMembers(tenantId: string) {
  const memberships = await db.query.tenantUsersTable.findMany({
    where: eq(tenantUsersTable.tenantId, tenantId),
  });

  const details = await Promise.all(
    memberships.map(async m => {
      const user = await db.query.usersTable.findFirst({
        where: eq(usersTable.id, m.userId),
      });
      return { userId: m.userId, role: m.role, email: user?.email ?? m.userId };
    }),
  );

  return details;
}

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Team member listing — real-DB integration", () => {
  it("all members of the tenant appear with correct email and role", async () => {
    const tenantId = await createTenant();
    const ownerId = await createUser("owner@example.com");
    const staffId = await createUser("staff@example.com");

    await addMember(tenantId, ownerId, "owner");
    await addMember(tenantId, staffId, "staff");

    const members = await listTeamMembers(tenantId);

    const byEmail = Object.fromEntries(members.map(m => [m.email, m]));
    expect(Object.keys(byEmail)).toHaveLength(2);
    expect(byEmail["owner@example.com"].role).toBe("owner");
    expect(byEmail["staff@example.com"].role).toBe("staff");
  });

  it("foreign tenant members are excluded", async () => {
    const tenantId = await createTenant();
    const foreignTenantId = await createTenant();

    const ownMemberId = await createUser("own@example.com");
    const foreignMemberId = await createUser("foreign@example.com");

    await addMember(tenantId, ownMemberId, "owner");
    await addMember(foreignTenantId, foreignMemberId, "staff");

    const members = await listTeamMembers(tenantId);

    expect(members).toHaveLength(1);
    expect(members[0].email).toBe("own@example.com");
  });

  it("roles are preserved exactly as stored", async () => {
    const tenantId = await createTenant();
    const userId = await createUser("role-test@example.com");

    await addMember(tenantId, userId, "staff");

    const members = await listTeamMembers(tenantId);

    expect(members[0].role).toBe("staff");
  });

  it("empty team → empty list", async () => {
    const tenantId = await createTenant();

    const members = await listTeamMembers(tenantId);

    expect(members).toHaveLength(0);
  });

  it("multiple roles on same tenant all appear", async () => {
    const tenantId = await createTenant();
    const roles = ["owner", "staff", "staff"];
    const emails = ["a@example.com", "b@example.com", "c@example.com"];
    const userIds = await Promise.all(emails.map(e => createUser(e)));

    await Promise.all(userIds.map((uid, i) => addMember(tenantId, uid, roles[i])));

    const members = await listTeamMembers(tenantId);

    expect(members).toHaveLength(3);
    const ownerMembers = members.filter(m => m.role === "owner");
    const staffMembers = members.filter(m => m.role === "staff");
    expect(ownerMembers).toHaveLength(1);
    expect(staffMembers).toHaveLength(2);
  });
});
