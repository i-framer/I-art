/**
 * Replay banner clear — real-DB integration.
 *
 * Verifies that after a full-success replay, ALL stripeAlertsTable rows that
 * previously had slackPostFailed set are cleared to null.  This proves the
 * server action's UPDATE path commits correctly against a real PostgreSQL
 * database, so a regression in the clearing logic (e.g. the UPDATE not
 * committing) would be caught here rather than slipping past unit tests that
 * mock the DB.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, stripeAlertsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Platform admin guard — bypass ────────────────────────────────────────────
vi.mock("@/lib/platform-admin", () => ({
  requirePlatformAdmin: vi.fn(async () => {}),
}));

// ── Auth ─────────────────────────────────────────────────────────────────────
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({
    userId: "platform-admin",
    email: "admin@platform.test",
  })),
}));

// ── Slack — always succeeds unless overridden ─────────────────────────────────
const sendBillingAlertSlackNotificationMock = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true })),
);
vi.mock("@/lib/slack", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/slack")>();
  return {
    ...actual,
    resolveSlackChannel: vi.fn(() => "#test-billing-alerts"),
    sendBillingAlertSlackNotification: (...a: unknown[]) =>
      sendBillingAlertSlackNotificationMock(
        ...(a as Parameters<typeof sendBillingAlertSlackNotificationMock>),
      ),
    sendIframerSlackNotification: vi.fn(async () => ({ ok: true })),
    sendRefundDbFailureSlackNotification: vi.fn(async () => {}),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

process.env.SLACK_BILLING_ALERTS_CHANNEL = "#test-billing-alerts";

import { replayFailedSlackAlerts } from "@/app/platform/actions";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdAlertIds: string[] = [];

function uid() {
  return `${randomUUID()}-bbc-${RUN}-${++seq}`;
}

async function createAlert(opts: {
  slackPostFailed?: Date | null;
  dismissedAt?: Date | null;
}) {
  const id = uid();
  await db.insert(stripeAlertsTable).values({
    id,
    stripeEventId: `evt-${id}`,
    eventType: "customer.subscription.deleted",
    customerId: `cus-${id}`,
    reason: "Banner clear integration test",
    slackPostFailed: opts.slackPostFailed ?? null,
    dismissedAt: opts.dismissedAt ?? null,
  } as any);
  createdAlertIds.push(id);
  return id;
}

async function cleanup() {
  const ids = createdAlertIds.splice(0);
  if (ids.length) {
    await db
      .delete(stripeAlertsTable)
      .where(inArray(stripeAlertsTable.id, ids))
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
  "replay banner clear — real-DB integration",
  () => {
    it(
      "full-success replay: all seeded slackPostFailed rows are cleared to null",
      async () => {
        // Seed several alerts with failure timestamps spread across the past.
        const alertIds = await Promise.all([
          createAlert({ slackPostFailed: new Date(Date.now() - 120_000) }),
          createAlert({ slackPostFailed: new Date(Date.now() - 60_000) }),
          createAlert({ slackPostFailed: new Date(Date.now() - 30_000) }),
        ]);

        // All Slack calls succeed (default mock returns { ok: true }).
        const result = await replayFailedSlackAlerts();

        // At least the three rows we seeded should have been replayed.
        expect(result.replayed).toBeGreaterThanOrEqual(alertIds.length);
        expect(result.failed).toBe(0);

        // Re-query every seeded row and assert slackPostFailed is null.
        const rows = await db.query.stripeAlertsTable.findMany({
          where: (t, { inArray: inArr }) => inArr(t.id, alertIds),
        });

        expect(rows).toHaveLength(alertIds.length);
        for (const row of rows) {
          expect(row.slackPostFailed).toBeNull();
        }
      },
    );

    it(
      "partial failure: only successfully-replayed rows have slackPostFailed cleared",
      async () => {
        const successId = await createAlert({
          slackPostFailed: new Date(Date.now() - 90_000),
        });
        const failId = await createAlert({
          slackPostFailed: new Date(Date.now() - 90_000),
        });

        // First call succeeds, second fails.
        sendBillingAlertSlackNotificationMock
          .mockResolvedValueOnce({ ok: true })
          .mockResolvedValueOnce({ ok: false });

        const result = await replayFailedSlackAlerts();

        expect(result.replayed).toBeGreaterThanOrEqual(1);
        expect(result.failed).toBeGreaterThanOrEqual(1);

        const successRow = await db.query.stripeAlertsTable.findFirst({
          where: eq(stripeAlertsTable.id, successId),
        });
        const failRow = await db.query.stripeAlertsTable.findFirst({
          where: eq(stripeAlertsTable.id, failId),
        });

        // The row whose Slack call succeeded must have slackPostFailed cleared.
        expect(successRow?.slackPostFailed).toBeNull();

        // The row whose Slack call failed must still have slackPostFailed set.
        expect(failRow?.slackPostFailed).not.toBeNull();
      },
    );

    it(
      "dismissed rows are untouched even when they have slackPostFailed set",
      async () => {
        const dismissedId = await createAlert({
          slackPostFailed: new Date(Date.now() - 60_000),
          dismissedAt: new Date(),
        });

        const callsBefore = sendBillingAlertSlackNotificationMock.mock.calls.length;
        await replayFailedSlackAlerts();
        const callsAfter = sendBillingAlertSlackNotificationMock.mock.calls.length;

        // No Slack call should have been made for the dismissed alert.
        expect(callsAfter - callsBefore).toBe(0);

        // The dismissed row must remain unchanged.
        const row = await db.query.stripeAlertsTable.findFirst({
          where: eq(stripeAlertsTable.id, dismissedId),
        });
        expect(row?.slackPostFailed).not.toBeNull();
        expect(row?.dismissedAt).not.toBeNull();
      },
    );
  },
);
