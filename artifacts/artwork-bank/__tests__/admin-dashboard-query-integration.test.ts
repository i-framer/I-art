/**
 * Admin dashboard page — DB query — real-DB integration.
 *
 * The dashboard page (app/(admin)/(gated)/dashboard/page.tsx) queries:
 *   1. tenantsTable.findFirst WHERE id = session.tenantId (settings + billing)
 *   2. tenantUsersTable.findMany WHERE tenantId = session.tenantId (team)
 *
 * This suite verifies those query contracts directly against real PostgreSQL:
 *
 *  1. Own tenant is returned with correct billing/subscription fields.
 *  2. Foreign tenant is not returned (query is tenant-scoped).
 *  3. Team members are returned for the correct tenant.
 *  4. Team members from a foreign tenant do not appear.
 *  5. Stripe-linked fields (stripeAccountId, stripeCustomerId) are readable.
 *  6. Billing exempt flag is readable.
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  tenantUsersTable,
  usersTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── DB helpers ────────────────────────────────────────────────────────────────
const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];
// tenantUsersTable has a composite PK (tenantId, userId) — no id column.
const createdTenantUserPairs: Array<{ tenantId: string; userId: string }> = [];

function uid() { return `${randomUUID()}-adq-${RUN}-${++seq}`; }

async function createTenant(opts: {
  billingExempt?: boolean;
  subscriptionStatus?: string | null;
  stripeAccountId?: string | null;
  stripeCustomerId?: string | null;
} = {}) {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: `Dashboard Test Gallery ${id}`,
    type: "ARTIST",
    billingExempt: opts.billingExempt ?? false,
    subscriptionStatus: opts.subscriptionStatus ?? null,
    stripeAccountId: opts.stripeAccountId ?? null,
    stripeCustomerId: opts.stripeCustomerId ?? null,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createUser(email: string) {
  const id = uid();
  await db.insert(usersTable).values({ id, email, passwordHash: "x" } as any);
  createdUserIds.push(id);
  return id;
}

async function addTeamMember(tenantId: string, userId: string) {
  await db.insert(tenantUsersTable).values({ tenantId, userId, role: "owner" } as any);
  createdTenantUserPairs.push({ tenantId, userId });
  return userId; // return userId so callers can identify the membership
}

async function cleanup() {
  for (const { tenantId, userId } of createdTenantUserPairs.splice(0)) {
    await db.delete(tenantUsersTable)
      .where(and(eq(tenantUsersTable.tenantId, tenantId), eq(tenantUsersTable.userId, userId)))
      .catch(() => {});
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

describeIntegration("Admin dashboard page — DB query — real-DB integration", () => {
  it("own tenant is returned with correct billing and subscription fields", async () => {
    const tenantId = await createTenant({
      subscriptionStatus: "active",
      stripeAccountId: "acct_test_123",
      stripeCustomerId: "cus_test_123",
    });

    const tenant = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, tenantId),
    });

    expect(tenant).toBeDefined();
    expect(tenant?.id).toBe(tenantId);
    expect(tenant?.subscriptionStatus).toBe("active");
    expect(tenant?.stripeAccountId).toBe("acct_test_123");
    expect(tenant?.stripeCustomerId).toBe("cus_test_123");
  });

  it("foreign tenant is not returned — query is strictly tenant-scoped", async () => {
    const ownTenantId = await createTenant();
    const foreignTenantId = await createTenant();

    const tenant = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, ownTenantId),
    });

    expect(tenant?.id).toBe(ownTenantId);
    expect(tenant?.id).not.toBe(foreignTenantId);
  });

  it("team members are returned for the correct tenant", async () => {
    const tenantId = await createTenant();
    const userId = await createUser(`member-${uid()}@example.com`);
    await addTeamMember(tenantId, userId);

    const members = await db.query.tenantUsersTable.findMany({
      where: eq(tenantUsersTable.tenantId, tenantId),
    });

    // tenantUsersTable has composite PK (tenantId, userId) — identify by userId.
    expect(members.map(m => m.userId)).toContain(userId);
  });

  it("team members from a foreign tenant do not appear in results", async () => {
    const ownTenantId = await createTenant();
    const foreignTenantId = await createTenant();
    const foreignUserId = await createUser(`foreign-${uid()}@example.com`);
    await addTeamMember(foreignTenantId, foreignUserId);

    const members = await db.query.tenantUsersTable.findMany({
      where: eq(tenantUsersTable.tenantId, ownTenantId),
    });

    expect(members.map(m => m.userId)).not.toContain(foreignUserId);
  });

  it("billingExempt flag is readable for comped-gallery detection", async () => {
    const exemptId = await createTenant({ billingExempt: true });
    const normalId = await createTenant({ billingExempt: false });

    const [exempt, normal] = await Promise.all([
      db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, exemptId) }),
      db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, normalId) }),
    ]);

    expect(exempt?.billingExempt).toBe(true);
    expect(normal?.billingExempt).toBe(false);
  });

  it("null Stripe fields are returned as null for onboarding detection", async () => {
    const tenantId = await createTenant({
      stripeAccountId: null,
      stripeCustomerId: null,
      subscriptionStatus: null,
    });

    const tenant = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, tenantId),
    });

    expect(tenant?.stripeAccountId).toBeNull();
    expect(tenant?.stripeCustomerId).toBeNull();
    expect(tenant?.subscriptionStatus).toBeNull();
  });
});
