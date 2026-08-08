/**
 * createInvite / removeTeamMember — real-DB integration.
 *
 * Covers the DB-side behaviour of both settings team actions:
 *
 * createInvite:
 *  1. Owner can create an invite — row persisted with correct tenant/email/role/token.
 *  2. Non-owner (staff) is rejected with an error message.
 *  3. Blank / invalid email returns a validation error; no row written.
 *  4. Email is stored lowercased.
 *  5. Invite expires 7 days from creation.
 *
 * removeTeamMember:
 *  6. Owner can remove a different team member — membership row deleted.
 *  7. Non-owner cannot remove anyone (silently no-ops).
 *  8. Owner cannot remove themselves.
 *  9. Owner cannot remove a member from a foreign tenant.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  tenantUsersTable,
  usersTable,
  staffInvitesTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Auth mock ─────────────────────────────────────────────────────────────────

const mockSession = {
  userId: "PLACEHOLDER_USER",
  tenantId: "PLACEHOLDER_TENANT",
  role: "owner",
};

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    getSession: vi.fn(async () => ({ ...mockSession })),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));
vi.mock("@/lib/tenant-cache", () => ({
  getCnameTarget: vi.fn(() => "i-art.com.au"),
  getTenantByCustomDomain: vi.fn(async () => null),
  getTenantBySlug: vi.fn(async () => null),
  formatPrice: vi.fn(() => "$0.00"),
  getPlatformBaseUrl: vi.fn(() => "https://i-art.com.au"),
}));
vi.mock("@/lib/vercel-domains", () => ({
  provisionVercelDomain: vi.fn(async () => {}),
}));

import {
  createInvite,
  removeTeamMember,
} from "@/app/(admin)/settings/actions";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];
const createdInviteTokens: string[] = [];

function uid() { return `${randomUUID()}-tm-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Team Mgmt Test Gallery",
    type: "ARTIST", billingExempt: true,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createUser(email: string) {
  const id = uid();
  await db.insert(usersTable).values({ id, email, passwordHash: "hashed" } as any);
  createdUserIds.push(id);
  return id;
}

async function addMembership(tenantId: string, userId: string, role: string) {
  await db.insert(tenantUsersTable).values({ tenantId, userId, role } as any);
}

function inviteFormData(email: string, role = "staff") {
  const f = new FormData();
  f.set("email", email);
  f.set("role", role);
  return f;
}

async function cleanup() {
  for (const token of createdInviteTokens.splice(0)) {
    await db.delete(staffInvitesTable).where(eq(staffInvitesTable.token, token)).catch(() => {});
  }
  for (const id of createdUserIds.splice(0)) {
    await db.delete(tenantUsersTable).where(eq(tenantUsersTable.userId, id)).catch(() => {});
    await db.delete(usersTable).where(eq(usersTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(staffInvitesTable).where(eq(staffInvitesTable.tenantId, id)).catch(() => {});
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("createInvite — real-DB integration", () => {
  it("owner can create an invite — row persisted with correct fields", async () => {
    const tenantId = await createTenant();
    const ownerId = await createUser("owner@example.com");
    mockSession.userId = ownerId;
    mockSession.tenantId = tenantId;
    mockSession.role = "owner";

    const email = `invite-${uid().slice(0, 8)}@example.com`;
    const result = await createInvite(
      { success: false, error: "", inviteUrl: "", email: "" },
      inviteFormData(email),
    );

    expect(result.success).toBe(true);
    expect(result.email).toBe(email);
    expect(result.inviteUrl).toMatch(/^\/invite\//);

    // Verify DB row.
    const token = result.inviteUrl.replace("/invite/", "");
    createdInviteTokens.push(token);
    const row = await db.query.staffInvitesTable.findFirst({
      where: eq(staffInvitesTable.token, token),
    });
    expect(row).toBeDefined();
    expect(row?.tenantId).toBe(tenantId);
    expect(row?.email).toBe(email);
    expect(row?.role).toBe("staff");
    expect(row?.acceptedAt).toBeNull();
  });

  it("staff (non-owner) cannot create an invite", async () => {
    const tenantId = await createTenant();
    const staffId = await createUser("staff-inviter@example.com");
    mockSession.userId = staffId;
    mockSession.tenantId = tenantId;
    mockSession.role = "staff";

    const result = await createInvite(
      { success: false, error: "", inviteUrl: "", email: "" },
      inviteFormData("anyone@example.com"),
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/owner/i);

    // Confirm no invite row was written for this tenant.
    const rows = await db.query.staffInvitesTable.findMany({
      where: eq(staffInvitesTable.tenantId, tenantId),
    });
    expect(rows).toHaveLength(0);
  });

  it("blank email returns validation error; no row written", async () => {
    const tenantId = await createTenant();
    const ownerId = await createUser("owner2@example.com");
    mockSession.userId = ownerId;
    mockSession.tenantId = tenantId;
    mockSession.role = "owner";

    const result = await createInvite(
      { success: false, error: "", inviteUrl: "", email: "" },
      inviteFormData(""),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();

    const rows = await db.query.staffInvitesTable.findMany({
      where: eq(staffInvitesTable.tenantId, tenantId),
    });
    expect(rows).toHaveLength(0);
  });

  it("email is stored lowercased", async () => {
    const tenantId = await createTenant();
    const ownerId = await createUser("owner3@example.com");
    mockSession.userId = ownerId;
    mockSession.tenantId = tenantId;
    mockSession.role = "owner";

    const result = await createInvite(
      { success: false, error: "", inviteUrl: "", email: "" },
      inviteFormData("UPPER@EXAMPLE.COM"),
    );

    expect(result.success).toBe(true);
    const token = result.inviteUrl.replace("/invite/", "");
    createdInviteTokens.push(token);
    const row = await db.query.staffInvitesTable.findFirst({
      where: eq(staffInvitesTable.token, token),
    });
    expect(row?.email).toBe("upper@example.com");
  });

  it("invite expires approximately 7 days from now", async () => {
    const tenantId = await createTenant();
    const ownerId = await createUser("owner4@example.com");
    mockSession.userId = ownerId;
    mockSession.tenantId = tenantId;
    mockSession.role = "owner";

    const before = Date.now();
    const result = await createInvite(
      { success: false, error: "", inviteUrl: "", email: "" },
      inviteFormData("expiry@example.com"),
    );
    const after = Date.now();

    expect(result.success).toBe(true);
    const token = result.inviteUrl.replace("/invite/", "");
    createdInviteTokens.push(token);
    const row = await db.query.staffInvitesTable.findFirst({
      where: eq(staffInvitesTable.token, token),
    });

    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    const expiry = row?.expiresAt?.getTime() ?? 0;
    expect(expiry).toBeGreaterThanOrEqual(before + SEVEN_DAYS_MS - 1000);
    expect(expiry).toBeLessThanOrEqual(after + SEVEN_DAYS_MS + 1000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("removeTeamMember — real-DB integration", () => {
  it("owner can remove another team member", async () => {
    const tenantId = await createTenant();
    const ownerId = await createUser("owner-rm@example.com");
    const staffId = await createUser("staff-to-remove@example.com");
    await addMembership(tenantId, ownerId, "owner");
    await addMembership(tenantId, staffId, "staff");
    mockSession.userId = ownerId;
    mockSession.tenantId = tenantId;
    mockSession.role = "owner";

    await removeTeamMember(staffId);

    const row = await db.query.tenantUsersTable.findFirst({
      where: and(
        eq(tenantUsersTable.tenantId, tenantId),
        eq(tenantUsersTable.userId, staffId),
      ),
    });
    expect(row).toBeUndefined();
  });

  it("non-owner (staff) cannot remove anyone — silently no-ops", async () => {
    const tenantId = await createTenant();
    const staffCallerId = await createUser("staff-caller@example.com");
    const otherStaffId = await createUser("other-staff@example.com");
    await addMembership(tenantId, staffCallerId, "staff");
    await addMembership(tenantId, otherStaffId, "staff");
    mockSession.userId = staffCallerId;
    mockSession.tenantId = tenantId;
    mockSession.role = "staff";

    await removeTeamMember(otherStaffId);

    const row = await db.query.tenantUsersTable.findFirst({
      where: and(
        eq(tenantUsersTable.tenantId, tenantId),
        eq(tenantUsersTable.userId, otherStaffId),
      ),
    });
    expect(row).toBeDefined(); // still present
  });

  it("owner cannot remove themselves — silently no-ops", async () => {
    const tenantId = await createTenant();
    const ownerId = await createUser("self-rm@example.com");
    await addMembership(tenantId, ownerId, "owner");
    mockSession.userId = ownerId;
    mockSession.tenantId = tenantId;
    mockSession.role = "owner";

    await removeTeamMember(ownerId);

    const row = await db.query.tenantUsersTable.findFirst({
      where: and(
        eq(tenantUsersTable.tenantId, tenantId),
        eq(tenantUsersTable.userId, ownerId),
      ),
    });
    expect(row).toBeDefined(); // still present
  });

  it("owner cannot remove a member from a foreign tenant", async () => {
    const ownTenantId = await createTenant();
    const foreignTenantId = await createTenant();
    const ownerId = await createUser("owner-foreign@example.com");
    const foreignStaffId = await createUser("foreign-staff@example.com");
    await addMembership(ownTenantId, ownerId, "owner");
    await addMembership(foreignTenantId, foreignStaffId, "staff");
    mockSession.userId = ownerId;
    mockSession.tenantId = ownTenantId;
    mockSession.role = "owner";

    await removeTeamMember(foreignStaffId);

    // Foreign membership must remain intact.
    const row = await db.query.tenantUsersTable.findFirst({
      where: and(
        eq(tenantUsersTable.tenantId, foreignTenantId),
        eq(tenantUsersTable.userId, foreignStaffId),
      ),
    });
    expect(row).toBeDefined();
  });
});
