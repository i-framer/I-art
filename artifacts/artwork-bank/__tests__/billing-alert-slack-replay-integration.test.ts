/**
 * replayFailedSlackAlerts (billing alerts) — real-DB integration.
 *
 * Unit tests (slack-replay.test.ts) mock the DB.  This integration suite
 * verifies the DB persistence invariants against real PostgreSQL:
 *
 *  1. Success path: clears slackPostFailed to null; replayed incremented.
 *  2. Failure path (Slack returns ok:false): slackPostFailed remains; failed
 *     incremented.
 *  3. Dismissed alert is ignored entirely.
 *  4. Alert with null slackPostFailed is ignored entirely.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, stripeAlertsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Platform admin guard — bypass ─────────────────────────────────────────────
vi.mock("@/lib/platform-admin", () => ({
  requirePlatformAdmin: vi.fn(async () => {}),
}));

// ── Auth ──────────────────────────────────────────────────────────────────────
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({
    userId: "platform-admin",
    email: "admin@platform.test",
  })),
}));

// ── Slack — controlled per-test (use importOriginal to keep all exports) ───────
const sendBillingAlertSlackNotificationMock = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true })),
);
vi.mock("@/lib/slack", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/slack")>();
  return {
    ...actual,
    resolveSlackChannel: vi.fn(() => "#test-billing-alerts"),
    sendBillingAlertSlackNotification: (...a: unknown[]) =>
      sendBillingAlertSlackNotificationMock(...(a as Parameters<typeof sendBillingAlertSlackNotificationMock>)),
    sendIframerSlackNotification: vi.fn(async () => ({ ok: true })),
    sendRefundDbFailureSlackNotification: vi.fn(async () => {}),
  };
});
const sendBillingAlertSlack = sendBillingAlertSlackNotificationMock;

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// Ensure the channel env var is set.
process.env.SLACK_BILLING_ALERTS_CHANNEL = "#test-billing-alerts";

import { replayFailedSlackAlerts } from "@/app/platform/actions";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdAlertIds: string[] = [];

function uid() { return `${randomUUID()}-blar-${RUN}-${++seq}`; }

async function _createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Billing Alert Replay Test", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createAlert(opts: {
  slackPostFailed?: Date | null;
  dismissedAt?: Date | null;
  eventType?: string;
}) {
  const id = uid();
  await db.insert(stripeAlertsTable).values({
    id,
    stripeEventId: `evt-${id}`,
    eventType: opts.eventType ?? "customer.subscription.deleted",
    customerId: `cus-${id}`,
    reason: "Test unmatched alert",
    slackPostFailed: opts.slackPostFailed ?? null,
    dismissedAt: opts.dismissedAt ?? null,
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

afterEach(async () => {
  sendBillingAlertSlack.mockClear();
  await cleanup();
});
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("replayFailedSlackAlerts (billing alerts) — real-DB integration", () => {
  it("success path: clears slackPostFailed to null; replayed incremented", async () => {
    const alertId = await createAlert({
      slackPostFailed: new Date(Date.now() - 60000),
    });

    sendBillingAlertSlack.mockResolvedValueOnce({ ok: true });

    const result = await replayFailedSlackAlerts();

    expect(result.replayed).toBeGreaterThanOrEqual(1);

    const row = await db.query.stripeAlertsTable.findFirst({
      where: eq(stripeAlertsTable.id, alertId),
    });
    expect(row?.slackPostFailed).toBeNull();
  });

  it("failure path (Slack ok:false): slackPostFailed remains non-null; failed incremented", async () => {
    const failedAt = new Date(Date.now() - 60000);
    const alertId = await createAlert({ slackPostFailed: failedAt });

    sendBillingAlertSlack.mockResolvedValueOnce({ ok: false });

    const result = await replayFailedSlackAlerts();

    expect(result.failed).toBeGreaterThanOrEqual(1);

    const row = await db.query.stripeAlertsTable.findFirst({
      where: eq(stripeAlertsTable.id, alertId),
    });
    expect(row?.slackPostFailed).not.toBeNull();
  });

  it("failure path: retry sweep refreshes slackPostFailed to a later timestamp", async () => {
    // Insert an alert whose slackPostFailed is well in the past so any fresh
    // write will be strictly later.
    const originalFailedAt = new Date(Date.now() - 60_000);
    const alertId = await createAlert({ slackPostFailed: originalFailedAt });

    sendBillingAlertSlack.mockResolvedValueOnce({ ok: false });

    const beforeRetry = new Date();
    await replayFailedSlackAlerts();

    const row = await db.query.stripeAlertsTable.findFirst({
      where: eq(stripeAlertsTable.id, alertId),
    });

    // Timestamp must have been written after the sweep started (not the
    // original stale value), so the operator can tell this is a recent failure.
    expect(row?.slackPostFailed).not.toBeNull();
    expect(row!.slackPostFailed!.getTime()).toBeGreaterThanOrEqual(
      beforeRetry.getTime(),
    );
  });

  it("dismissed alert is ignored — Slack not called for it", async () => {
    const alertId = await createAlert({
      slackPostFailed: new Date(Date.now() - 60000),
      dismissedAt: new Date(), // dismissed → must be excluded from replay
    });

    const callsBefore = sendBillingAlertSlack.mock.calls.length;
    await replayFailedSlackAlerts();

    // No extra calls were made for the dismissed alert.
    const callsAfter = sendBillingAlertSlack.mock.calls.length;
    const callsMadeForOurAlert = callsAfter - callsBefore;
    expect(callsMadeForOurAlert).toBe(0);

    // Row is unchanged.
    const row = await db.query.stripeAlertsTable.findFirst({
      where: eq(stripeAlertsTable.id, alertId),
    });
    expect(row?.slackPostFailed).not.toBeNull();
    expect(row?.dismissedAt).not.toBeNull();
  });

  it("alert with null slackPostFailed is not selected for replay", async () => {
    await createAlert({ slackPostFailed: null });

    const callsBefore = sendBillingAlertSlack.mock.calls.length;
    await replayFailedSlackAlerts();
    const callsAfter = sendBillingAlertSlack.mock.calls.length;

    expect(callsAfter - callsBefore).toBe(0);
  });
});
