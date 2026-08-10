/**
 * dismissBillingAlert — timestamp and target-row semantics — real-DB integration.
 *
 * app/platform/actions.ts:297-315:
 *   Sets stripeAlertsTable.dismissedAt = new Date() WHERE id = alertId.
 *   No-op if alert doesn't exist or already dismissed.
 *
 *  1. Dismissing an alert sets dismissedAt to a non-null recent timestamp.
 *  2. Only the target alert row's dismissedAt is updated (other rows untouched).
 *  3. Repeated dismissal is idempotent (no error; dismissedAt stays non-null).
 *  4. Non-existent alertId → no error, no rows affected.
 *  5. dismissedAt timestamp is within a few seconds of the current time.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, stripeAlertsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdAlertIds: string[] = [];

function uid() { return `${randomUUID()}-dbati-${RUN}-${++seq}`; }

vi.mock("@/lib/platform-admin", () => ({
  requirePlatformAdmin: vi.fn(async () => {}),
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { dismissBillingAlert } from "@/app/platform/actions";

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Dismiss Test", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createAlert(tenantId: string) {
  const id = uid();
  await db.insert(stripeAlertsTable).values({
    id, tenantId,
    reason: "Test billing alert",
    eventType: "invoice.payment_failed",
    stripeEventId: `evt_${uid()}`,
  } as any);
  createdAlertIds.push(id);
  return id;
}

async function getAlert(id: string) {
  return db.query.stripeAlertsTable.findFirst({ where: eq(stripeAlertsTable.id, id) });
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

describeIntegration("dismissBillingAlert timestamp and target-row semantics — real-DB integration", () => {
  it("dismissing an alert sets dismissedAt to a non-null recent timestamp", async () => {
    const tenantId = await createTenant();
    const alertId  = await createAlert(tenantId);
    const before   = new Date();

    await dismissBillingAlert(alertId);

    const row = await getAlert(alertId);
    expect(row?.dismissedAt).not.toBeNull();
    expect(row?.dismissedAt).toBeInstanceOf(Date);

    const after = new Date();
    // dismissedAt should be between before and after (within a few seconds).
    expect(row!.dismissedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(row!.dismissedAt!.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
  });

  it("only the target alert's dismissedAt is updated (sibling row untouched)", async () => {
    const tenantId = await createTenant();
    const alertA   = await createAlert(tenantId);
    const alertB   = await createAlert(tenantId);

    await dismissBillingAlert(alertA);

    const rowA = await getAlert(alertA);
    const rowB = await getAlert(alertB);

    expect(rowA?.dismissedAt).not.toBeNull();
    expect(rowB?.dismissedAt).toBeNull(); // untouched
  });

  it("repeated dismissal is idempotent — no error and dismissedAt stays non-null", async () => {
    const tenantId = await createTenant();
    const alertId  = await createAlert(tenantId);

    await dismissBillingAlert(alertId);
    const _firstDismissedAt = (await getAlert(alertId))?.dismissedAt;

    await expect(dismissBillingAlert(alertId)).resolves.not.toThrow();
    const row = await getAlert(alertId);
    expect(row?.dismissedAt).not.toBeNull();
    // dismissedAt may be updated or preserved — either is acceptable.
  });

  it("non-existent alertId → no error thrown", async () => {
    await expect(dismissBillingAlert(`nonexistent-${uid()}`)).resolves.not.toThrow();
  });

  it("dismissedAt timestamp is within a few seconds of current time", async () => {
    const tenantId = await createTenant();
    const alertId  = await createAlert(tenantId);
    const now      = Date.now();

    await dismissBillingAlert(alertId);

    const row = await getAlert(alertId);
    const ts  = row?.dismissedAt?.getTime() ?? 0;
    expect(Math.abs(ts - now)).toBeLessThan(5000); // within 5 seconds
  });
});
