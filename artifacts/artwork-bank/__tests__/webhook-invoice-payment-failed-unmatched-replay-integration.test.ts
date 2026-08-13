/**
 * invoice.payment_failed (unmatched customer) replay-safety — real-DB integration.
 *
 * The unmatched-customer path of handleInvoicePaymentFailed inserts a
 * stripeAlertsTable row with onConflictDoNothing(stripeEventId), so a second
 * delivery of the same event must:
 *   - NOT create a duplicate row (exactly one row remains).
 *   - NOT overwrite slackPostFailed (the original failure timestamp is preserved).
 *
 * This mirrors the replay-safety tests for the missing-metadata and
 * mismatch checkout paths in platform-billing-alerts-panel-checkout-integration.test.ts.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, stripeAlertsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Dev bypass — no Stripe signature required ────────────────────────────────
vi.stubEnv("STRIPE_WEBHOOK_DEV_BYPASS", "true");

// ── Mocks required by the webhook route ─────────────────────────────────────
vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(),
  getStripeWebhookSecret: vi.fn().mockResolvedValue(null),
  calcApplicationFee: (cents: number) => Math.round(cents * 0.05),
  StripeNotConfiguredError: class StripeNotConfiguredError extends Error {},
}));
vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: vi.fn(async () => {}),
  sendBillingAlertNotification: vi.fn(async () => {}),
}));

// Slack mock — controlled per-test so we can simulate failure on first delivery.
// Typed with an explicit return so both { ok: true } and { ok: false, error }
// are assignable when overriding with mockResolvedValueOnce.
const sendBillingAlertSlackNotificationMock = vi.hoisted(() =>
  vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true })),
);
vi.mock("@/lib/slack", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/slack")>();
  return {
    ...actual,
    sendBillingAlertSlackNotification: (
      ...a: unknown[]
    ) =>
      sendBillingAlertSlackNotificationMock(
        ...(a as Parameters<typeof sendBillingAlertSlackNotificationMock>),
      ),
    sendIframerAccountSlackNotification: vi.fn(async () => {}),
    postToSlack: vi.fn(async () => {}),
    resolveSlackChannel: vi.fn(() => "#test-billing-alerts"),
  };
});

vi.mock("@/lib/iframer", () => ({
  createIFramerJob: vi.fn(async () => ({ ok: true })),
  IFramerError: class IFramerError extends Error {},
}));
vi.mock("@/lib/base-url", () => ({
  getTenantUrl: vi.fn(() => "https://example.com"),
  getPlatformBaseUrl: vi.fn(() => "https://platform.test"),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: (_key: string) => null })),
}));

import { POST as webhookPOST } from "@/app/api/stripe/webhook/route";

// ── Fixtures ─────────────────────────────────────────────────────────────────
const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdAlertEventIds: string[] = [];

function uid() {
  return `${randomUUID()}-wipfur-${RUN}-${++seq}`;
}

async function cleanup() {
  for (const eventId of createdAlertEventIds.splice(0)) {
    await db
      .delete(stripeAlertsTable)
      .where(eq(stripeAlertsTable.stripeEventId, eventId))
      .catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db
      .delete(tenantsTable)
      .where(eq(tenantsTable.id, id))
      .catch(() => {});
  }
}

afterEach(async () => {
  sendBillingAlertSlackNotificationMock.mockClear();
  await cleanup();
});
afterAll(cleanup);

function makeRequest(event: object): Request {
  return new Request("http://localhost/api/stripe/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });
}

/** Build an invoice.payment_failed payload for a customer that matches no tenant. */
function unmatchedInvoiceFailedEvent(eventId: string, customerId: string) {
  return {
    id: eventId,
    type: "invoice.payment_failed",
    data: {
      object: {
        id: `in_${uid()}`,
        customer: customerId,
        subscription: `sub_${uid()}`,
        attempt_count: 1,
        amount_due: 5000,
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration(
  "invoice.payment_failed unmatched-customer replay-safety — real-DB integration",
  () => {
    it("two deliveries of the same event produce exactly one stripeAlerts row", async () => {
      const customerId = `cus_nomatch_${uid()}`;
      const eventId = `evt_wipfur_${uid()}`;
      createdAlertEventIds.push(eventId);

      const r1 = await webhookPOST(
        makeRequest(unmatchedInvoiceFailedEvent(eventId, customerId)),
      );
      expect(r1.status).toBe(200);

      const r2 = await webhookPOST(
        makeRequest(unmatchedInvoiceFailedEvent(eventId, customerId)),
      );
      expect(r2.status).toBe(200);

      const rows = await db.query.stripeAlertsTable.findMany({
        where: eq(stripeAlertsTable.stripeEventId, eventId),
      });
      expect(rows).toHaveLength(1);
    }, 30_000);

    it("slackPostFailed set on first delivery is unchanged after second delivery", async () => {
      // Make Slack fail on the first delivery so slackPostFailed gets written.
      sendBillingAlertSlackNotificationMock.mockResolvedValueOnce({
        ok: false as const,
        error: "token_revoked",
      });

      const customerId = `cus_nomatch_${uid()}`;
      const eventId = `evt_wipfur_slack_${uid()}`;
      createdAlertEventIds.push(eventId);

      // First delivery — Slack fails, so slackPostFailed is set.
      await webhookPOST(
        makeRequest(unmatchedInvoiceFailedEvent(eventId, customerId)),
      );

      const afterFirst = await db.query.stripeAlertsTable.findFirst({
        where: eq(stripeAlertsTable.stripeEventId, eventId),
      });
      expect(afterFirst).toBeDefined();
      expect(afterFirst?.slackPostFailed).toBeInstanceOf(Date);

      const originalSlackPostFailed = afterFirst!.slackPostFailed;

      // Second delivery — onConflictDoNothing fires; Slack must NOT be called again.
      await webhookPOST(
        makeRequest(unmatchedInvoiceFailedEvent(eventId, customerId)),
      );

      const afterSecond = await db.query.stripeAlertsTable.findFirst({
        where: eq(stripeAlertsTable.stripeEventId, eventId),
      });
      expect(afterSecond).toBeDefined();

      // Still exactly the original timestamp — not overwritten by the second delivery.
      expect(afterSecond?.slackPostFailed).toEqual(originalSlackPostFailed);
    });

    it("Slack is called exactly once across two deliveries (not called on the replay)", async () => {
      const customerId = `cus_nomatch_${uid()}`;
      const eventId = `evt_wipfur_calls_${uid()}`;
      createdAlertEventIds.push(eventId);

      await webhookPOST(
        makeRequest(unmatchedInvoiceFailedEvent(eventId, customerId)),
      );
      await webhookPOST(
        makeRequest(unmatchedInvoiceFailedEvent(eventId, customerId)),
      );

      // The mock is cleared in afterEach, so the count here is for this test only.
      // Slack must have been called exactly once (first delivery) — not on the replay.
      expect(sendBillingAlertSlackNotificationMock).toHaveBeenCalledTimes(1);
    });
  },
);
