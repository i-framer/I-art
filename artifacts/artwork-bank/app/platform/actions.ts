"use server";

import { revalidatePath } from "next/cache";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { db, tenantsTable, stripeAlertsTable } from "@workspace/db";
import { requirePlatformAdmin } from "@/lib/platform-admin";
import {
  resolveSlackChannel,
  sendBillingAlertSlackNotification,
} from "@/lib/slack";

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
 * Link or unlink an i-Framer Premium account ID for a tenant.
 *
 * Linking (non-empty accountId):
 *   - Sets iframerAccountId = accountId (trimmed)
 *   - Also sets billingExempt = true (i-Framer Premium implies exempt access)
 *
 * Unlinking (empty accountId):
 *   - Clears iframerAccountId = null
 *   - Does NOT change billingExempt — the tenant may still be comped for
 *     another reason; use setBillingExempt to manage that separately.
 *
 * Platform-owner only — tenant admins must never reach this.
 */
export async function setIframerAccount(formData: FormData): Promise<void> {
  await requirePlatformAdmin();

  const tenantId = formData.get("tenantId");
  const accountId = formData.get("accountId");

  if (typeof tenantId !== "string" || !tenantId) {
    throw new Error("Missing tenantId");
  }
  if (typeof accountId !== "string") {
    throw new Error("Missing accountId");
  }

  const trimmed = accountId.trim();

  const updateValues: Record<string, unknown> = trimmed
    ? { iframerAccountId: trimmed, billingExempt: true }
    : { iframerAccountId: null };

  const result = await db
    .update(tenantsTable)
    .set(updateValues)
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

/**
 * Replay all unresolved billing alerts whose Slack post previously failed.
 *
 * For each alert where slackPostFailed IS NOT NULL and dismissedAt IS NULL,
 * this re-attempts sendBillingAlertSlackNotification. On success the
 * slackPostFailed timestamp is cleared so the alert is no longer highlighted
 * in the billing panel.
 *
 * Platform-admin only.
 *
 * Returns counts so the caller can surface a summary to the operator.
 */
export async function replayFailedSlackAlerts(): Promise<{
  replayed: number;
  failed: number;
  skipped: number;
}> {
  await requirePlatformAdmin();

  const pending = await db
    .select()
    .from(stripeAlertsTable)
    .where(
      and(
        isNotNull(stripeAlertsTable.slackPostFailed),
        isNull(stripeAlertsTable.dismissedAt),
      ),
    );

  let replayed = 0;
  let failed = 0;
  let skipped = 0;

  for (const alert of pending) {
    // Check channel resolution before attempting a post so that alerts where
    // Slack is not configured are counted as skipped (not replayed), and their
    // slackPostFailed flag is preserved for when a channel is eventually set.
    const channel = resolveSlackChannel(alert.eventType);
    if (!channel) {
      skipped++;
      continue;
    }

    let result;
    try {
      result = await sendBillingAlertSlackNotification({
        stripeEventId: alert.stripeEventId,
        eventType: alert.eventType,
        customerId: alert.customerId,
        subscriptionId: alert.subscriptionId,
        reason: alert.reason,
      });
    } catch (err) {
      console.error(
        `[Slack replay] Unexpected error for alertId=${alert.id}:`,
        (err as any)?.message ?? String(err),
      );
      failed++;
      continue;
    }

    if (result.ok) {
      // Clear the failure flag so this alert is no longer highlighted.
      try {
        await db
          .update(stripeAlertsTable)
          .set({ slackPostFailed: null })
          .where(eq(stripeAlertsTable.id, alert.id));
      } catch (updateErr) {
        console.error(
          `[Slack replay] Failed to clear slackPostFailed for alertId=${alert.id}:`,
          (updateErr as any)?.message ?? String(updateErr),
        );
        // The message was delivered even if the DB flag wasn't cleared.
        // It will appear as a harmless duplicate on the next replay attempt.
      }
      replayed++;
    } else {
      failed++;
    }
  }

  revalidatePath("/platform");
  return { replayed, failed, skipped };
}
