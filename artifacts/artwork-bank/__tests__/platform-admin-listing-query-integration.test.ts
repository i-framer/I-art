/**
 * Platform admin listing query — real-DB integration.
 *
 * app/platform/page.tsx queries:
 *   1. stripeAlertsTable (unresolved, newest-first)
 *   2. tenantsTable (all tenants, businessName ASC, specific columns)
 *   3. tenantsTable (iframer Slack failures, businessName ASC)
 *
 * This suite verifies those query contracts at the DB layer:
 *
 *  1. All tenants appear in businessName ASC order.
 *  2. Expected columns are present (id, businessName, slug, type, etc.).
 *  3. Unresolved stripe alerts appear; dismissed alerts are excluded.
 *  4. iframer Slack failure tenants are returned; non-failing excluded.
 *  5. Tenants are returned regardless of subscription status/type.
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, stripeAlertsTable } from "@workspace/db";
import { asc, desc, isNull, isNotNull } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdAlertIds: string[] = [];

function uid() { return `${randomUUID()}-palq-${RUN}-${++seq}`; }

async function createTenant(opts: {
  businessName?: string;
  type?: "ARTIST" | "FRAMER";
  subscriptionStatus?: string | null;
  iframerSlackPostFailed?: boolean | null;
} = {}) {
  const id = uid();
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: opts.businessName ?? `Platform Test Gallery ${id}`,
    type: opts.type ?? "ARTIST",
    subscriptionStatus: opts.subscriptionStatus ?? null,
    iframerSlackPostFailed: opts.iframerSlackPostFailed ? new Date() : null,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createAlert(tenantId: string, dismissedAt: Date | null = null) {
  const id = uid();
  await db.insert(stripeAlertsTable).values({
    id,
    stripeEventId: uid(),
    eventType: "account.updated",
    reason: "Test alert",
    dismissedAt,
  } as any);
  createdAlertIds.push(id);
  return id;
}

/** Mirror the platform page listing query. */
async function platformListingQuery() {
  const [unresolvedAlerts, tenants, iframerSlackFailures] = await Promise.all([
    db
      .select()
      .from(stripeAlertsTable)
      .where(isNull(stripeAlertsTable.dismissedAt))
      .orderBy(desc(stripeAlertsTable.createdAt)),
    db.query.tenantsTable.findMany({
      orderBy: [asc(tenantsTable.businessName)],
      columns: {
        id: true, businessName: true, slug: true, type: true,
        contactEmail: true, subscriptionStatus: true, billingExempt: true,
        trialEnd: true, createdAt: true,
        iframerAccountId: true, iframerAccountLinkedBy: true, iframerAccountLinkedAt: true,
      },
    }),
    db.query.tenantsTable.findMany({
      where: isNotNull(tenantsTable.iframerSlackPostFailed),
      orderBy: [asc(tenantsTable.businessName)],
      columns: { id: true, businessName: true, slug: true, iframerSlackPostFailed: true },
    }),
  ]);
  return { unresolvedAlerts, tenants, iframerSlackFailures };
}

async function cleanup() {
  for (const id of createdAlertIds.splice(0)) {
    await db.delete(stripeAlertsTable).where(eq(stripeAlertsTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Platform admin listing query — real-DB integration", () => {
  it("all tenants appear in businessName ASC order", async () => {
    const charlieId = await createTenant({ businessName: "Charlie Gallery" });
    const aliceId   = await createTenant({ businessName: "Alice Gallery" });
    const bobId     = await createTenant({ businessName: "Bob Gallery" });

    const { tenants } = await platformListingQuery();
    const ids = tenants.map(t => t.id);
    const aliceIdx   = ids.indexOf(aliceId);
    const bobIdx     = ids.indexOf(bobId);
    const charlieIdx = ids.indexOf(charlieId);

    // Must be in alphabetical order.
    expect(aliceIdx).toBeLessThan(bobIdx);
    expect(bobIdx).toBeLessThan(charlieIdx);
  });

  it("tenant record includes all expected platform-admin columns", async () => {
    const tenantId = await createTenant({ subscriptionStatus: "active" });

    const { tenants } = await platformListingQuery();
    const tenant = tenants.find(t => t.id === tenantId);

    expect(tenant).toBeDefined();
    expect(tenant).toHaveProperty("id");
    expect(tenant).toHaveProperty("businessName");
    expect(tenant).toHaveProperty("slug");
    expect(tenant).toHaveProperty("type");
    expect(tenant).toHaveProperty("subscriptionStatus");
    expect(tenant).toHaveProperty("billingExempt");
  });

  it("unresolved stripe alerts appear; dismissed alerts are excluded", async () => {
    const tenantId = await createTenant();
    const resolvedId   = await createAlert(tenantId, new Date("2024-01-01"));
    const unresolvedId = await createAlert(tenantId, null);

    const { unresolvedAlerts } = await platformListingQuery();
    const alertIds = unresolvedAlerts.map(a => a.id);

    expect(alertIds).toContain(unresolvedId);
    expect(alertIds).not.toContain(resolvedId);
  });

  it("iframer Slack failure tenants are returned; non-failing tenants excluded", async () => {
    const failId = await createTenant({ iframerSlackPostFailed: true });
    const okId   = await createTenant({ iframerSlackPostFailed: false });

    const { iframerSlackFailures } = await platformListingQuery();
    const failIds = iframerSlackFailures.map(t => t.id);

    expect(failIds).toContain(failId);
    expect(failIds).not.toContain(okId);
  });

  it("tenants are returned regardless of subscription status or type", async () => {
    const artistId = await createTenant({ type: "ARTIST", subscriptionStatus: "active" });
    const framerId = await createTenant({ type: "FRAMER", subscriptionStatus: "canceled" });
    const nullId   = await createTenant({ type: "ARTIST", subscriptionStatus: null });

    const { tenants } = await platformListingQuery();
    const ids = tenants.map(t => t.id);

    expect(ids).toContain(artistId);
    expect(ids).toContain(framerId);
    expect(ids).toContain(nullId);
  });
});
