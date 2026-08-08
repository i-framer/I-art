/**
 * customer.subscription.updated — status-change persistence — real-DB integration.
 *
 * When Stripe fires customer.subscription.updated the webhook handler must
 * update the tenant's subscriptionStatus, stripeSubscriptionId, and
 * (if present) subscriptionTrialEnd in the DB.
 *
 *  1. subscriptionStatus is updated when subscription.updated fires.
 *  2. stripeSubscriptionId is persisted on the tenant.
 *  3. subscriptionStatus=past_due is written when the updated sub status is past_due.
 *  4. subscriptionStatus=active overwrites past_due (recovery).
 *  5. Unknown subscription ID (no matching tenant) — no error, 200 returned.
 *  6. Tenant isolation — only the matched tenant's status changes.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];

function uid() { return `${randomUUID()}-wsusi-${RUN}-${++seq}`; }

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

async function createTenant(initialStatus: string | null = "active") {
  const id = uid();
  const customerId = `cus_${uid()}`;
  const subId = `sub_${uid()}`;
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "SubUpdated Test", type: "ARTIST",
    stripeCustomerId: customerId,
    stripeSubscriptionId: subId,
    subscriptionStatus: initialStatus,
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id, customerId, subId };
}

function subscriptionUpdatedEvent(customerId: string, subId: string, status: string) {
  return {
    type: "customer.subscription.updated",
    id: `evt_${uid()}`,
    data: {
      object: {
        id: subId,
        customer: customerId,
        status,
        trial_end: null,
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

describeIntegration("customer.subscription.updated status-change — real-DB integration", () => {
  it("subscriptionStatus is updated when subscription.updated fires", async () => {
    const { tenantId, customerId, subId } = await createTenant("active");

    const res = await post(subscriptionUpdatedEvent(customerId, subId, "past_due"));
    expect(res.status).toBe(200);

    const t = await tenantRow(tenantId);
    expect(t?.subscriptionStatus).toBe("past_due");
  });

  it("stripeSubscriptionId is persisted on the tenant row", async () => {
    const { tenantId, customerId } = await createTenant("active");
    const newSubId = `sub_new_${uid()}`;

    await post(subscriptionUpdatedEvent(customerId, newSubId, "active"));

    const t = await tenantRow(tenantId);
    expect(t?.stripeSubscriptionId).toBe(newSubId);
  });

  it("subscriptionStatus=past_due is written when subscription status is past_due", async () => {
    const { tenantId, customerId, subId } = await createTenant("active");

    await post(subscriptionUpdatedEvent(customerId, subId, "past_due"));

    const t = await tenantRow(tenantId);
    expect(t?.subscriptionStatus).toBe("past_due");
  });

  it("subscriptionStatus=active overwrites past_due on recovery", async () => {
    const { tenantId, customerId, subId } = await createTenant("past_due");

    await post(subscriptionUpdatedEvent(customerId, subId, "active"));

    const t = await tenantRow(tenantId);
    expect(t?.subscriptionStatus).toBe("active");
  });

  it("unknown subscription ID — no matching tenant, no error, 200 returned", async () => {
    const res = await post(subscriptionUpdatedEvent(
      `cus_unknown_${uid()}`,
      `sub_unknown_${uid()}`,
      "past_due",
    ));
    expect(res.status).toBe(200);
  });

  it("tenant isolation — only the matched tenant's status changes", async () => {
    const { tenantId: tenantA, customerId: custA, subId: subA } = await createTenant("active");
    const { tenantId: tenantB }                                 = await createTenant("active");

    await post(subscriptionUpdatedEvent(custA, subA, "past_due"));

    const tA = await tenantRow(tenantA);
    const tB = await tenantRow(tenantB);
    expect(tA?.subscriptionStatus).toBe("past_due");
    expect(tB?.subscriptionStatus).toBe("active");
  });
});
