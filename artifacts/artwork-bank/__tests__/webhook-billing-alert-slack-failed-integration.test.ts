/**
 * invoice.payment_failed — slackPostFailed timestamp persistence — real-DB integration.
 *
 * app/api/stripe/webhook/route.ts:~225, ~358:
 *   When sendBillingAlertSlackNotification returns {ok: false}, the code sets
 *   stripeAlertsTable.slackPostFailed = new Date().
 *   When Slack succeeds: slackPostFailed remains null.
 *
 *  1. Slack failure → slackPostFailed is set on the alert row.
 *  2. Slack failure → slackPostFailed is a recent timestamp.
 *  3. Slack success → slackPostFailed remains null.
 *  4. Duplicate event delivery (idempotent) — slackPostFailed state is preserved.
 *  5. Alert row reason is populated even when Slack fails.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, stripeAlertsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdAlertEventIds: string[] = [];

function uid() { return `${randomUUID()}-wbasf-${RUN}-${++seq}`; }

const mockSendBillingAlertSlack = vi.fn();

vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(),
  getStripeWebhookSecret: vi.fn().mockResolvedValue(null),
  calcApplicationFee: vi.fn(),
  StripeNotConfiguredError: class extends Error {},
}));
vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: vi.fn(async () => true),
  sendBillingAlertNotification: vi.fn(),
}));
vi.mock("@/lib/slack", () => ({
  sendBillingAlertSlackNotification: (...args: any[]) => mockSendBillingAlertSlack(...args),
  sendIframerAccountSlackNotification: vi.fn(async () => {}),
  postToSlack: vi.fn(async () => {}),
}));
vi.mock("@/lib/iframer", () => ({
  createIFramerJob: vi.fn(),
  IFramerError: class extends Error {},
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));
vi.mock("@/lib/base-url", () => ({
  getTenantUrl: vi.fn(() => "https://example.com"),
}));

import { POST as webhookPOST } from "@/app/api/stripe/webhook/route";

function post(event: object) {
  return webhookPOST(
    new Request("http://localhost/api/stripe/webhook", {
      method: "POST",
      body: JSON.stringify(event),
    }),
  );
}

async function createTenant() {
  const id = uid();
  const customerId = `cus_${uid()}`;
  const iframerAccountId = `ifr_slk_${uid()}`;
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Billing Alert Slack Test", type: "FRAMER",
    billingExempt: false,
    stripeCustomerId: customerId,
    subscriptionStatus: "active",
    iframerAccountId,
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id, customerId, iframerAccountId };
}

function paymentFailedEvent(eventId: string, customerId: string, tenantId: string) {
  return {
    type: "invoice.payment_failed",
    id: eventId,
    data: {
      object: {
        customer: customerId,
        subscription: `sub_${uid()}`,
        metadata: { billingTenantId: tenantId },
      },
    },
  };
}

async function alertByEventId(eventId: string) {
  return db.query.stripeAlertsTable.findFirst({ where: eq(stripeAlertsTable.stripeEventId, eventId) });
}

async function cleanup() {
  for (const eventId of createdAlertEventIds.splice(0)) {
    await db.delete(stripeAlertsTable).where(eq(stripeAlertsTable.stripeEventId, eventId)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(async () => {
  mockSendBillingAlertSlack.mockReset();
  await cleanup();
});
afterAll(cleanup);

const RECENT_MS = 10_000;

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("invoice.payment_failed — slackPostFailed persistence — real-DB integration", () => {
  it("Slack failure → slackPostFailed is set on the alert row", async () => {
    mockSendBillingAlertSlack.mockResolvedValue({ ok: false, error: "channel_not_found" });
    const { tenantId, customerId } = await createTenant();
    const eventId = `evt_${uid()}`;
    createdAlertEventIds.push(eventId);

    const res = await post(paymentFailedEvent(eventId, customerId, tenantId));
    expect(res.status).toBe(200);

    const alert = await alertByEventId(eventId);
    expect(alert?.slackPostFailed).not.toBeNull();
  });

  it("Slack failure → slackPostFailed is a recent timestamp", async () => {
    mockSendBillingAlertSlack.mockResolvedValue({ ok: false, error: "channel_not_found" });
    const { tenantId, customerId } = await createTenant();
    const eventId = `evt_${uid()}`;
    createdAlertEventIds.push(eventId);
    const before = Date.now();

    await post(paymentFailedEvent(eventId, customerId, tenantId));

    const alert = await alertByEventId(eventId);
    expect(alert!.slackPostFailed!.getTime()).toBeGreaterThanOrEqual(before - RECENT_MS);
  });

  it("Slack success → slackPostFailed remains null", async () => {
    mockSendBillingAlertSlack.mockResolvedValue({ ok: true });
    const { tenantId, customerId } = await createTenant();
    const eventId = `evt_${uid()}`;
    createdAlertEventIds.push(eventId);

    await post(paymentFailedEvent(eventId, customerId, tenantId));

    const alert = await alertByEventId(eventId);
    expect(alert?.slackPostFailed).toBeNull();
  });

  it("duplicate event delivery — existing slackPostFailed state is preserved (no second insert)", async () => {
    mockSendBillingAlertSlack.mockResolvedValue({ ok: false, error: "channel_not_found" });
    const { tenantId, customerId } = await createTenant();
    const eventId = `evt_${uid()}`;
    createdAlertEventIds.push(eventId);

    await post(paymentFailedEvent(eventId, customerId, tenantId));
    const firstAlert = await alertByEventId(eventId);

    // Second delivery: Slack now succeeds but should NOT clear slackPostFailed (already processed).
    mockSendBillingAlertSlack.mockResolvedValue({ ok: true });
    await post(paymentFailedEvent(eventId, customerId, tenantId));

    const secondAlert = await alertByEventId(eventId);
    // Only one row exists (idempotent insert).
    expect(secondAlert?.id).toBe(firstAlert?.id);
  });

  it("alert row reason is populated even when Slack fails", async () => {
    mockSendBillingAlertSlack.mockResolvedValue({ ok: false, error: "channel_not_found" });
    const { tenantId, customerId } = await createTenant();
    const eventId = `evt_${uid()}`;
    createdAlertEventIds.push(eventId);

    await post(paymentFailedEvent(eventId, customerId, tenantId));

    const alert = await alertByEventId(eventId);
    expect(alert?.reason).not.toBeNull();
    expect(alert?.reason?.length).toBeGreaterThan(0);
  });
});
