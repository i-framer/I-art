/**
 * Platform admin tenant listing — real-DB integration.
 *
 * The platform admin page lists all tenants ordered by businessName ASC with
 * no filtering.  This suite verifies the listing query against real PostgreSQL:
 *
 *  1. All inserted tenants appear exactly once, ordered by businessName ASC.
 *  2. All selected columns (billingExempt, subscriptionStatus, type, etc.) are correct.
 *  3. Tenants with different types/statuses all appear (no implicit filtering).
 *  4. The iFramer alert panel query only includes tenants with non-null
 *     iframerSlackPostFailed.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
} from "@workspace/db";
import { asc, eq, isNotNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Auth — platform admin ─────────────────────────────────────────────────────
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({
    userId: "u-platform-admin",
    email: "admin@platform.test",
    tenantId: "platform",
  })),
}));
vi.mock("@/lib/platform-admin", () => ({
  isPlatformAdmin: vi.fn(() => true),
  requirePlatformAdmin: vi.fn(async () => {}),
}));

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];

function uid() { return `${randomUUID()}-platlist-${RUN}-${++seq}`; }

async function createTenant(opts: {
  businessName: string;
  type?: string;
  billingExempt?: boolean;
  subscriptionStatus?: string | null;
  iframerSlackPostFailed?: Date | null;
  iframerAccountId?: string | null;
}) {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id,
    businessName: opts.businessName,
    type: opts.type ?? "ARTIST",
    billingExempt: opts.billingExempt ?? false,
    subscriptionStatus: opts.subscriptionStatus ?? null,
    iframerSlackPostFailed: opts.iframerSlackPostFailed ?? null,
    iframerAccountId: opts.iframerAccountId ?? null,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function cleanup() {
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ── Inline query (mirrors platform/page.tsx) ──────────────────────────────────

async function listTenantsForPlatformAdmin(idsToInclude: string[]) {
  const rows = await db.query.tenantsTable.findMany({
    orderBy: [asc(tenantsTable.businessName)],
    columns: {
      id: true, businessName: true, slug: true,
      type: true, contactEmail: true, subscriptionStatus: true,
      billingExempt: true, createdAt: true,
      iframerAccountId: true, iframerSlackPostFailed: true,
    },
  });
  // Filter to just our test tenants so other data doesn't pollute assertions.
  return rows.filter(r => idsToInclude.includes(r.id));
}

async function listIframerAlerts(idsToInclude: string[]) {
  const rows = await db.query.tenantsTable.findMany({
    where: isNotNull(tenantsTable.iframerSlackPostFailed),
    orderBy: [asc(tenantsTable.businessName)],
    columns: { id: true, businessName: true, iframerSlackPostFailed: true },
  });
  return rows.filter(r => idsToInclude.includes(r.id));
}

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Platform admin tenant listing — real-DB integration", () => {
  it("all tenants appear exactly once, ordered by businessName ASC", async () => {
    const t1 = await createTenant({ businessName: "Zebra Gallery" });
    const t2 = await createTenant({ businessName: "Alpha Gallery" });
    const t3 = await createTenant({ businessName: "Museum Type", type: "FRAMER" });

    const rows = await listTenantsForPlatformAdmin([t1, t2, t3]);

    expect(rows).toHaveLength(3);
    // Alphabetically: Alpha, Museum, Zebra.
    expect(rows[0].businessName).toBe("Alpha Gallery");
    expect(rows[1].businessName).toBe("Museum Type");
    expect(rows[2].businessName).toBe("Zebra Gallery");
  });

  it("all billing/subscription states appear (no implicit filtering)", async () => {
    const exempt = await createTenant({
      businessName: "Comped Gallery", billingExempt: true, subscriptionStatus: null,
    });
    const active = await createTenant({
      businessName: "Paying Gallery", billingExempt: false, subscriptionStatus: "active",
    });
    const cancelled = await createTenant({
      businessName: "Lapsed Gallery", billingExempt: false, subscriptionStatus: "canceled",
    });

    const rows = await listTenantsForPlatformAdmin([exempt, active, cancelled]);

    expect(rows).toHaveLength(3);
    const byName = Object.fromEntries(rows.map(r => [r.businessName, r]));
    expect(byName["Comped Gallery"].billingExempt).toBe(true);
    expect(byName["Paying Gallery"].subscriptionStatus).toBe("active");
    expect(byName["Lapsed Gallery"].subscriptionStatus).toBe("canceled");
  });

  it("iFramer alert panel only includes tenants with non-null iframerSlackPostFailed", async () => {
    const alertTenant = await createTenant({
      businessName: "Alert Gallery",
      iframerSlackPostFailed: new Date(Date.now() - 60000),
    });
    const normalTenant = await createTenant({
      businessName: "Normal Gallery",
      iframerSlackPostFailed: null,
    });

    const alerts = await listIframerAlerts([alertTenant, normalTenant]);

    expect(alerts).toHaveLength(1);
    expect(alerts[0].id).toBe(alertTenant);
    expect(alerts[0].iframerSlackPostFailed).not.toBeNull();
  });

  it("iFramer linked account is reflected in the listing", async () => {
    const tenantId = await createTenant({
      businessName: "iFramer Linked",
      iframerAccountId: "acct_iframer_xyz",
      billingExempt: true,
    });

    const rows = await listTenantsForPlatformAdmin([tenantId]);

    expect(rows[0].iframerAccountId).toBe("acct_iframer_xyz");
    expect(rows[0].billingExempt).toBe(true);
  });
});
