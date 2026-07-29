/**
 * POST /api/slack-replay
 *
 * Re-posts all unresolved billing alerts whose Slack notification previously
 * failed (slackPostFailed IS NOT NULL, dismissedAt IS NULL).
 *
 * Designed to be triggered by an external cron service or by an operator
 * after a Slack outage is resolved. When SLACK_REPLAY_SECRET (or the general
 * CRON_SECRET) is set, requests must carry it as a Bearer token; otherwise
 * the endpoint is open (dev/test convenience).
 *
 * Returns JSON: { replayed, failed, skipped }
 */
import { NextResponse } from "next/server";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { db, stripeAlertsTable } from "@workspace/db";
import {
  resolveSlackChannel,
  sendBillingAlertSlackNotification,
} from "@/lib/slack";

export const dynamic = "force-dynamic";

function isAuthorized(request: Request): boolean {
  const secrets = [
    process.env.SLACK_REPLAY_SECRET,
    process.env.CRON_SECRET,
  ].filter(Boolean);
  if (secrets.length === 0) return true; // no secret configured — open (dev)
  const auth = request.headers.get("authorization");
  return secrets.some((s) => auth === `Bearer ${s}`);
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await replayFailedSlackAlerts();
    return NextResponse.json(result);
  } catch (err: any) {
    console.error("[slack-replay] Sweep failed:", err?.message ?? err);
    return NextResponse.json({ error: "Replay failed" }, { status: 500 });
  }
}

/** GET is used by Vercel cron (crons can only issue GET requests). */
export async function GET(request: Request) {
  return POST(request);
}

async function replayFailedSlackAlerts(): Promise<{
  replayed: number;
  failed: number;
  skipped: number;
}> {
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
      }
      replayed++;
    } else {
      failed++;
    }
  }

  return { replayed, failed, skipped };
}
