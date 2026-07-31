/**
 * Sends an operator alert when the scheduled schema-drift check detects that
 * the production database has drifted from the TypeScript schema.
 *
 * Called by the scheduled GitHub Actions workflow (or any other scheduler) via:
 *   DRIFT_ERROR="<captured check-drift output>" \
 *     pnpm --filter @workspace/artwork-bank exec tsx scripts/notify-drift-failure.ts
 *
 * Notification channels (tried in order):
 *   1. Replit Connectors → Slack  (works when running inside a Replit workflow)
 *   2. Direct Slack API            (works in GitHub Actions with SLACK_BOT_TOKEN)
 *   3. Slack Incoming Webhook      (works in GitHub Actions with SLACK_WEBHOOK_URL)
 *   4. Email fallback              (SMTP or Resend + PLATFORM_ADMIN_EMAIL)
 *   5. Prominent stderr banner     (always — so CI logs are visible even without
 *                                   a configured notification channel)
 *
 * Slack channel: SLACK_BILLING_ALERTS_CHANNEL (reuses existing operator channel).
 *
 * The script always exits 0 — notification failures must not mask the original
 * drift failure that the caller reports.
 */

import { sendDriftFailureEmail } from "../lib/email";

const errorText = process.env.DRIFT_ERROR ?? "(no output captured)";
// Strip a leading '#' so operators can configure the channel as either
// "billing-alerts" or "#billing-alerts" — Slack's Web API only accepts the
// name without the '#' prefix (or a channel ID like C0123456789).
const channel = process.env.SLACK_BILLING_ALERTS_CHANNEL?.trim().replace(/^#/, "");
const slackBotToken = process.env.SLACK_BOT_TOKEN?.trim();
const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL?.trim();

// Truncate very long output so the Slack message stays readable.
const MAX_CHARS = 2800;
const truncated =
  errorText.length > MAX_CHARS
    ? errorText.slice(0, MAX_CHARS) + "\n… (truncated)"
    : errorText;

const slackMessageText =
  `:rotating_light: *Production schema drift detected* (scheduled check)\n` +
  `The production database schema no longer matches the TypeScript schema.\n` +
  `This likely means a manual change was applied directly to the database\n` +
  `(e.g. via Drizzle Studio or a hotfix) without a corresponding migration.\n\n` +
  `*Drift output:*\n\`\`\`\n${truncated}\n\`\`\`\n\n` +
  `To resolve:\n` +
  `• If the DB is *ahead* of the schema (orphaned columns/tables): add a migration that DROPs them, or restore them in the schema.\n` +
  `• If the schema is *ahead* of the DB (missing columns/tables): run \`DATABASE_URL="$PROD_DATABASE_URL" pnpm --filter @workspace/db run push-force\`.\n` +
  `Then redeploy.`;

async function sendViaReplitConnectors(): Promise<{ sent: boolean; error?: string }> {
  if (!channel) return { sent: false };

  try {
    // Dynamic import so this fails gracefully when the SDK is not installed
    // (e.g. in a GitHub Actions environment that has no Replit Connectors).
    const { ReplitConnectors } = await import("@replit/connectors-sdk");
    const connectors = new ReplitConnectors();
    const response = await connectors.proxy("slack", "/chat.postMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, text: slackMessageText }),
    });

    const body = await response.json().catch(() => null);
    if (!response.ok || (body && !body.ok)) {
      const errorDetail = body?.error ?? "(no error field)";
      const extraDetail = body?.response_metadata?.messages?.join("; ") ?? "";
      const errMsg = `HTTP ${response.status}: ${errorDetail}${extraDetail ? ` — ${extraDetail}` : ""}`;
      console.error(
        `[Drift alert] Replit Connectors Slack post failed (HTTP ${response.status}):`,
        errorDetail,
        extraDetail ? `— ${extraDetail}` : "",
      );
      return { sent: false, error: errMsg };
    }

    console.log(`[Drift alert] Slack message sent via Replit Connectors to ${channel}.`);
    return { sent: true };
  } catch (err: any) {
    const errMsg = err?.message ?? String(err);
    // Not an error worth surfacing as a real failure — this path is simply not
    // available outside the Replit environment.
    console.error(`[Drift alert] Replit Connectors unavailable: ${errMsg}`);
    return { sent: false, error: errMsg };
  }
}

async function sendViaSlackBotToken(): Promise<{ sent: boolean; error?: string }> {
  if (!channel || !slackBotToken) return { sent: false };

  try {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${slackBotToken}`,
      },
      body: JSON.stringify({ channel, text: slackMessageText }),
    });

    const body = await response.json().catch(() => null);
    if (!response.ok || (body && !body.ok)) {
      const errorDetail = body?.error ?? "(no error field)";
      const errMsg = `HTTP ${response.status}: ${errorDetail}`;
      console.error(`[Drift alert] Direct Slack API post failed: ${errMsg}`);
      return { sent: false, error: errMsg };
    }

    console.log(`[Drift alert] Slack message sent via bot token to ${channel}.`);
    return { sent: true };
  } catch (err: any) {
    const errMsg = err?.message ?? String(err);
    console.error(`[Drift alert] Direct Slack API call failed: ${errMsg}`);
    return { sent: false, error: errMsg };
  }
}

async function sendViaSlackWebhook(): Promise<{ sent: boolean; error?: string }> {
  if (!slackWebhookUrl) return { sent: false };

  try {
    const response = await fetch(slackWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: slackMessageText }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const errMsg = `HTTP ${response.status}: ${body}`;
      console.error(`[Drift alert] Slack webhook post failed: ${errMsg}`);
      return { sent: false, error: errMsg };
    }

    console.log(`[Drift alert] Slack message sent via incoming webhook.`);
    return { sent: true };
  } catch (err: any) {
    const errMsg = err?.message ?? String(err);
    console.error(`[Drift alert] Slack webhook call failed: ${errMsg}`);
    return { sent: false, error: errMsg };
  }
}

async function main() {
  console.error(
    "[scheduled-drift-check] Schema drift detected — attempting operator notification…",
  );

  // Try Replit Connectors first (native Replit context).
  const replitResult = await sendViaReplitConnectors();
  if (replitResult.sent) {
    process.exit(0);
  }

  // Try direct Slack API with bot token (GitHub Actions / non-Replit context).
  const botTokenResult = await sendViaSlackBotToken();
  if (botTokenResult.sent) {
    process.exit(0);
  }

  // Try Slack incoming webhook (simplest GitHub Actions integration).
  const webhookResult = await sendViaSlackWebhook();
  if (webhookResult.sent) {
    process.exit(0);
  }

  // Collect the last Slack error for the email subject.
  const slackFailure =
    replitResult.error ?? botTokenResult.error ?? webhookResult.error;

  if (!channel && !slackWebhookUrl) {
    console.error(
      "[Drift alert] No Slack channel or webhook configured — Slack alert skipped.\n" +
        "    Set SLACK_BILLING_ALERTS_CHANNEL + one of: SLACK_BOT_TOKEN, SLACK_WEBHOOK_URL,\n" +
        "    or use the Replit Connectors integration to enable automated alerts.",
    );
  }

  // Email fallback.
  const emailSent = await sendDriftFailureEmail({
    errorText,
    slackFailure,
  });

  if (emailSent) {
    console.error("[Drift alert] Fallback email sent to PLATFORM_ADMIN_EMAIL.");
    process.exit(0);
  }

  // Last resort — prominent stderr banner so CI logs are always visible.
  console.error(
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  );
  console.error(
    "OPERATOR ACTION REQUIRED: Production schema drift detected (scheduled check).",
  );
  console.error(
    "The production database schema no longer matches the TypeScript schema.",
  );
  console.error(
    "This likely means a manual change was applied directly to the database",
  );
  console.error(
    "(e.g. via Drizzle Studio or a hotfix) without a corresponding schema update.",
  );
  console.error("Drift output:");
  console.error(errorText);
  console.error(
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  );

  // Always exit 0 — the caller owns the non-zero exit for the drift itself.
  process.exit(0);
}

main().catch((err) => {
  console.error("[Drift alert] Unexpected error in notifier:", err);
  process.exit(0);
});
