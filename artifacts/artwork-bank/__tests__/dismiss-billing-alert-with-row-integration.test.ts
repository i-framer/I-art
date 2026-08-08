/**
 * dismissBillingAlert with a real stripeAlerts row — real-DB integration.
 *
 * artifacts/artwork-bank/app/platform/actions.ts:dismissBillingAlert(alertId: string):
 *   Sets dismissedAt on the matching stripe alert row.
 *
 * Existing platform-admin-mutations-integration.test.ts only tests the
 * nonexistent-ID no-op case. These tests exercise real alert rows.
 *
 *  1. dismissBillingAlert sets dismissedAt on a real alert row.
 *  2. dismissedAt is set to a recent timestamp.
 *  3. Calling dismiss twice (idempotent) — dismissedAt not null.
 *  4. Other fields on the alert row are unchanged after dismissal.
 *  5. Dismissing one alert does not affect other alert rows.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, stripeAlertsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdEventIds: string[] = [];

function uid() { return `${randomUUID()}-dbawi-${RUN}-${++seq}`; }

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ userId: "u-platform-admin", tenantId: null, role: "platform_admin" })),
}));
vi.mock("@/lib/platform-admin", () => ({
  isPlatformAdmin: vi.fn(async () => true),
  requirePlatformAdmin: vi.fn(async () => {}),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { dismissBillingAlert } from "@/app/platform/actions";

async function createAlert() {
  const eventId = `evt_dismiss_real_${uid()}`;
  await db.insert(stripeAlertsTable).values({
    stripeEventId: eventId,
    eventType: "invoice.payment_failed",
    customerId: `cus_${uid()}`,
    subscriptionId: `sub_${uid()}`,
    reason: "Test alert for real-row dismiss",
    dismissedAt: null,
  } as any);
  createdEventIds.push(eventId);

  // Get the inserted row to return its numeric id.
  const row = await db.query.stripeAlertsTable.findFirst({
    where: eq(stripeAlertsTable.stripeEventId, eventId),
  });
  return { eventId, alertId: String(row!.id) };
}

async function alertByEventId(eventId: string) {
  return db.query.stripeAlertsTable.findFirst({ where: eq(stripeAlertsTable.stripeEventId, eventId) });
}

async function cleanup() {
  for (const eventId of createdEventIds.splice(0)) {
    await db.delete(stripeAlertsTable).where(eq(stripeAlertsTable.stripeEventId, eventId)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

const RECENT_MS = 10_000;

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("dismissBillingAlert with real alert row — real-DB integration", () => {
  it("dismissBillingAlert sets dismissedAt on a real alert row", async () => {
    const { eventId, alertId } = await createAlert();

    await dismissBillingAlert(alertId);

    const row = await alertByEventId(eventId);
    expect(row?.dismissedAt).not.toBeNull();
  });

  it("dismissedAt is set to a recent timestamp", async () => {
    const { eventId, alertId } = await createAlert();
    const before = Date.now();

    await dismissBillingAlert(alertId);

    const row = await alertByEventId(eventId);
    expect(row!.dismissedAt!.getTime()).toBeGreaterThanOrEqual(before - RECENT_MS);
  });

  it("calling dismiss twice — dismissedAt is not null (idempotent)", async () => {
    const { eventId, alertId } = await createAlert();

    await dismissBillingAlert(alertId);
    await dismissBillingAlert(alertId);

    const row = await alertByEventId(eventId);
    expect(row?.dismissedAt).not.toBeNull();
  });

  it("other fields on the alert row are unchanged after dismissal", async () => {
    const { eventId, alertId } = await createAlert();
    const before = await alertByEventId(eventId);

    await dismissBillingAlert(alertId);

    const after = await alertByEventId(eventId);
    expect(after?.stripeEventId).toBe(before?.stripeEventId);
    expect(after?.reason).toBe(before?.reason);
    expect(after?.customerId).toBe(before?.customerId);
    expect(after?.subscriptionId).toBe(before?.subscriptionId);
  });

  it("dismissing one alert does not affect other alert rows", async () => {
    const { alertId: alertId1 } = await createAlert();
    const { eventId: eventId2 } = await createAlert();

    await dismissBillingAlert(alertId1);

    const other = await alertByEventId(eventId2);
    expect(other?.dismissedAt).toBeNull();
  });
});
