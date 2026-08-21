/**
 * Platform admin listing — billing-state filter — real-DB integration.
 *
 * The platform admin tenant list is used to monitor and triage galleries.
 * This tests filtering by subscription status directly against real DB rows.
 * (Note: if the UI query doesn't support WHERE filters, these tests verify
 * direct DB queries that the admin list builds upon.)
 *
 *  1. Tenant with subscriptionStatus=active is returned in a query for active tenants.
 *  2. Tenant with subscriptionStatus=past_due is returned in past_due query.
 *  3. Tenant with subscriptionStatus=canceled is returned in canceled query.
 *  4. Tenant with subscriptionStatus=null is not missed (un-billed tenants).
 *  5. Active tenant is excluded from past_due filter.
 *  6. Count of tenants per billing state is correct when multiple tenants exist.
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable } from "@workspace/db";
import { eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];

function uid() { return `${randomUUID()}-pabsf-${RUN}-${++seq}`; }

async function createTenant(subscriptionStatus: string | null) {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Billing State Filter Test", type: "ARTIST",
    subscriptionStatus: subscriptionStatus ?? null,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function tenantsByStatus(status: string | null) {
  if (status === null) {
    return db.query.tenantsTable.findMany({ where: isNull(tenantsTable.subscriptionStatus) });
  }
  return db.query.tenantsTable.findMany({ where: eq(tenantsTable.subscriptionStatus, status) });
}

async function cleanup() {
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Platform admin billing state filter — real-DB integration", () => {
  it("tenant with subscriptionStatus=active is returned in active filter", async () => {
    const tenantId = await createTenant("active");

    const rows = await tenantsByStatus("active");
    expect(rows.map(r => r.id)).toContain(tenantId);
  });

  it("tenant with subscriptionStatus=past_due is returned in past_due filter", async () => {
    const tenantId = await createTenant("past_due");

    const rows = await tenantsByStatus("past_due");
    expect(rows.map(r => r.id)).toContain(tenantId);
  });

  it("tenant with subscriptionStatus=canceled is returned in canceled filter", async () => {
    const tenantId = await createTenant("canceled");

    const rows = await tenantsByStatus("canceled");
    expect(rows.map(r => r.id)).toContain(tenantId);
  });

  it("tenant with subscriptionStatus=null is included in null filter", async () => {
    const tenantId = await createTenant(null);

    const rows = await tenantsByStatus(null);
    expect(rows.map(r => r.id)).toContain(tenantId);
  });

  it("active tenant is excluded from past_due filter", async () => {
    const activeTenantId  = await createTenant("active");
    const pastDueTenantId = await createTenant("past_due");

    const rows = await tenantsByStatus("past_due");
    const ids = rows.map(r => r.id);

    expect(ids).toContain(pastDueTenantId);
    expect(ids).not.toContain(activeTenantId);
  });

  it("count of tenants per billing state is correct", async () => {
    const activeTenantIds = [
      await createTenant("active"),
      await createTenant("active"),
    ];
    const canceledTenantId = await createTenant("canceled");

    // Other integration files can create their own tenants concurrently. Count
    // only this test's uniquely seeded fixtures so the assertion remains about
    // the billing-state filter rather than unrelated database activity.
    const activeRows = await tenantsByStatus("active");
    const canceledRows = await tenantsByStatus("canceled");

    expect(
      activeRows.filter((row) => activeTenantIds.includes(row.id)),
    ).toHaveLength(2);
    expect(
      canceledRows.filter((row) => row.id === canceledTenantId),
    ).toHaveLength(1);
  });
});
