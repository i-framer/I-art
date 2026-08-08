/**
 * account.updated webhook — edge cases — real-DB integration.
 *
 * app/api/stripe/webhook/route.ts:handleAccountUpdated:
 *   Sets stripeChargesEnabled = account.charges_enabled ?? false
 *   Sets stripePayoutsEnabled = account.payouts_enabled ?? false
 *   No-ops (200) when no tenant matches the stripeAccountId.
 *
 *  1. charges_enabled=null → stored as false (fallback).
 *  2. payouts_enabled=null → stored as false (fallback).
 *  3. Unknown stripeAccountId returns 200 without error.
 *  4. Duplicate/replayed event is idempotent — values unchanged.
 *  5. charges_enabled=true then false — update reflects the new state.
 *  6. Two tenants with different stripeAccountIds are updated independently.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];

function uid() { return `${randomUUID()}-wauec-${RUN}-${++seq}`; }

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

async function createTenant(stripeAccountId: string) {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Account Updated Edge Test",
    type: "ARTIST", billingExempt: true,
    stripeAccountId,
    stripeChargesEnabled: true,
    stripePayoutsEnabled: true,
  } as any);
  createdTenantIds.push(id);
  return id;
}

function accountUpdatedEvent(stripeAccountId: string, charges_enabled: boolean | null, payouts_enabled: boolean | null) {
  return {
    type: "account.updated",
    id: `evt_${uid()}`,
    data: {
      object: {
        id: stripeAccountId,
        object: "account",
        charges_enabled,
        payouts_enabled,
      },
    },
  };
}

async function tenantReadiness(tenantId: string) {
  const row = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, tenantId) });
  return { charges: row?.stripeChargesEnabled, payouts: row?.stripePayoutsEnabled };
}

async function cleanup() {
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("account.updated webhook edge cases — real-DB integration", () => {
  it("charges_enabled=null is stored as false (fallback)", async () => {
    const acctId = `acct_test_${uid()}`;
    const tenantId = await createTenant(acctId);

    const res = await post(accountUpdatedEvent(acctId, null, true));
    expect(res.status).toBe(200);

    const { charges } = await tenantReadiness(tenantId);
    expect(charges).toBe(false);
  });

  it("payouts_enabled=null is stored as false (fallback)", async () => {
    const acctId = `acct_test_${uid()}`;
    const tenantId = await createTenant(acctId);

    const res = await post(accountUpdatedEvent(acctId, true, null));
    expect(res.status).toBe(200);

    const { payouts } = await tenantReadiness(tenantId);
    expect(payouts).toBe(false);
  });

  it("unknown stripeAccountId returns 200 without error", async () => {
    const unknownAcctId = `acct_test_unknown_${uid()}`;

    const res = await post(accountUpdatedEvent(unknownAcctId, true, true));
    expect(res.status).toBe(200);
  });

  it("duplicate/replayed event is idempotent — values unchanged", async () => {
    const acctId = `acct_test_${uid()}`;
    const tenantId = await createTenant(acctId);

    await post(accountUpdatedEvent(acctId, true, true));
    await post(accountUpdatedEvent(acctId, true, true)); // replay

    const { charges, payouts } = await tenantReadiness(tenantId);
    expect(charges).toBe(true);
    expect(payouts).toBe(true);
  });

  it("charges_enabled=true then false — update reflects the new state", async () => {
    const acctId = `acct_test_${uid()}`;
    const tenantId = await createTenant(acctId);

    await post(accountUpdatedEvent(acctId, true, true));
    expect((await tenantReadiness(tenantId)).charges).toBe(true);

    await post(accountUpdatedEvent(acctId, false, true));
    expect((await tenantReadiness(tenantId)).charges).toBe(false);
  });

  it("two tenants with different stripeAccountIds are updated independently", async () => {
    const acctId1 = `acct_test_${uid()}`;
    const acctId2 = `acct_test_${uid()}`;
    const tenantId1 = await createTenant(acctId1);
    const tenantId2 = await createTenant(acctId2);

    await post(accountUpdatedEvent(acctId1, false, false));
    await post(accountUpdatedEvent(acctId2, true, true));

    const r1 = await tenantReadiness(tenantId1);
    const r2 = await tenantReadiness(tenantId2);
    expect(r1.charges).toBe(false);
    expect(r1.payouts).toBe(false);
    expect(r2.charges).toBe(true);
    expect(r2.payouts).toBe(true);
  });
});
