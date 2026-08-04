/**
 * Tasks #80, #88, and #366 — billing access on a real database.
 *
 *  #80 — Confirm unsubscribed galleries are blocked from admin actions on a
 *         real database.  requireActiveBillingAccess must throw "Subscription
 *         required" when the tenant's subscriptionStatus is null, "canceled",
 *         or "unpaid".
 *
 *  #88 — Confirm comped galleries skip the paywall end-to-end on a real
 *         database.  When billingExempt=true the function must return without
 *         throwing, regardless of subscriptionStatus.
 *
 *  #366 — Confirm a tenant with an expired trial is blocked from admin actions
 *          on a real database.  requireActiveBillingAccess must throw
 *          "Subscription required" when subscriptionStatus is
 *          'incomplete_expired' (trial lapsed without payment) or 'canceled'
 *          (trial canceled before converting to a paid subscription).
 *
 * These tests write real rows to the Postgres DB and clean up after themselves.
 * They are skipped automatically when DATABASE_URL is absent.
 */
import { afterAll, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireActiveBillingAccess } from "@/lib/billing";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal tenant row, generated fresh for each test session. */
function tenantId(suffix: string) {
  return `test-billing-${Date.now()}-${suffix}`;
}

const CREATED_IDS: string[] = [];

async function insertTenant(
  id: string,
  fields: { billingExempt?: boolean; subscriptionStatus?: string | null },
) {
  CREATED_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id, // unique per test; uses the full generated ID
    businessName: "Billing Test Gallery",
    type: "ARTIST",
    billingExempt: fields.billingExempt ?? false,
    subscriptionStatus: fields.subscriptionStatus ?? null,
  } as any);
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

afterAll(async () => {
  // Remove all test rows
  for (const id of CREATED_IDS) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id));
  }
});

// ── Task #80: unsubscribed galleries blocked ──────────────────────────────────

describeIntegration("requireActiveBillingAccess — Task #80 (unsubscribed blocked)", () => {
  it("throws 'Subscription required' when subscriptionStatus is null", async () => {
    const id = tenantId("null-status");
    await insertTenant(id, { subscriptionStatus: null });
    await expect(requireActiveBillingAccess(id)).rejects.toThrow(
      "Subscription required",
    );
  });

  it("throws when subscriptionStatus is 'canceled'", async () => {
    const id = tenantId("canceled");
    await insertTenant(id, { subscriptionStatus: "canceled" });
    await expect(requireActiveBillingAccess(id)).rejects.toThrow(
      "Subscription required",
    );
  });

  it("throws when subscriptionStatus is 'unpaid'", async () => {
    const id = tenantId("unpaid");
    await insertTenant(id, { subscriptionStatus: "unpaid" });
    await expect(requireActiveBillingAccess(id)).rejects.toThrow(
      "Subscription required",
    );
  });

  it("throws when subscriptionStatus is 'incomplete'", async () => {
    const id = tenantId("incomplete");
    await insertTenant(id, { subscriptionStatus: "incomplete" });
    await expect(requireActiveBillingAccess(id)).rejects.toThrow(
      "Subscription required",
    );
  });

  it("throws when the tenant does not exist (unknown ID)", async () => {
    await expect(
      requireActiveBillingAccess("nonexistent-tenant-id-12345"),
    ).rejects.toThrow("Subscription required");
  });

  it("does NOT throw when subscriptionStatus is 'active'", async () => {
    const id = tenantId("active");
    await insertTenant(id, { subscriptionStatus: "active" });
    await expect(requireActiveBillingAccess(id)).resolves.toBeUndefined();
  });

  it("does NOT throw when subscriptionStatus is 'trialing'", async () => {
    const id = tenantId("trialing");
    await insertTenant(id, { subscriptionStatus: "trialing" });
    await expect(requireActiveBillingAccess(id)).resolves.toBeUndefined();
  });

  it("does NOT throw when subscriptionStatus is 'past_due' (grace period)", async () => {
    const id = tenantId("past-due");
    await insertTenant(id, { subscriptionStatus: "past_due" });
    await expect(requireActiveBillingAccess(id)).resolves.toBeUndefined();
  });
});

// ── Task #88: comped galleries skip paywall ───────────────────────────────────

describeIntegration("requireActiveBillingAccess — Task #88 (comped galleries)", () => {
  it("does NOT throw when billingExempt=true with null subscriptionStatus", async () => {
    const id = tenantId("comped-null");
    await insertTenant(id, { billingExempt: true, subscriptionStatus: null });
    await expect(requireActiveBillingAccess(id)).resolves.toBeUndefined();
  });

  it("does NOT throw when billingExempt=true with canceled subscription", async () => {
    const id = tenantId("comped-canceled");
    await insertTenant(id, { billingExempt: true, subscriptionStatus: "canceled" });
    await expect(requireActiveBillingAccess(id)).resolves.toBeUndefined();
  });

  it("does NOT throw when billingExempt=true with unpaid subscription", async () => {
    const id = tenantId("comped-unpaid");
    await insertTenant(id, { billingExempt: true, subscriptionStatus: "unpaid" });
    await expect(requireActiveBillingAccess(id)).resolves.toBeUndefined();
  });

  it("does NOT throw when billingExempt=true regardless of any status", async () => {
    const statuses = ["active", "trialing", "past_due", "canceled", null];
    for (const status of statuses) {
      const id = tenantId(`comped-${status ?? "null"}`);
      await insertTenant(id, { billingExempt: true, subscriptionStatus: status });
      await expect(requireActiveBillingAccess(id)).resolves.toBeUndefined();
    }
  });
});

// ── Task #366: expired-trial tenants blocked ──────────────────────────────────

describeIntegration("requireActiveBillingAccess — Task #366 (expired trial blocked)", () => {
  it("throws 'Subscription required' when subscriptionStatus is 'incomplete_expired' (trial lapsed without payment)", async () => {
    // Stripe sends 'incomplete_expired' when a trial ends and no payment method
    // was ever added, or when the initial payment attempt fails and the
    // subscription is automatically voided.  The tenant must be locked out.
    const id = tenantId("incomplete-expired");
    await insertTenant(id, { subscriptionStatus: "incomplete_expired" });
    await expect(requireActiveBillingAccess(id)).rejects.toThrow(
      "Subscription required",
    );
  });

  it("throws 'Subscription required' when subscriptionStatus is 'canceled' following a trialing state", async () => {
    // Represents a tenant whose trial was explicitly canceled (e.g. via the
    // Stripe dashboard or a customer.subscription.deleted webhook) before they
    // converted to a paid subscription.  The DB row will carry 'canceled' as
    // the final status; the tenant must be denied access.
    const id = tenantId("trial-canceled");
    // Seed with 'canceled' — the prior trialing status is the scenario context;
    // the row the billing guard reads will already reflect the final state.
    await insertTenant(id, { subscriptionStatus: "canceled" });
    await expect(requireActiveBillingAccess(id)).rejects.toThrow(
      "Subscription required",
    );
  });

  it("does NOT throw when subscriptionStatus is 'trialing' (trial still active)", async () => {
    // Confirms the boundary: a tenant whose trial is still running must retain
    // full access; only post-expiry statuses are denied.
    const id = tenantId("trial-still-active");
    await insertTenant(id, { subscriptionStatus: "trialing" });
    await expect(requireActiveBillingAccess(id)).resolves.toBeUndefined();
  });

  it("does NOT throw for billingExempt=true even with incomplete_expired status", async () => {
    // A comped (billing-exempt) tenant must never be locked out, regardless of
    // whatever subscriptionStatus the row carries.
    const id = tenantId("comped-incomplete-expired");
    await insertTenant(id, {
      billingExempt: true,
      subscriptionStatus: "incomplete_expired",
    });
    await expect(requireActiveBillingAccess(id)).resolves.toBeUndefined();
  });
});

// ── Task #385: incomplete_expired tenant can resubscribe and regain access ────
//
// After a checkout.session.completed event for a new subscription ID flips
// the tenant's subscriptionStatus from 'incomplete_expired' to 'active', the
// billing guard must pass.  These tests exercise the billing-access layer in
// isolation: the DB row is updated directly (simulating what the webhook
// handler would do) so this file stays free of Stripe mock machinery.  The
// full end-to-end flow — posting the webhook event, reading back the updated
// row, and calling requireActiveBillingAccess — lives in
// webhook-subscription-integration.test.ts.

describeIntegration("requireActiveBillingAccess — Task #385 (incomplete_expired recovery)", () => {
  it("throws before recovery: incomplete_expired blocks admin access", async () => {
    // Baseline: the tenant is still locked out while status is incomplete_expired.
    const id = tenantId("ie-before-recovery");
    await insertTenant(id, { subscriptionStatus: "incomplete_expired" });
    await expect(requireActiveBillingAccess(id)).rejects.toThrow(
      "Subscription required",
    );
  });

  it("passes after recovery: status updated to 'active' (simulates webhook reactivation)", async () => {
    // Seed the tenant in the locked-out state.
    const id = tenantId("ie-after-recovery-active");
    await insertTenant(id, { subscriptionStatus: "incomplete_expired" });

    // Confirm the tenant is initially locked out.
    await expect(requireActiveBillingAccess(id)).rejects.toThrow(
      "Subscription required",
    );

    // Simulate the webhook handler writing the new subscription's status.
    await db
      .update(tenantsTable)
      .set({ subscriptionStatus: "active" })
      .where(eq(tenantsTable.id, id));

    // Billing guard must now pass — the tenant has regained access.
    await expect(requireActiveBillingAccess(id)).resolves.toBeUndefined();
  });

  it("passes after recovery: status updated to 'trialing' (simulates a trial re-subscription)", async () => {
    // A tenant whose initial trial expired without payment can start a new trial.
    // If Stripe sets the new subscription to 'trialing', the webhook handler
    // writes 'trialing' and the billing guard must grant access.
    const id = tenantId("ie-after-recovery-trialing");
    await insertTenant(id, { subscriptionStatus: "incomplete_expired" });

    // Confirm the tenant is initially locked out.
    await expect(requireActiveBillingAccess(id)).rejects.toThrow(
      "Subscription required",
    );

    // Simulate the webhook handler writing the new subscription's trialing status.
    await db
      .update(tenantsTable)
      .set({ subscriptionStatus: "trialing" })
      .where(eq(tenantsTable.id, id));

    // Billing guard must now pass.
    await expect(requireActiveBillingAccess(id)).resolves.toBeUndefined();
  });
});
