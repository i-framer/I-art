/**
 * Tasks #80 and #88 — billing access on a real database.
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
