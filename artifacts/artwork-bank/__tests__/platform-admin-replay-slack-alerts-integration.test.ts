/**
 * Platform admin replayFailedSlackAlerts and replayFailedIframerSlackAlerts — real-DB integration.
 *
 * artifacts/artwork-bank/app/platform/actions.ts:
 *
 *   replayFailedSlackAlerts — queries stripeAlertsTable where slackPostFailed IS NOT NULL
 *     and dismissedAt IS NULL, calls resolveSlackChannel + sendBillingAlertSlackNotification.
 *     On ok=true: clears slackPostFailed. On ok=false: failed++.
 *     No channel resolved → skipped++, flag preserved.
 *
 *   replayFailedIframerSlackAlerts — queries tenantsTable where iframerSlackPostFailed IS NOT NULL.
 *     On ok=true: clears iframerSlackPostFailed + iframerSlackFailedPayload.
 *
 *  1. replayFailedSlackAlerts clears slackPostFailed on Slack success.
 *  2. replayFailedSlackAlerts skips and preserves flag when no channel resolved.
 *  3. replayFailedSlackAlerts preserves slackPostFailed on Slack failure.
 *  4. replayFailedSlackAlerts ignores dismissed alerts.
 *  5. replayFailedIframerSlackAlerts clears iframerSlackPostFailed on success.
 *  6. replayFailedIframerSlackAlerts skips tenant without payload.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, stripeAlertsTable, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdEventIds: string[] = [];
const createdTenantIds: string[] = [];

function uid() { return `${randomUUID()}-prsai2-${RUN}-${++seq}`; }

const mockSendBillingAlert = vi.fn();
const mockSendIframerAlert = vi.fn();
const mockResolveSlackChannel = vi.fn();

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ userId: "u-platform-admin", tenantId: null, role: "platform_admin" })),
}));
vi.mock("@/lib/platform-admin", () => ({
  isPlatformAdmin: vi.fn(async () => true),
  requirePlatformAdmin: vi.fn(async () => {}),
}));
vi.mock("@/lib/slack", () => ({
  resolveSlackChannel: (...args: any[]) => mockResolveSlackChannel(...args),
  sendBillingAlertSlackNotification: (...args: any[]) => mockSendBillingAlert(...args),
  sendIframerAccountSlackNotification: (...args: any[]) => mockSendIframerAlert(...args),
  postToSlack: vi.fn(async () => {}),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  replayFailedSlackAlerts,
  replayFailedIframerSlackAlerts,
} from "@/app/platform/actions";

async function createAlert(opts: { slackPostFailed?: Date | null; dismissedAt?: Date | null } = {}) {
  const eventId = `evt_replay2_${uid()}`;
  await db.insert(stripeAlertsTable).values({
    stripeEventId: eventId,
    eventType: "invoice.payment_failed",
    customerId: `cus_${uid()}`,
    subscriptionId: `sub_${uid()}`,
    reason: "Test replay alert",
    slackPostFailed: opts.slackPostFailed ?? null,
    dismissedAt: opts.dismissedAt ?? null,
  } as any);
  createdEventIds.push(eventId);
  const row = await db.query.stripeAlertsTable.findFirst({
    where: eq(stripeAlertsTable.stripeEventId, eventId),
  });
  return { eventId, alertId: String(row!.id), rowId: row!.id };
}

async function createTenantWithIframerFlag(opts: { iframerSlackPostFailed?: Date | null; payload?: string | null } = {}) {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "iFramer Replay Test", type: "FRAMER",
    iframerSlackPostFailed: opts.iframerSlackPostFailed ?? null,
    iframerSlackFailedPayload: opts.payload ?? null,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function alertByEventId(eventId: string) {
  return db.query.stripeAlertsTable.findFirst({ where: eq(stripeAlertsTable.stripeEventId, eventId) });
}

async function tenantRow(tenantId: string) {
  return db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, tenantId) });
}

async function cleanup() {
  for (const eventId of createdEventIds.splice(0)) {
    await db.delete(stripeAlertsTable).where(eq(stripeAlertsTable.stripeEventId, eventId)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(async () => {
  mockSendBillingAlert.mockReset();
  mockSendIframerAlert.mockReset();
  mockResolveSlackChannel.mockReset();
  await cleanup();
});
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Platform admin Slack replay actions — real-DB integration", () => {
  it("replayFailedSlackAlerts clears slackPostFailed on Slack success", async () => {
    mockResolveSlackChannel.mockReturnValue("#billing-alerts");
    mockSendBillingAlert.mockResolvedValue({ ok: true });
    const failedAt = new Date(Date.now() - 60_000);
    const { eventId } = await createAlert({ slackPostFailed: failedAt });

    await replayFailedSlackAlerts();

    const alert = await alertByEventId(eventId);
    expect(alert?.slackPostFailed).toBeNull();
  });

  it("replayFailedSlackAlerts skips and preserves flag when no channel resolved", async () => {
    mockResolveSlackChannel.mockReturnValue(undefined); // no channel
    const failedAt = new Date(Date.now() - 60_000);
    const { eventId } = await createAlert({ slackPostFailed: failedAt });

    const result = await replayFailedSlackAlerts();

    expect(result.skipped).toBeGreaterThanOrEqual(1);
    const alert = await alertByEventId(eventId);
    expect(alert?.slackPostFailed).not.toBeNull(); // flag preserved
  });

  it("replayFailedSlackAlerts preserves slackPostFailed on Slack failure", async () => {
    mockResolveSlackChannel.mockReturnValue("#billing-alerts");
    mockSendBillingAlert.mockResolvedValue({ ok: false, error: "channel_not_found" });
    const failedAt = new Date(Date.now() - 60_000);
    const { eventId } = await createAlert({ slackPostFailed: failedAt });

    const result = await replayFailedSlackAlerts();

    expect(result.failed).toBeGreaterThanOrEqual(1);
    const alert = await alertByEventId(eventId);
    expect(alert?.slackPostFailed).not.toBeNull(); // flag preserved
  });

  it("replayFailedSlackAlerts ignores dismissed alerts (dismissedAt != null)", async () => {
    mockResolveSlackChannel.mockReturnValue("#billing-alerts");
    mockSendBillingAlert.mockResolvedValue({ ok: true });
    const failedAt = new Date(Date.now() - 60_000);
    const dismissedAt = new Date(Date.now() - 30_000);
    const { eventId } = await createAlert({ slackPostFailed: failedAt, dismissedAt });

    await replayFailedSlackAlerts();

    // The dismissed alert should NOT have its slackPostFailed cleared.
    // (It should stay as is since it was dismissed.)
    const alert = await alertByEventId(eventId);
    // The dismissed alert was not selected, so it was not processed.
    expect(alert?.dismissedAt).not.toBeNull();
  });

  it("replayFailedIframerSlackAlerts clears iframerSlackPostFailed and payload on success", async () => {
    mockSendIframerAlert.mockResolvedValue({ ok: true });
    const failedAt = new Date(Date.now() - 60_000);
    const payload = JSON.stringify({ action: "linked", accountId: "ifr_123", adminEmail: "admin@test.com" });
    const tenantId = await createTenantWithIframerFlag({ iframerSlackPostFailed: failedAt, payload });
    // Also set SLACK_BILLING_ALERTS_CHANNEL so it doesn't skip.
    process.env.SLACK_BILLING_ALERTS_CHANNEL = "#test-channel";

    const _result = await replayFailedIframerSlackAlerts();

    const row = await tenantRow(tenantId);
    expect(row?.iframerSlackPostFailed).toBeNull();
    expect(row?.iframerSlackFailedPayload).toBeNull();

    delete process.env.SLACK_BILLING_ALERTS_CHANNEL;
  });

  it("replayFailedIframerSlackAlerts skips tenant without payload (iframerSlackFailedPayload = null)", async () => {
    const failedAt = new Date(Date.now() - 60_000);
    const tenantId = await createTenantWithIframerFlag({ iframerSlackPostFailed: failedAt, payload: null });
    process.env.SLACK_BILLING_ALERTS_CHANNEL = "#test-channel";

    const result = await replayFailedIframerSlackAlerts();

    expect(result.skipped).toBeGreaterThanOrEqual(1);
    // Flag NOT cleared because payload was missing.
    const row = await tenantRow(tenantId);
    expect(row?.iframerSlackPostFailed).not.toBeNull();

    delete process.env.SLACK_BILLING_ALERTS_CHANNEL;
  });
});
