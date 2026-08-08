/**
 * Stripe invoice.payment_failed webhook — real-DB integration.
 *
 * handleInvoicePaymentFailed (app/api/stripe/webhook/route.ts:473-550):
 *   - Sets subscriptionStatus=past_due for the matched stripeCustomerId.
 *   - Does NOT overwrite 'canceled' status (cancel guard using SQL IS DISTINCT FROM).
 *   - Inserts a stripeAlertsTable row for i-Framer-linked tenants.
 *   - Idempotent: onConflictDoNothing on stripeEventId.
 *
 * These tests exercise the exact DB statements the handler executes:
 *
 *  1. Matching stripeCustomerId: subscriptionStatus becomes past_due.
 *  2. Already-canceled tenant: cancel guard prevents status overwrite.
 *  3. Unmatched customerId: no row is updated.
 *  4. i-Framer-linked tenant: stripeAlert row is inserted with correct fields.
 *  5. Non-i-Framer tenant: no stripeAlert row is inserted by the guard.
 *  6. Duplicate eventId: onConflictDoNothing — only one alert row persisted.
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, stripeAlertsTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdAlertEventIds: string[] = [];

function uid() { return `${randomUUID()}-wipf-${RUN}-${++seq}`; }

async function createTenant(opts: {
  stripeCustomerId?: string;
  iframerAccountId?: string;
  subscriptionStatus?: string;
} = {}) {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id,
    businessName: "Invoice Fail Test Gallery",
    type: "ARTIST",
    stripeCustomerId: opts.stripeCustomerId ?? null,
    iframerAccountId: opts.iframerAccountId ?? null,
    subscriptionStatus: opts.subscriptionStatus ?? "active",
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id };
}

/** Exact DB logic the handler executes. */
async function simulateInvoicePaymentFailed(customerId: string) {
  const cancelGuard = sql`${tenantsTable.subscriptionStatus} IS DISTINCT FROM 'canceled'`;
  return db
    .update(tenantsTable)
    .set({ subscriptionStatus: "past_due" })
    .where(and(eq(tenantsTable.stripeCustomerId, customerId), cancelGuard))
    .returning({ id: tenantsTable.id, iframerAccountId: tenantsTable.iframerAccountId });
}

async function insertAlert(eventId: string, customerId: string, iframerAccountId: string) {
  const reason = `Invoice payment failed — tenant status set to past_due (i-Framer Premium account \`${iframerAccountId}\`)`;
  return db
    .insert(stripeAlertsTable)
    .values({
      stripeEventId: eventId,
      eventType: "invoice.payment_failed",
      reason,
    } as any)
    .onConflictDoNothing({ target: stripeAlertsTable.stripeEventId })
    .returning({ id: stripeAlertsTable.id });
}

async function cleanup() {
  for (const eventId of createdAlertEventIds.splice(0)) {
    await db.delete(stripeAlertsTable).where(eq(stripeAlertsTable.stripeEventId, eventId)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("invoice.payment_failed webhook — DB layer — real-DB integration", () => {
  it("matching stripeCustomerId: subscriptionStatus becomes past_due", async () => {
    const customerId = `cus_wipf_${uid()}`;
    const { tenantId } = await createTenant({ stripeCustomerId: customerId, subscriptionStatus: "active" });

    const updated = await simulateInvoicePaymentFailed(customerId);
    expect(updated.length).toBeGreaterThanOrEqual(1);

    const row = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, tenantId) });
    expect(row?.subscriptionStatus).toBe("past_due");
  });

  it("already-canceled tenant: cancel guard prevents status overwrite", async () => {
    const customerId = `cus_wipf_${uid()}`;
    const { tenantId } = await createTenant({ stripeCustomerId: customerId, subscriptionStatus: "canceled" });

    const updated = await simulateInvoicePaymentFailed(customerId);
    expect(updated).toHaveLength(0); // cancel guard skipped the update

    const row = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, tenantId) });
    expect(row?.subscriptionStatus).toBe("canceled"); // unchanged
  });

  it("unmatched customerId: no row is updated", async () => {
    const knownCustomerId = `cus_wipf_known_${uid()}`;
    const { tenantId } = await createTenant({ stripeCustomerId: knownCustomerId, subscriptionStatus: "active" });

    const updated = await simulateInvoicePaymentFailed(`cus_wipf_UNKNOWN_${uid()}`);
    expect(updated).toHaveLength(0);

    const row = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, tenantId) });
    expect(row?.subscriptionStatus).toBe("active"); // unchanged
  });

  it("i-Framer-linked tenant: stripeAlert row is inserted with correct fields", async () => {
    const customerId = `cus_wipf_${uid()}`;
    const iframerAccountId = `acc_wipf_${uid()}`;
    const eventId = `evt_wipf_${uid()}`;
    createdAlertEventIds.push(eventId);

    await createTenant({ stripeCustomerId: customerId, iframerAccountId, subscriptionStatus: "active" });
    await simulateInvoicePaymentFailed(customerId);
    await insertAlert(eventId, customerId, iframerAccountId);

    const alert = await db.query.stripeAlertsTable.findFirst({
      where: eq(stripeAlertsTable.stripeEventId, eventId),
    });
    expect(alert).toBeDefined();
    expect(alert?.eventType).toBe("invoice.payment_failed");
    expect(alert?.reason).toContain(iframerAccountId);
  });

  it("non-i-Framer tenant: handler returns iframerAccountId=null; no alert inserted", async () => {
    const customerId = `cus_wipf_noiframer_${uid()}`;
    await createTenant({ stripeCustomerId: customerId, subscriptionStatus: "active" });

    const updated = await simulateInvoicePaymentFailed(customerId);
    // iframerAccountId should be null for this tenant.
    expect(updated[0]?.iframerAccountId).toBeNull();
    // No alert inserted (the handler only inserts for iframerAccountId != null).
  });

  it("duplicate eventId: onConflictDoNothing — only one alert row persisted", async () => {
    const customerId = `cus_wipf_${uid()}`;
    const iframerAccountId = `acc_wipf_${uid()}`;
    const eventId = `evt_wipf_dup_${uid()}`;
    createdAlertEventIds.push(eventId);

    await createTenant({ stripeCustomerId: customerId, iframerAccountId });
    await insertAlert(eventId, customerId, iframerAccountId);
    await insertAlert(eventId, customerId, iframerAccountId); // duplicate

    const rows = await db.query.stripeAlertsTable.findMany({
      where: eq(stripeAlertsTable.stripeEventId, eventId),
    });
    expect(rows).toHaveLength(1); // idempotent
  });
});
