/**
 * Platform admin billing actions — real-DB integration.
 *
 * setBillingExempt / setIframerAccount / dismissBillingAlert.
 *
 * All require `requirePlatformAdmin()` (email in PLATFORM_ADMIN_EMAILS env var).
 * The guard is mocked so the DB operations can be tested in isolation.
 *
 *  setBillingExempt:
 *   1. Sets billingExempt=true for a tenant.
 *   2. Sets billingExempt=false for a tenant.
 *   3. Returns "Tenant not found" for an unknown tenantId.
 *
 *  setIframerAccount:
 *   4. Links an iFramer account (sets iframerAccountId + billingExempt=true).
 *   5. Unlinks (nulls iframerAccountId; billingExempt unchanged).
 *   6. Returns "Tenant not found" for an unknown tenantId.
 *
 *  dismissBillingAlert:
 *   7. Sets dismissedAt on the alert row.
 *   8. Unknown alertId is a silent no-op (no error thrown).
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  stripeAlertsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Platform admin guard — bypass for testing ─────────────────────────────────
vi.mock("@/lib/platform-admin", () => ({
  requirePlatformAdmin: vi.fn(async () => {}),
}));

// ── Auth — returns a platform admin session ───────────────────────────────────
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({
    userId: "platform-admin-user",
    email: "admin@platform.test",
    tenantId: "n/a",
  })),
}));

// ── Slack — no-op so link/unlink events don't reach the wire ─────────────────
vi.mock("@/lib/slack", () => ({
  sendIframerSlackNotification: vi.fn(async () => {}),
  sendRefundDbFailureSlackNotification: vi.fn(async () => {}),
  sendBillingLossAlert: vi.fn(async () => {}),
  sendBillingAlertSlack: vi.fn(async () => {}),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

import {
  setBillingExempt,
  setIframerAccount,
  dismissBillingAlert,
} from "@/app/platform/actions";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdAlertIds: string[] = [];

function uid() { return `${randomUUID()}-plat-${RUN}-${++seq}`; }

async function createTenant(opts: { billingExempt?: boolean; iframerAccountId?: string | null } = {}) {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id,
    businessName: "Platform Admin Test Gallery",
    type: "ARTIST",
    billingExempt: opts.billingExempt ?? false,
    iframerAccountId: opts.iframerAccountId ?? null,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createAlert(tenantId: string) {
  const id = uid();
  await db.insert(stripeAlertsTable).values({
    id,
    stripeEventId: `evt-${id}`,
    eventType: "customer.subscription.deleted",
    customerId: `cus-${id}`,
    reason: "Unmatched tenant for test",
    dismissedAt: null,
  } as any);
  createdAlertIds.push(id);
  return id;
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

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Platform billing admin actions — real-DB integration", () => {
  // ── setBillingExempt ───────────────────────────────────────────────────────

  it("setBillingExempt: sets billingExempt=true for a tenant", async () => {
    const tenantId = await createTenant({ billingExempt: false });

    await setBillingExempt(fd({ tenantId, exempt: "true" }));

    const row = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, tenantId),
    });
    expect(row?.billingExempt).toBe(true);
  });

  it("setBillingExempt: sets billingExempt=false for a tenant", async () => {
    const tenantId = await createTenant({ billingExempt: true });

    await setBillingExempt(fd({ tenantId, exempt: "false" }));

    const row = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, tenantId),
    });
    expect(row?.billingExempt).toBe(false);
  });

  it("setBillingExempt: throws 'Tenant not found' for an unknown tenantId", async () => {
    await expect(
      setBillingExempt(fd({ tenantId: randomUUID(), exempt: "true" })),
    ).rejects.toThrow("Tenant not found");
  });

  // ── setIframerAccount ──────────────────────────────────────────────────────

  it("setIframerAccount: links an account — sets iframerAccountId and billingExempt=true", async () => {
    const tenantId = await createTenant({ billingExempt: false });

    await setIframerAccount(fd({ tenantId, accountId: "ifrm-acct-123" }));

    const row = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, tenantId),
    });
    expect(row?.iframerAccountId).toBe("ifrm-acct-123");
    expect(row?.billingExempt).toBe(true);
  });

  it("setIframerAccount: unlinks an account — sets iframerAccountId=null; billingExempt unchanged", async () => {
    const tenantId = await createTenant({ billingExempt: true, iframerAccountId: "ifrm-acct-456" });

    // Empty accountId = unlink.
    await setIframerAccount(fd({ tenantId, accountId: "" }));

    const row = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, tenantId),
    });
    expect(row?.iframerAccountId).toBeNull();
    // billingExempt is left unchanged on unlink.
    expect(row?.billingExempt).toBe(true);
  });

  it("setIframerAccount: throws 'Tenant not found' for an unknown tenantId", async () => {
    await expect(
      setIframerAccount(fd({ tenantId: randomUUID(), accountId: "ifrm-xyz" })),
    ).rejects.toThrow("Tenant not found");
  });

  // ── dismissBillingAlert ────────────────────────────────────────────────────

  it("dismissBillingAlert: sets dismissedAt on the alert row", async () => {
    const tenantId = await createTenant();
    const alertId = await createAlert(tenantId);

    const before = new Date();
    await dismissBillingAlert(alertId);

    const row = await db.query.stripeAlertsTable.findFirst({
      where: eq(stripeAlertsTable.id, alertId),
    });
    expect(row?.dismissedAt).not.toBeNull();
    expect(new Date(row!.dismissedAt!).getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it("dismissBillingAlert: unknown alertId is a silent no-op (no error)", async () => {
    await expect(dismissBillingAlert(randomUUID())).resolves.toBeUndefined();
  });
});
