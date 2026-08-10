/**
 * Sends a daily "all-clear" heartbeat Slack message from the Stripe webhook
 * health probe, confirming that:
 *   (a) the scheduled workflow is still running, and
 *   (b) the webhook endpoint is not redirecting.
 *
 * Called by the `stripe-webhook-health` GitHub Actions workflow via:
 *   WEBHOOK_URL="https://i-art.com.au/api/stripe/webhook" \
 *   HTTP_CODE="405" \
 *   WORKFLOW_RUN_URL="https://github.com/owner/repo/actions/runs/$GITHUB_RUN_ID" \
 *     pnpm --filter @workspace/artwork-bank exec tsx scripts/notify-webhook-heartbeat.ts
 *
 * Dead-man's switch: if this daily message stops appearing in Slack, it means
 * the scheduled workflow has stopped firing (repo inactive, Actions disabled,
 * billing lapse, etc.).  See DEPLOY.md §5 for what to check.
 *
 * Notification channels (tried in order):
 *   1. Direct Slack API  (works in GitHub Actions with SLACK_BOT_TOKEN)
 *   2. Slack Incoming Webhook  (works in GitHub Actions with SLACK_WEBHOOK_URL)
 *   3. Prominent stdout banner  (always — visible in CI logs even without Slack)
 *
 * The script always exits 0 — a heartbeat send failure must not mark the
 * overall probe run as failed.
 */

const webhookUrl = process.env.WEBHOOK_URL ?? "https://i-art.com.au/api/stripe/webhook";
const httpCode = process.env.HTTP_CODE ?? "(unknown)";
const workflowRunUrl = process.env.WORKFLOW_RUN_URL ?? "";

const channel = process.env.SLACK_BILLING_ALERTS_CHANNEL?.trim().replace(/^#/, "");
const slackBotToken = process.env.SLACK_BOT_TOKEN?.trim();
const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL?.trim();

// Format today's UTC date for the message.
const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

const slackMessageText =
  `:white_check_mark: *Stripe webhook probe — daily heartbeat (${today} UTC)*\n` +
  `The scheduled health probe is running normally.\n\n` +
  `• Probed URL: \`${webhookUrl}\`\n` +
  `• HTTP status: \`${httpCode}\` — no redirect detected\n` +
  `• Stripe webhook deliveries should be succeeding\n\n` +
  `_If you stop seeing this daily message, the scheduled workflow has stopped firing._\n` +
  `_Check GitHub Actions → stripe-webhook-health and see DEPLOY.md §10 for recovery steps._` +
  (workflowRunUrl ? `\n\n<${workflowRunUrl}|View workflow run →>` : "");

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
      console.error(`[Webhook heartbeat] Direct Slack API post failed: ${errMsg}`);
      return { sent: false, error: errMsg };
    }

    console.log(`[Webhook heartbeat] Daily all-clear sent via Slack bot token to #${channel}.`);
    return { sent: true };
  } catch (err: any) {
    const errMsg = err?.message ?? String(err);
    console.error(`[Webhook heartbeat] Direct Slack API call failed: ${errMsg}`);
    return { sent: false, error: errMsg };
  }
}

async function sendViaSlackIncomingWebhook(): Promise<{ sent: boolean; error?: string }> {
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
      console.error(`[Webhook heartbeat] Slack webhook post failed: ${errMsg}`);
      return { sent: false, error: errMsg };
    }

    console.log(`[Webhook heartbeat] Daily all-clear sent via Slack incoming webhook.`);
    return { sent: true };
  } catch (err: any) {
    const errMsg = err?.message ?? String(err);
    console.error(`[Webhook heartbeat] Slack webhook call failed: ${errMsg}`);
    return { sent: false, error: errMsg };
  }
}

async function main() {
  console.log(
    "[stripe-webhook-health] Probe healthy — sending daily heartbeat confirmation…",
  );

  // Try direct Slack API with bot token.
  const botTokenResult = await sendViaSlackBotToken();
  if (botTokenResult.sent) {
    process.exit(0);
  }

  // Try Slack incoming webhook.
  const incomingWebhookResult = await sendViaSlackIncomingWebhook();
  if (incomingWebhookResult.sent) {
    process.exit(0);
  }

  // No Slack channel configured — log a prominent banner so CI logs are always
  // visible, and exit 0 so the overall probe run is not marked as failed.
  if (!channel && !slackWebhookUrl) {
    console.log(
      "[Webhook heartbeat] No Slack channel or webhook configured — heartbeat logged to CI only.\n" +
        "    Set SLACK_BILLING_ALERTS_CHANNEL + SLACK_BOT_TOKEN (or SLACK_WEBHOOK_URL)\n" +
        "    in GitHub Actions secrets to receive the daily all-clear in Slack.",
    );
  }

  // Always emit a banner — visible in GitHub Actions logs even without Slack.
  console.log(
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  );
  console.log(`✅  STRIPE WEBHOOK PROBE HEARTBEAT — ${today} UTC`);
  console.log(`    Probed URL:  ${webhookUrl}`);
  console.log(`    HTTP status: ${httpCode} — no redirect detected`);
  console.log(`    Webhook deliveries should be succeeding.`);
  console.log(
    "    (If this daily log entry stops appearing, the scheduled workflow has stopped.)",
  );
  console.log(
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  );

  process.exit(0);
}

main().catch((err) => {
  console.error("[Webhook heartbeat] Unexpected error in heartbeat notifier:", err);
  process.exit(0);
});

export {};
