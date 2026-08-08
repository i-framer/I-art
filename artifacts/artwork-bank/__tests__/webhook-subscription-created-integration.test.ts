/**
 * customer.subscription.created — ordinary new subscription — real-DB integration.
 *
 * app/api/stripe/webhook/route.ts:handleSubscriptionEvent handles
 * customer.subscription.created, .updated, and .deleted identically.
 *
 * These tests focus on the "new subscription created" path (status=active/trialing),
 * distinct from reactivation-after-cancel (covered in webhook-subscription-integration.test.ts).
 *
 *  1. New subscription sets subscriptionStatus = "active".
 *  2. New subscription sets stripeSubscriptionId on the tenant.
 *  3. New subscription sets stripeCustomerId on the tenant.
 *  4. subscription.created with status=trialing → subscriptionStatus = "trialing".
 *  5. New subscription sets trialEnd from trial_end timestamp.
 *  6. Unknown customerId (no tenant match) returns 200 without error.
 *  7. Two tenants with different customerIds are updated independently.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];

function uid() { return `${randomUUID()}-wsci-${RUN}-${++seq}`; }

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
  sendBillingAlertSlackNotification: vi.fn().mockResolvedValue({ ok: true }),
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

async function createTenant(stripeCustomerId?: string) {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Subscription Created Test", type: "ARTIST",
    billingExempt: false,
    ...(stripeCustomerId ? { stripeCustomerId } : {}),
  } as any);
  createdTenantIds.push(id);
  return id;
}

function subscriptionCreatedEvent(opts: {
  customerId: string;
  subscriptionId: string;
  status: string;
  trialEnd?: number | null;
  tenantId?: string;
}) {
  return {
    type: "customer.subscription.created",
    id: `evt_${uid()}`,
    data: {
      object: {
        id: opts.subscriptionId,
        object: "subscription",
        status: opts.status,
        customer: opts.customerId,
        trial_end: opts.trialEnd ?? null,
        metadata: opts.tenantId ? { billingTenantId: opts.tenantId } : {},
      },
    },
  };
}

async function tenantRow(tenantId: string) {
  return db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, tenantId) });
}

async function cleanup() {
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("customer.subscription.created — real-DB integration", () => {
  it("new subscription sets subscriptionStatus = 'active'", async () => {
    const customerId = `cus_${uid()}`;
    const tenantId = await createTenant(customerId);
    const subId = `sub_${uid()}`;

    const res = await post(subscriptionCreatedEvent({ customerId, subscriptionId: subId, status: "active" }));
    expect(res.status).toBe(200);

    const row = await tenantRow(tenantId);
    expect(row?.subscriptionStatus).toBe("active");
  });

  it("new subscription sets stripeSubscriptionId on the tenant", async () => {
    const customerId = `cus_${uid()}`;
    const tenantId = await createTenant(customerId);
    const subId = `sub_${uid()}`;

    await post(subscriptionCreatedEvent({ customerId, subscriptionId: subId, status: "active" }));

    const row = await tenantRow(tenantId);
    expect(row?.stripeSubscriptionId).toBe(subId);
  });

  it("new subscription sets stripeCustomerId on the tenant", async () => {
    const tenantId = await createTenant(); // no customerId yet
    const customerId = `cus_${uid()}`;
    const subId = `sub_${uid()}`;

    await post(subscriptionCreatedEvent({
      customerId, subscriptionId: subId, status: "active", tenantId,
    }));

    const row = await tenantRow(tenantId);
    expect(row?.stripeCustomerId).toBe(customerId);
  });

  it("subscription.created with status=trialing → subscriptionStatus = 'trialing'", async () => {
    const customerId = `cus_${uid()}`;
    const tenantId = await createTenant(customerId);
    const subId = `sub_${uid()}`;

    await post(subscriptionCreatedEvent({ customerId, subscriptionId: subId, status: "trialing" }));

    const row = await tenantRow(tenantId);
    expect(row?.subscriptionStatus).toBe("trialing");
  });

  it("new subscription sets trialEnd from trial_end timestamp", async () => {
    const customerId = `cus_${uid()}`;
    const tenantId = await createTenant(customerId);
    const subId = `sub_${uid()}`;
    const trialEndTs = Math.floor(Date.now() / 1000) + 14 * 86400; // 14 days from now

    await post(subscriptionCreatedEvent({ customerId, subscriptionId: subId, status: "trialing", trialEnd: trialEndTs }));

    const row = await tenantRow(tenantId);
    expect(row?.trialEnd).not.toBeNull();
    expect(row!.trialEnd!.getTime()).toBe(trialEndTs * 1000);
  });

  it("unknown customerId (no tenant match) returns 200 without error", async () => {
    const unknownCustomerId = `cus_unknown_${uid()}`;
    const subId = `sub_${uid()}`;

    const res = await post(subscriptionCreatedEvent({ customerId: unknownCustomerId, subscriptionId: subId, status: "active" }));
    expect(res.status).toBe(200);
  });

  it("two tenants with different customerIds are updated independently", async () => {
    const cust1 = `cus_${uid()}`;
    const cust2 = `cus_${uid()}`;
    const tenant1 = await createTenant(cust1);
    const tenant2 = await createTenant(cust2);
    const sub1 = `sub_${uid()}`;
    const sub2 = `sub_${uid()}`;

    await post(subscriptionCreatedEvent({ customerId: cust1, subscriptionId: sub1, status: "active" }));
    await post(subscriptionCreatedEvent({ customerId: cust2, subscriptionId: sub2, status: "trialing" }));

    const r1 = await tenantRow(tenant1);
    const r2 = await tenantRow(tenant2);
    expect(r1?.subscriptionStatus).toBe("active");
    expect(r1?.stripeSubscriptionId).toBe(sub1);
    expect(r2?.subscriptionStatus).toBe("trialing");
    expect(r2?.stripeSubscriptionId).toBe(sub2);
  });
});
