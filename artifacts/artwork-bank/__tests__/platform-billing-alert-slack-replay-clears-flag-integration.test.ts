/**
 * replayFailedSlackAlerts — successful replay clears slackPostFailed (real-DB integration).
 *
 * Confirms that after a successful replayFailedSlackAlerts run:
 *   1. The row is still visible in the platform panel query (dismissedAt is
 *      NOT set by replay — only the operator's explicit dismiss action does that).
 *   2. slackPostFailed is cleared to null, so the "Slack missed" badge no
 *      longer appears next to the alert.
 *
 * Companion to:
 *   platform-billing-alert-slack-missed-query-integration.test.ts — query contract
 *   billing-alert-corrupted-eventtype-integration.test.ts           — skipped path
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, stripeAlertsTable } from "@workspace/db";
import { desc, eq, isNull } from "drizzle-orm";
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

// ── Slack — ok:true to simulate a successful replay ───────────────────────────
//
// resolveSlackChannel must return a truthy channel so the alert is not skipped.
// sendBillingAlertSlackNotification returns ok:true so the flag is cleared.
const sendBillingAlertSlackNotificationMock = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true as const })),
);
vi.mock("@/lib/slack", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/slack")>();
  return {
    ...actual,
    resolveSlackChannel: vi.fn(() => "#billing-alerts"),
    sendBillingAlertSlackNotification: (...a: unknown[]) =>
      sendBillingAlertSlackNotificationMock(
        ...(a as Parameters<typeof sendBillingAlertSlackNotificationMock>),
      ),
    sendIframerAccountSlackNotification: vi.fn(async () => ({ ok: true })),
    sendRefundDbFailureSlackNotification: vi.fn(async () => {}),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { replayFailedSlackAlerts } from "@/app/platform/actions";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdAlertIds: string[] = [];

function uid() {
  return `${randomUUID()}-bsrc-${RUN}-${++seq}`;
}

async function insertAlert(opts: {
  slackPostFailed?: Date;
  dismissedAt?: Date | null;
} = {}) {
  const id = uid();
  await db.insert(stripeAlertsTable).values({
    id,
    stripeEventId: `evt-${id}`,
    eventType: "customer.subscription.updated",
    customerId: `cus-${id}`,
    reason: "Slack replay clears flag test",
    slackPostFailed: opts.slackPostFailed ?? new Date(Date.now() - 60_000),
    dismissedAt: opts.dismissedAt !== undefined ? opts.dismissedAt : null,
  } as any);
  createdAlertIds.push(id);
  return id;
}

/** Mirrors the query in app/platform/page.tsx — returns all unresolved alerts. */
async function queryUnresolvedAlerts() {
  return db
    .select()
    .from(stripeAlertsTable)
    .where(isNull(stripeAlertsTable.dismissedAt))
    .orderBy(desc(stripeAlertsTable.createdAt));
}

async function cleanup() {
  for (const id of createdAlertIds.splice(0)) {
    await db
      .delete(stripeAlertsTable)
      .where(eq(stripeAlertsTable.id, id))
      .catch(() => {});
  }
}

afterEach(async () => {
  sendBillingAlertSlackNotificationMock.mockClear();
  await cleanup();
});
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration(
  "replayFailedSlackAlerts — successful replay clears slackPostFailed (real-DB integration)",
  () => {
    it(
      "after a successful replay the row still appears in the platform query (not dismissed)",
      async () => {
        const alertId = await insertAlert({
          slackPostFailed: new Date(Date.now() - 60_000),
          dismissedAt: null,
        });

        const result = await replayFailedSlackAlerts();
        expect(result.replayed).toBeGreaterThanOrEqual(1);

        // dismissedAt must remain null — replay never dismisses alerts.
        const rows = await queryUnresolvedAlerts();
        const ids = rows.map((r) => r.id);
        expect(ids).toContain(alertId);
      },
    );

    it(
      "after a successful replay slackPostFailed is cleared to null on the row",
      async () => {
        const alertId = await insertAlert({
          slackPostFailed: new Date(Date.now() - 120_000),
          dismissedAt: null,
        });

        const result = await replayFailedSlackAlerts();
        expect(result.replayed).toBeGreaterThanOrEqual(1);
        expect(result.failed).toBe(0);

        const row = await db.query.stripeAlertsTable.findFirst({
          where: eq(stripeAlertsTable.id, alertId),
        });
        expect(row).toBeDefined();
        // Core assertion: the "Slack missed" flag must be gone after a
        // successful delivery so the badge no longer renders.
        expect(row!.slackPostFailed).toBeNull();
      },
    );

    it(
      "dismissedAt is still null after replay (replay does not dismiss the alert)",
      async () => {
        const alertId = await insertAlert({
          slackPostFailed: new Date(Date.now() - 60_000),
          dismissedAt: null,
        });

        await replayFailedSlackAlerts();

        const row = await db.query.stripeAlertsTable.findFirst({
          where: eq(stripeAlertsTable.id, alertId),
        });
        expect(row).toBeDefined();
        expect(row!.dismissedAt).toBeNull();
      },
    );

    it(
      "replay sends a Slack notification for the seeded alert",
      async () => {
        await insertAlert({
          slackPostFailed: new Date(Date.now() - 60_000),
          dismissedAt: null,
        });

        await replayFailedSlackAlerts();

        expect(sendBillingAlertSlackNotificationMock).toHaveBeenCalledTimes(1);
      },
    );

    it(
      "only the replayed alert loses slackPostFailed; a second alert with dismissedAt set is not touched",
      async () => {
        const replayableId = await insertAlert({
          slackPostFailed: new Date(Date.now() - 60_000),
          dismissedAt: null,
        });
        // Already dismissed — replayFailedSlackAlerts must not touch this row.
        const dismissedId = await insertAlert({
          slackPostFailed: new Date(Date.now() - 60_000),
          dismissedAt: new Date(Date.now() - 30_000),
        });

        const result = await replayFailedSlackAlerts();
        expect(result.replayed).toBeGreaterThanOrEqual(1);

        const replayableRow = await db.query.stripeAlertsTable.findFirst({
          where: eq(stripeAlertsTable.id, replayableId),
        });
        const dismissedRow = await db.query.stripeAlertsTable.findFirst({
          where: eq(stripeAlertsTable.id, dismissedId),
        });

        // Replayable alert: flag cleared.
        expect(replayableRow!.slackPostFailed).toBeNull();
        // Dismissed alert: dismissedAt is still set (not disturbed by replay).
        expect(dismissedRow!.dismissedAt).not.toBeNull();
        // The dismissed alert is not in the unresolved query.
        const rows = await queryUnresolvedAlerts();
        const ids = rows.map((r) => r.id);
        expect(ids).toContain(replayableId);
        expect(ids).not.toContain(dismissedId);
      },
    );
  },
);
