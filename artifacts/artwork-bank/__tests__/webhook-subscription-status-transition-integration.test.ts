/**
 * customer.subscription.updated — active→past_due status transition — real-DB integration.
 *
 * app/api/stripe/webhook/route.ts:262-320 (handleSubscriptionEvent):
 *   Sets subscriptionStatus to Stripe subscription.status.
 *   Never overwrites "canceled" with a live status for the same subscription.
 *   Matches tenant by metadata.billingTenantId, then stripeCustomerId.
 *
 *  1. active tenant → past_due event → subscriptionStatus=past_due.
 *  2. past_due tenant → active event → subscriptionStatus=active.
 *  3. canceled tenant + same subscriptionId → status NOT overwritten (out-of-order guard).
 *  4. Unknown tenantId in metadata → no tenant updated.
 *  5. subscriptionId persisted on the tenant row.
 *  6. past_due → canceled → subscriptionStatus=canceled.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, stripeAlertsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];

function uid() { return `${randomUUID()}-wsstri-${RUN}-${++seq}`; }

vi.mock("@/lib/slack", () => ({
  sendBillingAlertSlackNotification: vi.fn(async () => ({ ok: true })),
  sendIframerAccountSlackNotification: vi.fn(async () => {}),
  postToSlack: vi.fn(async () => {}),
  resolveSlackChannel: vi.fn(() => null),
}));
vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(),
  getStripeWebhookSecret: vi.fn().mockResolvedValue(null),
  calcApplicationFee: vi.fn(),
  StripeNotConfiguredError: class extends Error {},
}));
vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: vi.fn(async () => true),
}));
vi.mock("@/lib/iframer", () => ({
  createIFramerJob: vi.fn(),
  IFramerError: class extends Error {},
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/base-url", () => ({ getTenantUrl: vi.fn(() => "https://example.com") }));

import { POST as webhookPOST } from "@/app/api/stripe/webhook/route";

function subscriptionEvent(
  eventType: string,
  subscriptionId: string,
  tenantId: string,
  status: string,
  customerId?: string,
) {
  return {
    type: eventType,
    id: `evt_${uid()}`,
    data: {
      object: {
        id: subscriptionId,
        status,
        customer: customerId ?? `cus_${uid()}`,
        trial_end: null,
        metadata: { billingTenantId: tenantId },
      },
    },
  };
}

function post(event: object) {
  return webhookPOST(new Request("http://localhost/api/stripe/webhook", {
    method: "POST",
    body: JSON.stringify(event),
  }));
}

async function createTenant(opts: { subscriptionStatus?: string; stripeSubscriptionId?: string } = {}) {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Sub Status Test", type: "ARTIST",
    subscriptionStatus: opts.subscriptionStatus ?? "active",
    stripeSubscriptionId: opts.stripeSubscriptionId ?? null,
    billingExempt: false,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function tenantStatus(tenantId: string) {
  return (await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, tenantId) }))?.subscriptionStatus;
}

async function cleanup() {
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(stripeAlertsTable).where(eq(stripeAlertsTable.tenantId, id)).catch(() => {});
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Subscription status transition — real-DB integration", () => {
  it("active tenant + past_due event → subscriptionStatus=past_due", async () => {
    const tenantId = await createTenant({ subscriptionStatus: "active" });
    const subId    = `sub_${uid()}`;

    await post(subscriptionEvent("customer.subscription.updated", subId, tenantId, "past_due"));

    expect(await tenantStatus(tenantId)).toBe("past_due");
  });

  it("past_due tenant + active event → subscriptionStatus=active", async () => {
    const tenantId = await createTenant({ subscriptionStatus: "past_due" });
    const subId    = `sub_${uid()}`;

    await post(subscriptionEvent("customer.subscription.updated", subId, tenantId, "active"));

    expect(await tenantStatus(tenantId)).toBe("active");
  });

  it("canceled tenant + same subscriptionId → status NOT overwritten (out-of-order guard)", async () => {
    const subId    = `sub_${uid()}`;
    const tenantId = await createTenant({ subscriptionStatus: "canceled", stripeSubscriptionId: subId });

    await post(subscriptionEvent("customer.subscription.updated", subId, tenantId, "past_due"));

    // canceled + same subId → update blocked.
    expect(await tenantStatus(tenantId)).toBe("canceled");
  });

  it("unknown tenantId in metadata → no tenant updated", async () => {
    const tenantId = await createTenant({ subscriptionStatus: "active" });
    const subId    = `sub_${uid()}`;

    await post(subscriptionEvent("customer.subscription.updated", subId, `unknown-${uid()}`, "past_due"));

    // Real tenant unchanged.
    expect(await tenantStatus(tenantId)).toBe("active");
  });

  it("subscriptionId persisted on the tenant row", async () => {
    const tenantId = await createTenant({ subscriptionStatus: "active" });
    const subId    = `sub_${uid()}`;

    await post(subscriptionEvent("customer.subscription.updated", subId, tenantId, "active"));

    const row = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, tenantId) });
    expect(row?.stripeSubscriptionId).toBe(subId);
  });

  it("past_due → canceled event → subscriptionStatus=canceled", async () => {
    const tenantId = await createTenant({ subscriptionStatus: "past_due" });
    const subId    = `sub_${uid()}`;

    await post(subscriptionEvent("customer.subscription.deleted", subId, tenantId, "canceled"));

    expect(await tenantStatus(tenantId)).toBe("canceled");
  });
});
