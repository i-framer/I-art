/**
 * Invite token uniqueness — real-DB integration.
 *
 * createInvite action generates a URL-safe token per invite.
 * Tokens must be unique across invites — different invites must have
 * different tokens, and both rows must persist to the DB.
 *
 *  1. Two different invites produce distinct tokens.
 *  2. Both tokens are non-null and non-empty.
 *  3. Both invite rows are persisted to staffInvitesTable.
 *  4. Same email can be invited again — produces a new distinct token.
 *  5. Different roles produce distinct tokens.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  staffInvitesTable,
  usersTable,
  tenantUsersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];
const createdInviteTokens: string[] = [];

function uid() { return `${randomUUID()}-itui-${RUN}-${++seq}`; }

const mockSession = { value: { userId: "u-invite-tok", tenantId: "PLACEHOLDER", role: "owner" } };

vi.mock("@/lib/auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...original,
    getSession: vi.fn(async () => mockSession.value),
  };
});
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
  hasActiveAccess: () => true,
}));
vi.mock("@/lib/email", () => ({
  sendTeamInvite: vi.fn(async () => {}),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

import { createInvite } from "@/app/(admin)/settings/actions";

async function createTenant() {
  const id = uid();
  const userId = uid();
  await db.insert(usersTable).values({ id: userId, email: `u-${userId}@test.com`, passwordHash: "x" } as any);
  createdUserIds.push(userId);
  mockSession.value = { userId, tenantId: id, role: "owner" };
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Invite Token Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  await db.insert(tenantUsersTable).values({ tenantId: id, userId, role: "owner" } as any);
  return { tenantId: id };
}

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

async function cleanup() {
  for (const token of createdInviteTokens.splice(0)) {
    await db.delete(staffInvitesTable).where(eq(staffInvitesTable.token, token)).catch(() => {});
  }
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

describeIntegration("Invite token uniqueness — real-DB integration", () => {
  it("two different invites produce distinct tokens", async () => {
    await createTenant();

    const r1 = await createInvite(null as unknown as import("@/app/(admin)/settings/actions").InviteResultState, fd({ email: "alice@test.com", role: "staff" }));
    const r2 = await createInvite(null as unknown as import("@/app/(admin)/settings/actions").InviteResultState, fd({ email: "bob@test.com", role: "staff" }));

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);

    const tok1 = r1.inviteUrl?.replace("/invite/", "") ?? "";
    const tok2 = r2.inviteUrl?.replace("/invite/", "") ?? "";
    if (tok1) createdInviteTokens.push(tok1);
    if (tok2) createdInviteTokens.push(tok2);

    expect(tok1).not.toBe(tok2);
  });

  it("both tokens are non-null and non-empty", async () => {
    await createTenant();

    const r1 = await createInvite(null as unknown as import("@/app/(admin)/settings/actions").InviteResultState, fd({ email: "carol@test.com", role: "staff" }));
    const r2 = await createInvite(null as unknown as import("@/app/(admin)/settings/actions").InviteResultState, fd({ email: "dave@test.com", role: "owner" }));

    const tok1 = r1.inviteUrl?.replace("/invite/", "") ?? "";
    const tok2 = r2.inviteUrl?.replace("/invite/", "") ?? "";
    if (tok1) createdInviteTokens.push(tok1);
    if (tok2) createdInviteTokens.push(tok2);

    expect(tok1.length).toBeGreaterThan(0);
    expect(tok2.length).toBeGreaterThan(0);
  });

  it("both invite rows are persisted to staffInvitesTable", async () => {
    const { tenantId } = await createTenant();

    const r1 = await createInvite(null as unknown as import("@/app/(admin)/settings/actions").InviteResultState, fd({ email: "eve@test.com", role: "staff" }));
    const r2 = await createInvite(null as unknown as import("@/app/(admin)/settings/actions").InviteResultState, fd({ email: "frank@test.com", role: "staff" }));

    const tok1 = r1.inviteUrl?.replace("/invite/", "") ?? "";
    const tok2 = r2.inviteUrl?.replace("/invite/", "") ?? "";
    if (tok1) createdInviteTokens.push(tok1);
    if (tok2) createdInviteTokens.push(tok2);

    const row1 = await db.query.staffInvitesTable.findFirst({
      where: eq(staffInvitesTable.token, tok1),
    });
    const row2 = await db.query.staffInvitesTable.findFirst({
      where: eq(staffInvitesTable.token, tok2),
    });

    expect(row1?.tenantId).toBe(tenantId);
    expect(row2?.tenantId).toBe(tenantId);
    expect(row1?.email).toBe("eve@test.com");
    expect(row2?.email).toBe("frank@test.com");
  });

  it("same email invited again produces a new distinct token", async () => {
    await createTenant();

    const r1 = await createInvite(null as unknown as import("@/app/(admin)/settings/actions").InviteResultState, fd({ email: "grace@test.com", role: "staff" }));
    const r2 = await createInvite(null as unknown as import("@/app/(admin)/settings/actions").InviteResultState, fd({ email: "grace@test.com", role: "staff" }));

    const tok1 = r1.inviteUrl?.replace("/invite/", "") ?? "";
    const tok2 = r2.inviteUrl?.replace("/invite/", "") ?? "";
    if (tok1) createdInviteTokens.push(tok1);
    if (tok2) createdInviteTokens.push(tok2);

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(tok1).not.toBe(tok2);
  });

  it("different roles produce distinct tokens", async () => {
    await createTenant();

    const r1 = await createInvite(null as unknown as import("@/app/(admin)/settings/actions").InviteResultState, fd({ email: "henry@test.com", role: "staff" }));
    const r2 = await createInvite(null as unknown as import("@/app/(admin)/settings/actions").InviteResultState, fd({ email: "iris@test.com", role: "owner" }));

    const tok1 = r1.inviteUrl?.replace("/invite/", "") ?? "";
    const tok2 = r2.inviteUrl?.replace("/invite/", "") ?? "";
    if (tok1) createdInviteTokens.push(tok1);
    if (tok2) createdInviteTokens.push(tok2);

    expect(tok1).not.toBe(tok2);
    const row1 = await db.query.staffInvitesTable.findFirst({
      where: eq(staffInvitesTable.token, tok1),
    });
    const row2 = await db.query.staffInvitesTable.findFirst({
      where: eq(staffInvitesTable.token, tok2),
    });
    expect(row1?.role).toBe("staff");
    expect(row2?.role).toBe("owner");
  });
});
