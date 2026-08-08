/**
 * Subscription trial expiry (trialing → active) — real-DB integration.
 *
 * When a `customer.subscription.updated` event arrives after a trial ends,
 * the DB should transition subscriptionStatus from "trialing" to "active".
 * The existing webhook-subscription-integration.test.ts covers checkout/cancel
 * paths but not the post-trial updated transition.
 *
 *  1. trialing tenant transitions to active on subscription.updated.
 *  2. past_due tenant transitions to active on subscription.updated.
 *  3. active tenant stays active (no regression).
 *  4. Non-matching customerId is a no-op — own tenant unchanged.
 *  5. stripeCustomerId persists unchanged after status update.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];

function uid() { return `${randomUUID()}-wstei-${RUN}-${++seq}`; }

vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(),
  getStripeWebhookSecret: vi.fn().mockResolvedValue(null), // dev-bypass mode
  calcApplicationFee: (cents: number) => Math.round(cents * 0.05),
  StripeNotConfiguredError: class extends Error {},
}));
vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: vi.fn(),
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

async function createTenant(opts: {
  subscriptionStatus?: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
} = {}) {
  const id = uid();
  const customerId   = opts.stripeCustomerId    ?? `cus_${uid()}`;
  const subscriptionId = opts.stripeSubscriptionId ?? `sub_${uid()}`;
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Trial Expiry Test Gallery", type: "ARTIST",
    subscriptionStatus: opts.subscriptionStatus ?? "trialing",
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId,
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id, customerId, subscriptionId };
}

async function tenantStatus(tenantId: string) {
  const row = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, tenantId) });
  return row?.subscriptionStatus ?? null;
}

async function cleanup() {
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

/** Minimal customer.subscription.updated payload. */
function subscriptionUpdatedEvent(customerId: string, subscriptionId: string, status: string) {
  return {
    type: "customer.subscription.updated",
    id: `evt_${uid()}`,
    data: {
      object: {
        id: subscriptionId,
        customer: customerId,
        status,
        current_period_end: Math.floor(Date.now() / 1000) + 86400,
        trial_end: null,
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Subscription trial expiry (trialing → active) — real-DB integration", () => {
  it("trialing tenant transitions to active on subscription.updated", async () => {
    const { tenantId, customerId, subscriptionId } =
      await createTenant({ subscriptionStatus: "trialing" });

    const res = await post(subscriptionUpdatedEvent(customerId, subscriptionId, "active"));
    expect(res.status).toBe(200);

    expect(await tenantStatus(tenantId)).toBe("active");
  });

  it("past_due tenant transitions to active on subscription.updated", async () => {
    const { tenantId, customerId, subscriptionId } =
      await createTenant({ subscriptionStatus: "past_due" });

    const res = await post(subscriptionUpdatedEvent(customerId, subscriptionId, "active"));
    expect(res.status).toBe(200);

    expect(await tenantStatus(tenantId)).toBe("active");
  });

  it("active tenant stays active (no regression)", async () => {
    const { tenantId, customerId, subscriptionId } =
      await createTenant({ subscriptionStatus: "active" });

    const res = await post(subscriptionUpdatedEvent(customerId, subscriptionId, "active"));
    expect(res.status).toBe(200);

    expect(await tenantStatus(tenantId)).toBe("active");
  });

  it("non-matching customerId is a no-op — own tenant status unchanged", async () => {
    const { tenantId } = await createTenant({ subscriptionStatus: "trialing" });

    await post(subscriptionUpdatedEvent(`cus_unknown_${uid()}`, `sub_unknown_${uid()}`, "active"));

    expect(await tenantStatus(tenantId)).toBe("trialing"); // unchanged
  });

  it("stripeCustomerId persists unchanged after status update", async () => {
    const { tenantId, customerId, subscriptionId } =
      await createTenant({ subscriptionStatus: "trialing" });

    await post(subscriptionUpdatedEvent(customerId, subscriptionId, "active"));

    const row = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, tenantId) });
    expect(row?.stripeCustomerId).toBe(customerId);
  });
});
