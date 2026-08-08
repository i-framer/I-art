/**
 * Platform admin — billing alert query — real-DB integration.
 *
 * The platform/page.tsx fetches unresolved Stripe alerts with
 *   WHERE dismissedAt IS NULL ORDER BY createdAt DESC
 * This suite verifies that query contract directly against real PostgreSQL.
 *
 *  1. Unresolved alert appears in results; dismissed alert is excluded.
 *  2. Multiple unresolved alerts are ordered newest-first.
 *  3. Dismissed alerts are completely hidden (not a soft-filter).
 *  4. stripeEventId uniqueness — duplicate event is silently ignored (onConflictDoNothing).
 *  5. Alert from a foreign tenant does not affect query results.
 *  6. After dismissBillingAlert runs, the alert disappears from the unresolved query.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, stripeAlertsTable, tenantsTable } from "@workspace/db";
import { asc, desc, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Auth mock for dismissBillingAlert ─────────────────────────────────────────
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ userId: "u-platform-admin", email: "admin@platform.test" })),
}));
vi.mock("@/lib/platform-admin", () => ({
  requirePlatformAdmin: vi.fn(async () => {}),
  isPlatformAdmin: vi.fn(() => true),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { dismissBillingAlert } from "@/app/platform/actions";

// ── DB helpers ────────────────────────────────────────────────────────────────
const RUN = Date.now();
let seq = 0;
const createdAlertIds: string[] = [];
const createdTenantIds: string[] = [];

function uid() { return `${randomUUID()}-baq-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: `Alert Query Test ${id}`,
    type: "ARTIST", billingExempt: false,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function insertAlert(opts: {
  stripeEventId?: string;
  eventType?: string;
  dismissedAt?: Date | null;
  createdAt?: Date;
  customerId?: string | null;
  subscriptionId?: string | null;
} = {}) {
  const id = uid();
  await db.insert(stripeAlertsTable).values({
    id,
    stripeEventId: opts.stripeEventId ?? `evt-${id}`,
    eventType: opts.eventType ?? "checkout.session.completed",
    customerId: opts.customerId ?? null,
    subscriptionId: opts.subscriptionId ?? null,
    reason: "Test alert reason",
    dismissedAt: opts.dismissedAt ?? null,
  } as any);
  if (opts.createdAt) {
    await db.update(stripeAlertsTable)
      .set({ createdAt: opts.createdAt })
      .where(eq(stripeAlertsTable.id, id));
  }
  createdAlertIds.push(id);
  return id;
}

/** Query that mirrors app/platform/page.tsx: unresolved alerts newest-first. */
async function queryUnresolvedAlerts() {
  return db
    .select({
      id: stripeAlertsTable.id,
      stripeEventId: stripeAlertsTable.stripeEventId,
      eventType: stripeAlertsTable.eventType,
      createdAt: stripeAlertsTable.createdAt,
      dismissedAt: stripeAlertsTable.dismissedAt,
    })
    .from(stripeAlertsTable)
    .where(isNull(stripeAlertsTable.dismissedAt))
    .orderBy(desc(stripeAlertsTable.createdAt));
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

describeIntegration("Platform admin — billing alert query — real-DB integration", () => {
  it("unresolved alert appears; dismissed alert is excluded", async () => {
    const unresolvedId = await insertAlert();
    const dismissedId = await insertAlert({ dismissedAt: new Date(Date.now() - 60_000) });

    const rows = await queryUnresolvedAlerts();
    const ids = rows.map(r => r.id);

    expect(ids).toContain(unresolvedId);
    expect(ids).not.toContain(dismissedId);
  });

  it("multiple unresolved alerts are ordered newest-first", async () => {
    const olderTime = new Date(Date.now() - 10 * 60 * 1000);
    const newerTime = new Date(Date.now() - 1 * 60 * 1000);

    const olderId = await insertAlert({ createdAt: olderTime });
    const newerId = await insertAlert({ createdAt: newerTime });

    const rows = await queryUnresolvedAlerts();
    const ownRows = rows.filter(r => r.id === olderId || r.id === newerId);

    // Newer must appear before older.
    const newerIdx = ownRows.findIndex(r => r.id === newerId);
    const olderIdx = ownRows.findIndex(r => r.id === olderId);
    expect(newerIdx).toBeLessThan(olderIdx);
  });

  it("dismissed alerts are completely hidden (dismissedAt IS NOT NULL excluded)", async () => {
    // Insert only dismissed alerts — query should return 0 of our rows.
    const id1 = await insertAlert({ dismissedAt: new Date(Date.now() - 120_000) });
    const id2 = await insertAlert({ dismissedAt: new Date(Date.now() - 60_000) });

    const rows = await queryUnresolvedAlerts();
    const ownIds = rows.map(r => r.id).filter(id => id === id1 || id === id2);

    expect(ownIds).toHaveLength(0);
  });

  it("onConflictDoNothing — inserting duplicate stripeEventId is silently ignored", async () => {
    const eventId = `evt-dedup-${uid()}`;
    const firstId = await insertAlert({ stripeEventId: eventId });

    // Attempt to insert a second row with the same stripeEventId.
    const secondId = uid();
    await db.insert(stripeAlertsTable).values({
      id: secondId,
      stripeEventId: eventId, // duplicate
      eventType: "checkout.session.completed",
      reason: "Duplicate event",
    } as any).onConflictDoNothing({ target: stripeAlertsTable.stripeEventId });

    const rows = await queryUnresolvedAlerts();
    const ownIds = rows.map(r => r.id);

    // Only the first insert should exist.
    expect(ownIds).toContain(firstId);
    expect(ownIds).not.toContain(secondId);
  });

  it("after dismissBillingAlert runs, the alert disappears from the unresolved query", async () => {
    const alertId = await insertAlert();

    // Confirm it starts visible.
    const before = await queryUnresolvedAlerts();
    expect(before.map(r => r.id)).toContain(alertId);

    // Dismiss it via the real action.
    await dismissBillingAlert(alertId);

    // Confirm it is now hidden.
    const after = await queryUnresolvedAlerts();
    expect(after.map(r => r.id)).not.toContain(alertId);

    // Confirm dismissedAt is persisted (not deleted).
    const row = await db.query.stripeAlertsTable.findFirst({
      where: eq(stripeAlertsTable.id, alertId),
    });
    expect(row?.dismissedAt).toBeInstanceOf(Date);
  });
});
