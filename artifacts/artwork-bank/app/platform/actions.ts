"use server";

import { revalidatePath } from "next/cache";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { db, tenantsTable, stripeAlertsTable } from "@workspace/db";
import { getSession } from "@/lib/auth";
import { requirePlatformAdmin } from "@/lib/platform-admin";
import {
  resolveSlackChannel,
  sendBillingAlertSlackNotification,
  sendIframerAccountSlackNotification,
} from "@/lib/slack";
import type { SlackNotificationResult } from "@/lib/slack";

/**
 * Toggle a tenant's billing_exempt flag (comp/uncomp an account).
 * Platform-owner only — tenant admins must never reach this.
 *
 * When billing_exempt is flipped to FALSE on a tenant that still has an
 * iframerAccountId set, a Slack audit alert is fired ("comp-removed").  This
 * closes the gap where an operator could silently remove the comp from an
 * i-Framer Premium tenant without any operator-visible notification:
 *   - setIframerAccount fires alerts on link/unlink.
 *   - setBillingExempt now fires an alert when it removes the comp while the
 *     i-Framer link is still present.
 *   - Setting billingExempt=true (restoring or adding a comp) does NOT send an
 *     alert; only the removal is noteworthy because it locks the tenant out.
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
    .returning({
      id: tenantsTable.id,
      slug: tenantsTable.slug,
      businessName: tenantsTable.businessName,
      iframerAccountId: tenantsTable.iframerAccountId,
    });

  if (result.length === 0) {
    throw new Error("Tenant not found");
  }

  revalidatePath("/platform");

  // Fire a Slack alert when an operator removes the comp from an i-Framer-linked
  // tenant.  Setting billingExempt=true is intentionally silent.
  if (exempt === "false" && result[0].iframerAccountId) {
    const session = await getSession();
    sendIframerAccountSlackNotification({
      action: "comp-removed",
      tenantName: result[0].businessName,
      tenantSlug: result[0].slug,
      accountId: result[0].iframerAccountId,
      adminEmail: session.email,
    }).catch((err) => {
      console.error(
        "[i-Framer comp-removed Slack] Unexpected error:",
        (err as any)?.message ?? String(err),
      );
    });
  }
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

  const session = await getSession();
  const adminEmail = session.email;

  const tenantId = formData.get("tenantId");
  const accountId = formData.get("accountId");

  if (typeof tenantId !== "string" || !tenantId) {
    throw new Error("Missing tenantId");
  }
  if (typeof accountId !== "string") {
    throw new Error("Missing accountId");
  }

  const trimmed = accountId.trim();
  const now = new Date();

  const updateValues: Record<string, unknown> = trimmed
    ? {
        iframerAccountId: trimmed,
        billingExempt: true,
        iframerAccountLinkedBy: adminEmail ?? null,
        iframerAccountLinkedAt: now,
      }
    : {
        iframerAccountId: null,
        iframerAccountLinkedBy: adminEmail ?? null,
        iframerAccountLinkedAt: now,
      };

  const result = await db
    .update(tenantsTable)
    .set(updateValues)
    .where(eq(tenantsTable.id, tenantId))
    .returning({
      id: tenantsTable.id,
      slug: tenantsTable.slug,
      businessName: tenantsTable.businessName,
    });

  if (result.length === 0) {
    throw new Error("Tenant not found");
  }

  const action = trimmed ? "linked" : "unlinked";
  const linkedAccountId = trimmed || null;

  // Attempt Slack audit notification — failures are recorded in the DB so the
  // operator can replay them from the platform panel; we never throw to caller.
  let slackResult: SlackNotificationResult;
  try {
    slackResult = await sendIframerAccountSlackNotification({
      action,
      tenantName: result[0].businessName,
      tenantSlug: result[0].slug,
      accountId: linkedAccountId,
      adminEmail,
    });
  } catch (err) {
    console.error(
      "[i-Framer account Slack] Unexpected error:",
      (err as any)?.message ?? String(err),
    );
    slackResult = { ok: false, error: (err as any)?.message ?? String(err) };
  }

  if (!slackResult.ok) {
    // Persist the failure so the platform panel can surface and replay it.
    const payload = JSON.stringify({ action, accountId: linkedAccountId, adminEmail });
    try {
      await db
        .update(tenantsTable)
        .set({
          iframerSlackPostFailed: new Date(),
          iframerSlackFailedPayload: payload,
        })
        .where(eq(tenantsTable.id, tenantId as string));
    } catch (dbErr) {
      console.error(
        "[i-Framer account Slack] Failed to persist Slack failure flag:",
        (dbErr as any)?.message ?? String(dbErr),
      );
    }
  } else {
    // Clear any stale failure flag from a previous attempt.
    try {
      await db
        .update(tenantsTable)
        .set({ iframerSlackPostFailed: null, iframerSlackFailedPayload: null })
        .where(eq(tenantsTable.id, tenantId as string));
    } catch (dbErr) {
      console.error(
        "[i-Framer account Slack] Failed to clear stale Slack failure flag:",
        (dbErr as any)?.message ?? String(dbErr),
      );
    }
  }

  revalidatePath("/platform");
}

/**
 * Replay all i-Framer audit notifications whose Slack post previously failed.
 *
 * For each tenant where iframerSlackPostFailed IS NOT NULL, this re-attempts
 * sendIframerAccountSlackNotification using the payload stored alongside the
 * failure flag. On success the flag and payload are cleared so the tenant is
 * no longer highlighted in the platform panel.
 *
 * Platform-admin only.
 *
 * Returns counts so the caller can surface a summary to the operator.
 */
export async function replayFailedIframerSlackAlerts(): Promise<{
  replayed: number;
  failed: number;
  skipped: number;
}> {
  await requirePlatformAdmin();

  const pending = await db
    .select()
    .from(tenantsTable)
    .where(isNotNull(tenantsTable.iframerSlackPostFailed));

  let replayed = 0;
  let failed = 0;
  let skipped = 0;

  for (const tenant of pending) {
    if (!tenant.iframerSlackFailedPayload) {
      // No payload to reconstruct — skip and leave flag in place.
      skipped++;
      continue;
    }

    // Check channel before attempting so that tenants where Slack is not yet
    // configured are counted as skipped rather than failed.
    const channel = process.env.SLACK_BILLING_ALERTS_CHANNEL?.trim();
    if (!channel) {
      skipped++;
      continue;
    }

    let parsed: {
      action: "linked" | "unlinked";
      accountId: string | null;
      adminEmail: string | undefined;
    };
    try {
      parsed = JSON.parse(tenant.iframerSlackFailedPayload);
    } catch {
      console.error(
        `[i-Framer Slack replay] Could not parse payload for tenantId=${tenant.id}`,
      );
      failed++;
      continue;
    }

    let result: SlackNotificationResult;
    try {
      result = await sendIframerAccountSlackNotification({
        action: parsed.action,
        tenantName: tenant.businessName,
        tenantSlug: tenant.slug,
        accountId: parsed.accountId,
        adminEmail: parsed.adminEmail,
      });
    } catch (err) {
      console.error(
        `[i-Framer Slack replay] Unexpected error for tenantId=${tenant.id}:`,
        (err as any)?.message ?? String(err),
      );
      // Intentionally do NOT refresh iframerSlackPostFailed here.
      // An exception means the Slack SDK threw before we received any
      // response (network timeout, DNS failure, etc.).  We cannot tell
      // whether Slack actually processed a partial request, so the
      // existing timestamp is the most accurate signal available to
      // operators — updating it would imply a clean retry attempt when
      // in reality the outcome is unknown.  The ok:false path (below)
      // refreshes the timestamp because it represents a confirmed
      // response from Slack, not an ambiguous transport failure.
      failed++;
      continue;
    }

    if (result.ok) {
      try {
        await db
          .update(tenantsTable)
          .set({ iframerSlackPostFailed: null, iframerSlackFailedPayload: null })
          .where(eq(tenantsTable.id, tenant.id));
      } catch (updateErr) {
        console.error(
          `[i-Framer Slack replay] Failed to clear flag for tenantId=${tenant.id}:`,
          (updateErr as any)?.message ?? String(updateErr),
        );
        // Message was delivered even if the flag wasn't cleared — harmless
        // duplicate on next replay attempt.
      }
      replayed++;
    } else {
      // Refresh the failure timestamp so operators can see when the most recent
      // retry attempt occurred, distinguishing a newly-broken alert from one
      // that has been stuck for days.
      try {
        await db
          .update(tenantsTable)
          .set({ iframerSlackPostFailed: new Date() })
          .where(eq(tenantsTable.id, tenant.id));
      } catch (updateErr) {
        console.error(
          `[i-Framer Slack replay] Failed to refresh iframerSlackPostFailed for tenantId=${tenant.id}:`,
          (updateErr as any)?.message ?? String(updateErr),
        );
      }
      failed++;
    }
  }

  revalidatePath("/platform");
  return { replayed, failed, skipped };
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
      // Intentionally do NOT refresh slackPostFailed here.
      // An exception means the Slack SDK threw before we received any
      // response (network timeout, DNS failure, etc.).  We cannot tell
      // whether Slack actually processed a partial request, so the
      // existing timestamp is the most accurate signal available to
      // operators — updating it would imply a clean retry attempt when
      // in reality the outcome is unknown.  The ok:false path (below)
      // refreshes the timestamp because it represents a confirmed
      // response from Slack, not an ambiguous transport failure.
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
      // Refresh the failure timestamp so operators can see when the most recent
      // retry attempt occurred, distinguishing a newly-broken alert from one
      // that has been stuck for days.
      try {
        await db
          .update(stripeAlertsTable)
          .set({ slackPostFailed: new Date() })
          .where(eq(stripeAlertsTable.id, alert.id));
      } catch (updateErr) {
        console.error(
          `[Slack replay] Failed to refresh slackPostFailed for alertId=${alert.id}:`,
          (updateErr as any)?.message ?? String(updateErr),
        );
      }
      failed++;
    }
  }

  revalidatePath("/platform");
  return { replayed, failed, skipped };
}
