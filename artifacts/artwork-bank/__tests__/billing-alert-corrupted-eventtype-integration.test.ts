/**
 * replayFailedSlackAlerts — corrupted eventType integration.
 *
 * Verifies that a stripeAlertsTable row whose eventType is null or
 * unrecognised (causing resolveSlackChannel to return null) is counted as
 * `skipped`, not silently dropped:
 *
 *  1. null eventType  → skipped >= 1; slackPostFailed preserved; no Slack call.
 *  2. unrecognised eventType (e.g. "bogus.event.type") → same invariants.
 *
 * This ensures corrupted-field rows remain visible to the operator in the
 * platform panel and are never silently lost.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, stripeAlertsTable } from "@workspace/db";
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

// ── Slack — resolveSlackChannel returns null to simulate corrupted eventType ──
//
// We keep sendBillingAlertSlackNotification accessible so we can assert it was
// never called when the channel guard fires first.
const sendBillingAlertSlackNotificationMock = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true })),
);
vi.mock("@/lib/slack", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/slack")>();
  return {
    ...actual,
    // Return null for every eventType — simulates null / unrecognised values.
    resolveSlackChannel: vi.fn(() => null),
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
  return `${randomUUID()}-bevt-${RUN}-${++seq}`;
}

async function createAlert(opts: {
  eventType: string;
  slackPostFailed?: Date;
}) {
  const id = uid();
  await db.insert(stripeAlertsTable).values({
    id,
    stripeEventId: `evt-${id}`,
    eventType: opts.eventType,
    customerId: `cus-${id}`,
    reason: "Corrupted eventType test",
    slackPostFailed: opts.slackPostFailed ?? new Date(Date.now() - 60_000),
    dismissedAt: null,
  });
  createdAlertIds.push(id);
  return id;
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
  "replayFailedSlackAlerts — corrupted eventType (real-DB integration)",
  () => {
    it(
      "empty-string eventType (DB-level corruption proxy): alert is counted as skipped; slackPostFailed is preserved; no Slack call made",
      async () => {
        // The stripe_alert.event_type column has a NOT NULL constraint, so a
        // true SQL NULL cannot be seeded via the ORM.  An empty string "" is
        // the closest DB-legal proxy for a corrupted/absent eventType value:
        // resolveSlackChannel returns null for it (mocked above), which
        // triggers the same skipped path as any unrecognised value.
        const failedAt = new Date(Date.now() - 60_000);
        const alertId = await createAlert({
          eventType: "",
          slackPostFailed: failedAt,
        });

        const result = await replayFailedSlackAlerts();

        // Must appear in `skipped`, not `replayed` or `failed`.
        expect(result.skipped).toBeGreaterThanOrEqual(1);

        // No Slack notification should have been attempted.
        expect(sendBillingAlertSlackNotificationMock).not.toHaveBeenCalled();

        // The failure timestamp must remain exactly as seeded — the row is
        // still visible to the operator in the platform panel.
        const row = await db.query.stripeAlertsTable.findFirst({
          where: eq(stripeAlertsTable.id, alertId),
        });
        expect(row?.slackPostFailed).not.toBeNull();
        expect(row!.slackPostFailed!.getTime()).toBe(failedAt.getTime());
      },
    );

    it(
      "unrecognised eventType: alert is counted as skipped; slackPostFailed is preserved; no Slack call made",
      async () => {
        const failedAt = new Date(Date.now() - 60_000);
        const alertId = await createAlert({
          eventType: "bogus.unrecognised.event.type",
          slackPostFailed: failedAt,
        });

        const result = await replayFailedSlackAlerts();

        // Must appear in `skipped`, not `replayed` or `failed`.
        expect(result.skipped).toBeGreaterThanOrEqual(1);

        // No Slack notification should have been attempted.
        expect(sendBillingAlertSlackNotificationMock).not.toHaveBeenCalled();

        // slackPostFailed must be left exactly as seeded so the operator can
        // see the row was already failing before the sweep ran.
        const row = await db.query.stripeAlertsTable.findFirst({
          where: eq(stripeAlertsTable.id, alertId),
        });
        expect(row?.slackPostFailed).not.toBeNull();
        expect(row!.slackPostFailed!.getTime()).toBe(failedAt.getTime());
      },
    );
  },
);
