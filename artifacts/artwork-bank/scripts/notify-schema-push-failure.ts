/**
 * Sends a Slack alert when the production schema push fails during a post-merge run.
 *
 * Called by scripts/post-merge.sh via:
 *   SCHEMA_PUSH_ERROR="<captured output>" \
 *     pnpm --filter @workspace/artwork-bank exec tsx scripts/notify-schema-push-failure.ts
 *
 * Slack channel: SLACK_BILLING_ALERTS_CHANNEL (reuses existing operator channel).
 * If neither a Slack channel nor PLATFORM_ADMIN_EMAIL is configured, the error is
 * printed to stderr and the script exits 0 so the caller can still propagate its
 * own non-zero exit code.
 *
 * The script always exits 0 — notification failures must not mask the original
 * push failure that the caller reports.
 */

import { ReplitConnectors } from "@replit/connectors-sdk";

const errorText = process.env.SCHEMA_PUSH_ERROR ?? "(no output captured)";
const channel = process.env.SLACK_BILLING_ALERTS_CHANNEL?.trim();

async function sendSlackAlert(): Promise<boolean> {
  if (!channel) {
    return false;
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
      body: JSON.stringify({ channel, text }),
    });

    const body = await response.json().catch(() => null);
    if (!response.ok || (body && !body.ok)) {
      console.error(
        `[Schema push alert] Slack post failed (HTTP ${response.status}):`,
        body?.error ?? "(no error field)",
      );
      return false;
    }

    console.log(
      `[Schema push alert] Slack message sent to ${channel}.`,
    );
    return true;
  } catch (err: any) {
    console.error(
      `[Schema push alert] Failed to post Slack message: ${err?.message ?? String(err)}`,
    );
    return false;
  }
}

async function main() {
  console.error(
    "[post-merge] Production schema push failed — attempting operator notification…",
  );

  const slackSent = await sendSlackAlert();

  if (!slackSent) {
    // No Slack channel or Slack call failed: print a prominent stderr banner so
    // the failure is visible in CI logs even without a real notification channel.
    if (!channel) {
      console.error(
        "[Schema push alert] SLACK_BILLING_ALERTS_CHANNEL is not set — " +
          "Slack alert skipped. Configure the channel to receive automated alerts.",
      );
    }
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

  // Always exit 0 — the caller (post-merge.sh) owns the non-zero exit.
  process.exit(0);
}

main().catch((err) => {
  console.error("[Schema push alert] Unexpected error in notifier:", err);
  process.exit(0);
});
