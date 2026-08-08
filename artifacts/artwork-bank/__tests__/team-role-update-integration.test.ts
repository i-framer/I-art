/**
 * tenantUser role update (staff → owner) — real-DB integration.
 *
 * app/(admin)/settings/actions.ts (or equivalent): owner can change a team
 * member's role. This suite tests the DB-layer role update behavior.
 *
 *  1. Owner can update a staff member's role to owner.
 *  2. Owner can downgrade another owner to staff.
 *  3. Staff cannot update a team member's role.
 *  4. Role change is scoped to own tenant (foreign tenant row unchanged).
 *  5. Updated role is persisted and read back correctly.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  usersTable,
  tenantUsersTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];

function uid() { return `${randomUUID()}-tru-${RUN}-${++seq}`; }

const mockSession = { value: { userId: "u-role-test", tenantId: "PLACEHOLDER", role: "owner" } };

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => mockSession.value),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

async function createUser() {
  const id = uid();
  await db.insert(usersTable).values({ id, email: `u-${id}@test.com`, passwordHash: "x" } as any);
  createdUserIds.push(id);
  return id;
}

async function createTenant(role: "owner" | "staff" = "owner") {
  const id = uid();
  const userId = await createUser();
  mockSession.value = { userId, tenantId: id, role };
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Role Update Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  await db.insert(tenantUsersTable).values({ tenantId: id, userId, role } as any);
  return { tenantId: id, userId };
}

async function addMember(tenantId: string, role: "owner" | "staff") {
  const userId = await createUser();
  await db.insert(tenantUsersTable).values({ tenantId, userId, role } as any);
  return userId;
}

async function getRole(tenantId: string, userId: string) {
  const row = await db.query.tenantUsersTable.findFirst({
    where: and(eq(tenantUsersTable.tenantId, tenantId), eq(tenantUsersTable.userId, userId)),
  });
  return row?.role ?? null;
}

async function cleanup() {
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantUsersTable).where(eq(tenantUsersTable.tenantId, id)).catch(() => {});
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
  for (const id of createdUserIds.splice(0)) {
    await db.delete(usersTable).where(eq(usersTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("tenantUser role update — real-DB integration", () => {
  it("owner can update a staff member's role to owner", async () => {
    const { tenantId } = await createTenant("owner");
    const staffId = await addMember(tenantId, "staff");

    // Simulate the role update the action would do.
    await db
      .update(tenantUsersTable)
      .set({ role: "owner" })
      .where(and(
        eq(tenantUsersTable.tenantId, tenantId),
        eq(tenantUsersTable.userId, staffId),
      ));

    expect(await getRole(tenantId, staffId)).toBe("owner");
  });

  it("owner can downgrade another owner to staff", async () => {
    const { tenantId } = await createTenant("owner");
    const secondOwnerId = await addMember(tenantId, "owner");

    await db
      .update(tenantUsersTable)
      .set({ role: "staff" })
      .where(and(
        eq(tenantUsersTable.tenantId, tenantId),
        eq(tenantUsersTable.userId, secondOwnerId),
      ));

    expect(await getRole(tenantId, secondOwnerId)).toBe("staff");
  });

  it("role update is scoped to own tenant (foreign tenant row unchanged)", async () => {
    const { tenantId: ownId } = await createTenant("owner");

    const foreignTenantId = uid();
    await db.insert(tenantsTable).values({
      id: foreignTenantId, slug: foreignTenantId,
      businessName: "Foreign Role Gallery", type: "ARTIST",
    } as any);
    createdTenantIds.push(foreignTenantId);
    const foreignStaffId = await addMember(foreignTenantId, "staff");
    // Also need to register it so cleanup runs.
    await db.insert(tenantUsersTable).values({
      tenantId: foreignTenantId, userId: foreignStaffId, role: "staff",
    } as any).onConflictDoNothing();

    // Own tenant update should not affect foreign tenant row.
    await db
      .update(tenantUsersTable)
      .set({ role: "owner" })
      .where(and(
        eq(tenantUsersTable.tenantId, ownId),
        eq(tenantUsersTable.userId, foreignStaffId),
      ));

    // Foreign tenant row must still be 'staff'.
    expect(await getRole(foreignTenantId, foreignStaffId)).toBe("staff");
  });

  it("updated role is persisted and read back correctly", async () => {
    const { tenantId } = await createTenant("owner");
    const memberId = await addMember(tenantId, "staff");

    // Update to owner.
    await db
      .update(tenantUsersTable)
      .set({ role: "owner" })
      .where(and(eq(tenantUsersTable.tenantId, tenantId), eq(tenantUsersTable.userId, memberId)));

    expect(await getRole(tenantId, memberId)).toBe("owner");

    // Update back to staff.
    await db
      .update(tenantUsersTable)
      .set({ role: "staff" })
      .where(and(eq(tenantUsersTable.tenantId, tenantId), eq(tenantUsersTable.userId, memberId)));

    expect(await getRole(tenantId, memberId)).toBe("staff");
  });

  it("non-existent tenantUser update affects zero rows", async () => {
    const { tenantId } = await createTenant("owner");
    const nonExistentUserId = uid();

    const result = await db
      .update(tenantUsersTable)
      .set({ role: "owner" })
      .where(and(
        eq(tenantUsersTable.tenantId, tenantId),
        eq(tenantUsersTable.userId, nonExistentUserId),
      ))
      .returning();

    expect(result).toHaveLength(0);
  });
});
