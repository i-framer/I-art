"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db, tenantsTable, stripeAlertsTable } from "@workspace/db";
import { requirePlatformAdmin } from "@/lib/platform-admin";

/**
 * Toggle a tenant's billing_exempt flag (comp/uncomp an account).
 * Platform-owner only — tenant admins must never reach this.
 */
export async function setBillingExempt(formData: FormData): Promise<void> {
  await requirePlatformAdmin();

  const tenantId = formData.get("tenantId");
  const exempt = formData.get("exempt");
  if (typeof tenantId !== "string" || !tenantId) {
    throw new Error("Missing tenantId");
  }
  if (exempt !== "true" && exempt !== "false") {
    throw new Error("Missing exempt value");
  }

  const result = await db
    .update(tenantsTable)
    .set({ billingExempt: exempt === "true" })
    .where(eq(tenantsTable.id, tenantId))
    .returning({ id: tenantsTable.id });

  if (result.length === 0) {
    throw new Error("Tenant not found");
  }

  revalidatePath("/platform");
}

/**
 * Dismiss a billing alert once the operator has investigated and resolved it.
 * Platform-admin only — no tenant user may clear global alerts.
 */
export async function dismissBillingAlert(alertId: string): Promise<void> {
  await requirePlatformAdmin();

  if (!alertId || typeof alertId !== "string") {
    throw new Error("Missing alertId");
  }

  const result = await db
    .update(stripeAlertsTable)
    .set({ dismissedAt: new Date() })
    .where(eq(stripeAlertsTable.id, alertId))
    .returning({ id: stripeAlertsTable.id });

  if (result.length === 0) {
    // Already dismissed or never existed — not an error, just a no-op.
    // Stripe retries and race-clicks should not surface errors to the admin.
  }

  revalidatePath("/platform");
}
