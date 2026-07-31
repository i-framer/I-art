/**
 * Sends a Slack alert when the production schema push fails during a post-merge run.
 *
 * Called by scripts/post-merge.sh via:
 *   SCHEMA_PUSH_ERROR="<captured output>" \
 *     pnpm --filter @workspace/artwork-bank exec tsx scripts/notify-schema-push-failure.ts
 *
 * Slack channel: SLACK_BILLING_ALERTS_CHANNEL (reuses existing operator channel).
 * Fallback: when Slack is absent or fails, sends an email to PLATFORM_ADMIN_EMAIL
 * via the configured transport (SMTP or Resend) matching the billing-alert pattern.
 * If neither channel is configured, the error is printed to stderr and the script
 * exits 0 so the caller can still propagate its own non-zero exit code.
 *
 * The script always exits 0 — notification failures must not mask the original
 * push failure that the caller reports.
 */

import { ReplitConnectors } from "@replit/connectors-sdk";
import { sendSchemaPushFailureEmail } from "../lib/email";

const errorText = process.env.SCHEMA_PUSH_ERROR ?? "(no output captured)";
// Strip a leading '#' so operators can configure the channel as either
// "billing-alerts" or "#billing-alerts" — Slack's Web API only accepts the
// name without the '#' prefix (or a channel ID like C0123456789).
const channel = process.env.SLACK_BILLING_ALERTS_CHANNEL?.trim().replace(/^#/, "");

async function sendSlackAlert(): Promise<{ sent: boolean; error?: string }> {
  if (!channel) {
    return { sent: false };
  }

  // Truncate very long output so the Slack message stays readable.
  const MAX_CHARS = 2800;
  const truncated =
    errorText.length > MAX_CHARS
      ? errorText.slice(0, MAX_CHARS) + "\n… (truncated)"
      : errorText;

  const text =
    `:rotating_light: *Production schema push FAILED* after a merge\n` +
    `The database may be out of sync with the current schema.\n\n` +
    `*Error output:*\n\`\`\`\n${truncated}\n\`\`\`\n\n` +
    `Check the post-merge CI logs for the full output and re-run ` +
    `\`DATABASE_URL="$PROD_DATABASE_URL" pnpm --filter @workspace/db run push-force\` ` +
    `once the underlying issue is resolved.`;

  try {
    const connectors = new ReplitConnectors();
    const response = await connectors.proxy("slack", "/chat.postMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, text }),
    });

    const body = await response.json().catch(() => null);
    if (!response.ok || (body && !body.ok)) {
      const errorDetail = body?.error ?? "(no error field)";
      const extraDetail =
        body?.response_metadata?.messages?.join("; ") ?? "";
      const errMsg = `HTTP ${response.status}: ${errorDetail}${extraDetail ? ` — ${extraDetail}` : ""}`;
      console.error(
        `[Schema push alert] Slack post failed (HTTP ${response.status}):`,
        errorDetail,
        extraDetail ? `— ${extraDetail}` : "",
      );
      return { sent: false, error: errMsg };
    }

    console.log(
      `[Schema push alert] Slack message sent to ${channel}.`,
    );
    return { sent: true };
  } catch (err: any) {
    const errMsg = err?.message ?? String(err);
    console.error(
      `[Schema push alert] Failed to post Slack message: ${errMsg}`,
    );
    return { sent: false, error: errMsg };
  }
}

async function main() {
  console.error(
    "[post-merge] Production schema push failed — attempting operator notification…",
  );

  const slackResult = await sendSlackAlert();

  if (!slackResult.sent) {
    // No Slack channel or Slack call failed: attempt email fallback.
    if (!channel) {
      console.error(
        "[Schema push alert] SLACK_BILLING_ALERTS_CHANNEL is not set — " +
          "Slack alert skipped. Configure the channel to receive automated alerts.",
      );
    }

    const emailSent = await sendSchemaPushFailureEmail({
      errorText,
      slackFailure: slackResult.error,
    });

    if (emailSent) {
      console.error(
        "[Schema push alert] Fallback email sent to PLATFORM_ADMIN_EMAIL.",
      );
    } else {
      // Neither Slack nor email worked — print a prominent stderr banner so
      // the failure is visible in CI logs even without a real notification channel.
      console.error(
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      );
      console.error(
        "OPERATOR ACTION REQUIRED: Production schema push failed after merge.",
      );
      console.error(
        "The production database may be out of sync with the current schema.",
      );
      console.error("Error output:");
      console.error(errorText);
      console.error(
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      );
    }
  }

  // Always exit 0 — the caller (post-merge.sh) owns the non-zero exit.
  process.exit(0);
}

main().catch((err) => {
  console.error("[Schema push alert] Unexpected error in notifier:", err);
  process.exit(0);
});
