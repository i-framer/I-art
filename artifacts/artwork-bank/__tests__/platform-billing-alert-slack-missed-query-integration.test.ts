/**
 * Platform admin — billing alert "Slack missed" query — real-DB integration.
 *
 * The platform/page.tsx fetches unresolved Stripe alerts with:
 *   db.select().from(stripeAlertsTable).where(isNull(stripeAlertsTable.dismissedAt))
 *
 * This suite confirms that the query returns rows whose `slackPostFailed` is
 * non-null (i.e. the alert was never delivered to Slack) and that the
 * `slackPostFailed` field is present on the returned row — the contract the
 * BillingAlerts component relies on to render the "Slack missed" badge.
 *
 * Companion to:
 *   billing-alert-corrupted-eventtype-panel.ui.test.tsx  — UI-layer contract
 *   platform-billing-alert-query-integration.test.ts     — dismissedAt filter
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, stripeAlertsTable } from "@workspace/db";
import { desc, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdAlertIds: string[] = [];

function uid() {
  return `${randomUUID()}-basm-${RUN}-${++seq}`;
}

async function insertAlert(opts: {
  eventType?: string;
  slackPostFailed?: Date | null;
  dismissedAt?: Date | null;
} = {}) {
  const id = uid();
  await db.insert(stripeAlertsTable).values({
    id,
    stripeEventId: `evt-${id}`,
    eventType: opts.eventType ?? "customer.subscription.updated",
    customerId: `cus-${id}`,
    reason: "Slack missed query test",
    slackPostFailed: opts.slackPostFailed !== undefined
      ? opts.slackPostFailed
      : new Date(Date.now() - 60_000),
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

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration(
  "Platform admin page query — 'Slack missed' badge row (real-DB integration)",
  () => {
    it(
      "row with slackPostFailed non-null and dismissedAt null appears in query results",
      async () => {
        const alertId = await insertAlert({
          slackPostFailed: new Date(Date.now() - 60_000),
          dismissedAt: null,
        });

        const rows = await queryUnresolvedAlerts();
        const ids = rows.map((r) => r.id);

        expect(ids).toContain(alertId);
      },
    );

    it(
      "returned row carries the slackPostFailed field (non-null)",
      async () => {
        const failedAt = new Date(Date.now() - 120_000);
        const alertId = await insertAlert({
          slackPostFailed: failedAt,
          dismissedAt: null,
        });

        const rows = await queryUnresolvedAlerts();
        const row = rows.find((r) => r.id === alertId);

        expect(row).toBeDefined();
        expect(row!.slackPostFailed).toBeInstanceOf(Date);
        expect(row!.slackPostFailed!.getTime()).toBe(failedAt.getTime());
      },
    );

    it(
      "row with slackPostFailed non-null is NOT filtered out — dismissedAt null is the only guard",
      async () => {
        // Seed one row with slackPostFailed set (unresolved) and one that is
        // dismissed — only the unresolved one should appear.
        const unresolvedId = await insertAlert({
          slackPostFailed: new Date(Date.now() - 60_000),
          dismissedAt: null,
        });
        const dismissedId = await insertAlert({
          slackPostFailed: new Date(Date.now() - 60_000),
          dismissedAt: new Date(Date.now() - 30_000),
        });

        const rows = await queryUnresolvedAlerts();
        const ids = rows.map((r) => r.id);

        expect(ids).toContain(unresolvedId);
        expect(ids).not.toContain(dismissedId);
      },
    );

    it(
      "corrupted (empty-string) eventType with slackPostFailed set still appears in query results",
      async () => {
        // The NOT NULL constraint prevents a true SQL NULL; empty string "" is
        // the closest DB-legal proxy for a corrupted/absent eventType value.
        const alertId = await insertAlert({
          eventType: "",
          slackPostFailed: new Date(Date.now() - 60_000),
          dismissedAt: null,
        });

        const rows = await queryUnresolvedAlerts();
        const ids = rows.map((r) => r.id);

        expect(ids).toContain(alertId);
      },
    );

    it(
      "unrecognised eventType with slackPostFailed set still appears in query results",
      async () => {
        const alertId = await insertAlert({
          eventType: "bogus.unrecognised.event.type",
          slackPostFailed: new Date(Date.now() - 60_000),
          dismissedAt: null,
        });

        const rows = await queryUnresolvedAlerts();
        const row = rows.find((r) => r.id === alertId);

        expect(row).toBeDefined();
        // slackPostFailed must be carried through — the UI badge depends on it.
        expect(row!.slackPostFailed).not.toBeNull();
      },
    );

    it(
      "row with slackPostFailed null still appears (slackPostFailed is not a filter criterion)",
      async () => {
        // The query only filters on dismissedAt; slackPostFailed = null rows
        // must also be returned so the full alert list is shown.
        const alertId = await insertAlert({
          slackPostFailed: null,
          dismissedAt: null,
        });

        const rows = await queryUnresolvedAlerts();
        const ids = rows.map((r) => r.id);

        expect(ids).toContain(alertId);
      },
    );
  },
);
