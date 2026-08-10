/**
 * Sends an operator alert when the scheduled Stripe webhook health probe
 * detects that the webhook endpoint is redirecting (3xx).
 *
 * Called by the `stripe-webhook-health` GitHub Actions workflow via:
 *   WEBHOOK_URL="https://i-art.com.au/api/stripe/webhook" \
 *   HTTP_CODE="308" \
 *   REDIRECT_LOCATION="https://www.i-art.com.au/api/stripe/webhook" \
 *   WORKFLOW_RUN_URL="https://github.com/owner/repo/actions/runs/$GITHUB_RUN_ID" \
 *     pnpm --filter @workspace/artwork-bank exec tsx scripts/notify-webhook-redirect.ts
 *
 * Notification channels (tried in order):
 *   1. Replit Connectors → Slack  (works when running inside a Replit workflow)
 *   2. Direct Slack API            (works in GitHub Actions with SLACK_BOT_TOKEN)
 *   3. Slack Incoming Webhook      (works in GitHub Actions with SLACK_WEBHOOK_URL)
 *   4. Email fallback              (SMTP or Resend + PLATFORM_ADMIN_EMAIL)
 *   5. Prominent stderr banner     (always — so CI logs are visible without a channel)
 *
 * The script always exits 0 — notification failures must not mask the original
 * probe failure that the caller reports.
 */

import { sendWebhookRedirectEmail } from "../lib/email";

const webhookUrl = process.env.WEBHOOK_URL ?? "https://i-art.com.au/api/stripe/webhook";
const httpCode = process.env.HTTP_CODE ?? "(unknown)";
const redirectLocation = process.env.REDIRECT_LOCATION ?? "";
const workflowRunUrl = process.env.WORKFLOW_RUN_URL ?? "";

// Strip a leading '#' so operators can configure the channel as either
// "billing-alerts" or "#billing-alerts" — Slack's Web API only accepts the
// name without the '#' prefix (or a channel ID like C0123456789).
const channel = process.env.SLACK_BILLING_ALERTS_CHANNEL?.trim().replace(/^#/, "");
const slackBotToken = process.env.SLACK_BOT_TOKEN?.trim();
const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL?.trim();

const locationLine = redirectLocation ? `\n→ Redirects to: ${redirectLocation}` : "";

const slackMessageText =
  `:rotating_light: *Stripe webhook endpoint is redirecting (HTTP ${httpCode})* :rotating_light:\n` +
  `The scheduled health probe found that your Stripe webhook endpoint is returning a *${httpCode} redirect* instead of accepting the request directly.\n\n` +
  `*Probed URL:* \`${webhookUrl}\`${locationLine}\n\n` +
  `*Why this matters:* Stripe does not follow redirects. Every webhook delivery is counted as a failure — orders and subscription events are silently lost.\n\n` +
  `*Fix (DEPLOY.md §4, Option A):*\n` +
  `1. Vercel → Project → Settings → Domains → ⋮ next to \`i-art.com.au\` → *Set as primary*\n` +
  `2. Ensure \`NEXT_PUBLIC_SITE_URL=https://i-art.com.au\` (no www)\n` +
  `3. Re-register the Stripe webhook as \`https://i-art.com.au/api/stripe/webhook\`\n` +
  `4. Run \`bash scripts/check-webhook-redirect.sh\` and confirm ✅ No redirect\n` +
  `5. Send a test event from Stripe Dashboard and confirm 200 in the delivery log` +
  (workflowRunUrl ? `\n\n<${workflowRunUrl}|View failed workflow run →>` : "");

async function sendViaReplitConnectors(): Promise<{ sent: boolean; error?: string }> {
  if (!channel) return { sent: false };

  try {
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
        `[Webhook redirect alert] Replit Connectors Slack post failed (HTTP ${response.status}):`,
        errorDetail,
        extraDetail ? `— ${extraDetail}` : "",
      );
      return { sent: false, error: errMsg };
    }

    console.log(`[Webhook redirect alert] Slack message sent via Replit Connectors to ${channel}.`);
    return { sent: true };
  } catch (err: any) {
    const errMsg = err?.message ?? String(err);
    console.error(`[Webhook redirect alert] Replit Connectors unavailable: ${errMsg}`);
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
      console.error(`[Webhook redirect alert] Direct Slack API post failed: ${errMsg}`);
      return { sent: false, error: errMsg };
    }

    console.log(`[Webhook redirect alert] Slack message sent via bot token to ${channel}.`);
    return { sent: true };
  } catch (err: any) {
    const errMsg = err?.message ?? String(err);
    console.error(`[Webhook redirect alert] Direct Slack API call failed: ${errMsg}`);
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
      console.error(`[Webhook redirect alert] Slack webhook post failed: ${errMsg}`);
      return { sent: false, error: errMsg };
    }

    console.log(`[Webhook redirect alert] Slack message sent via incoming webhook.`);
    return { sent: true };
  } catch (err: any) {
    const errMsg = err?.message ?? String(err);
    console.error(`[Webhook redirect alert] Slack webhook call failed: ${errMsg}`);
    return { sent: false, error: errMsg };
  }
}

async function main() {
  console.error(
    "[stripe-webhook-health] Redirect detected — attempting operator notification…",
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
  const incomingWebhookResult = await sendViaSlackIncomingWebhook();
  if (incomingWebhookResult.sent) {
    process.exit(0);
  }

  // Collect the last Slack error for the email subject.
  const slackFailure =
    replitResult.error ?? botTokenResult.error ?? incomingWebhookResult.error;

  if (!channel && !slackWebhookUrl) {
    console.error(
      "[Webhook redirect alert] No Slack channel or webhook configured — Slack alert skipped.\n" +
        "    Set SLACK_BILLING_ALERTS_CHANNEL + one of: SLACK_BOT_TOKEN, SLACK_WEBHOOK_URL,\n" +
        "    or use the Replit Connectors integration to enable automated alerts.",
    );
  }

  // Email fallback.
  const emailSent = await sendWebhookRedirectEmail({
    webhookUrl,
    httpCode,
    location: redirectLocation || undefined,
    workflowRunUrl,
    slackFailure,
  });

  if (emailSent) {
    console.error("[Webhook redirect alert] Fallback email sent to PLATFORM_ADMIN_EMAIL.");
    process.exit(0);
  }

  // Last resort — prominent stderr banner so CI logs are always visible.
  console.error(
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  );
  console.error(
    "OPERATOR ACTION REQUIRED: Stripe webhook endpoint is redirecting!",
  );
  console.error(`  Probed URL:    ${webhookUrl}`);
  console.error(`  HTTP status:   ${httpCode}`);
  if (redirectLocation) {
    console.error(`  Redirects to:  ${redirectLocation}`);
  }
  console.error("");
  console.error("  Stripe does not follow redirects. All webhook deliveries are failing.");
  console.error("  Fix: set i-art.com.au as the primary domain in Vercel (DEPLOY.md §4).");
  console.error(
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  );

  // Always exit 0 — the caller owns the non-zero exit for the redirect failure.
  process.exit(0);
}

main().catch((err) => {
  console.error("[Webhook redirect alert] Unexpected error in notifier:", err);
  process.exit(0);
});
