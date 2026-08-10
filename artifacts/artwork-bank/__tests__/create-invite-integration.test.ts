/**
 * createInvite — real-DB integration.
 *
 * Existing coverage (invite-accept-full-integration.test.ts,
 * invite-double-accept-integration.test.ts) tests invitation acceptance.
 * This suite verifies invite creation persistence against real PostgreSQL:
 *
 *  1. Owner creates an invite → row persisted with correct fields, URL returned.
 *  2. Email is stored lowercased.
 *  3. expiresAt is approximately 7 days in the future.
 *  4. Non-owner (STAFF role) cannot create an invite.
 *  5. Invalid email returns error — no row inserted.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  usersTable,
  tenantUsersTable,
  staffInvitesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Auth ──────────────────────────────────────────────────────────────────────
const mockSession = {
  userId: "u-invite-owner",
  tenantId: "PLACEHOLDER",
  role: "owner",
  email: "owner@invite.test",
};
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    getSession: vi.fn(async () => ({ ...mockSession })),
  };
});
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
  hasActiveAccess: () => true,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));
vi.mock("@/lib/email", () => ({
  sendStaffInviteEmail: vi.fn(async () => {}),
}));

import { createInvite } from "@/app/(admin)/settings/actions";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];
const createdInviteTokens: string[] = [];

function uid() { return `${randomUUID()}-cinv-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Create Invite Test Gallery", type: "ARTIST",
    billingExempt: true, subscriptionStatus: "active",
  } as any);
  createdTenantIds.push(id);
  mockSession.tenantId = id;
  return id;
}

async function cleanup() {
  // Clean up invite tokens created by the action.
  for (const token of createdInviteTokens.splice(0)) {
    await db.delete(staffInvitesTable).where(eq(staffInvitesTable.token, token)).catch(() => {});
  }
  // Clean up any invites inserted for the test tenants.
  for (const id of createdTenantIds.slice()) {
    await db.delete(staffInvitesTable).where(eq(staffInvitesTable.tenantId, id)).catch(() => {});
  }
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

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("createInvite — real-DB integration", () => {
  it("owner creates a STAFF invite → row persisted with correct fields, URL returned", async () => {
    const tenantId = await createTenant();
    mockSession.role = "owner";

    const email = `invitee-${uid()}@example.com`;
    const result = await createInvite(null as unknown as import("@/app/(admin)/settings/actions").InviteResultState, fd({ email, role: "staff" }));

    expect(result.success).toBe(true);
    expect(result.error).toBe("");
    expect(result.inviteUrl).toMatch(/^\/invite\//);

    const token = result.inviteUrl?.replace("/invite/", "");
    const row = await db.query.staffInvitesTable.findFirst({
      where: eq(staffInvitesTable.token, token!),
    });

    expect(row).toBeDefined();
    expect(row?.tenantId).toBe(tenantId);
    expect(row?.email).toBe(email);
    expect(row?.role).toBe("staff");
    expect(row?.acceptedAt).toBeNull();
    if (token) createdInviteTokens.push(token);
  });

  it("email is stored lowercased", async () => {
    await createTenant();
    mockSession.role = "owner";

    const result = await createInvite(null as unknown as import("@/app/(admin)/settings/actions").InviteResultState, fd({ email: "UPPER@EXAMPLE.COM", role: "staff" }));
    expect(result.success).toBe(true);

    const token = result.inviteUrl?.replace("/invite/", "");
    const row = await db.query.staffInvitesTable.findFirst({
      where: eq(staffInvitesTable.token, token!),
    });
    expect(row?.email).toBe("upper@example.com");
    if (token) createdInviteTokens.push(token);
  });

  it("expiresAt is approximately 7 days in the future", async () => {
    await createTenant();
    mockSession.role = "owner";

    const before = Date.now();
    const result = await createInvite(null as unknown as import("@/app/(admin)/settings/actions").InviteResultState, fd({ email: `exp-${uid()}@example.com`, role: "staff" }));
    const after = Date.now();

    const token = result.inviteUrl?.replace("/invite/", "");
    const row = await db.query.staffInvitesTable.findFirst({
      where: eq(staffInvitesTable.token, token!),
    });

    const expiresMs = new Date(row!.expiresAt).getTime();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(expiresMs).toBeGreaterThanOrEqual(before + sevenDaysMs - 5000);
    expect(expiresMs).toBeLessThanOrEqual(after + sevenDaysMs + 5000);
    if (token) createdInviteTokens.push(token);
  });

  it("STAFF role cannot create an invite — no row inserted", async () => {
    const tenantId = await createTenant();
    mockSession.role = "staff";

    const email = `blocked-${uid()}@example.com`;
    const result = await createInvite(null as unknown as import("@/app/(admin)/settings/actions").InviteResultState, fd({ email, role: "staff" }));

    expect(result.error).toBeTruthy();
    expect(result.success).toBeFalsy();

    const rows = await db
      .select({ token: staffInvitesTable.token })
      .from(staffInvitesTable)
      .where(eq(staffInvitesTable.tenantId, tenantId));
    expect(rows).toHaveLength(0);
  });

  it("invalid email returns error — no row inserted", async () => {
    const tenantId = await createTenant();
    mockSession.role = "owner";

    const result = await createInvite(null as unknown as import("@/app/(admin)/settings/actions").InviteResultState, fd({ email: "not-an-email", role: "staff" }));

    expect(result.error).toBeTruthy();

    const rows = await db
      .select({ token: staffInvitesTable.token })
      .from(staffInvitesTable)
      .where(eq(staffInvitesTable.tenantId, tenantId));
    expect(rows).toHaveLength(0);
  });
});
