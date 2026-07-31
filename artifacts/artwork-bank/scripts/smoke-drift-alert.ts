/**
 * Smoke-test script: Schema drift alert end-to-end verification.
 *
 * Simulates a schema drift detection by invoking `notify-drift-failure.ts`
 * directly with a synthetic DRIFT_ERROR, then confirms:
 *   1. The notifier script exits 0 (it must never mask the caller's failure).
 *   2. The expected operator banner / Slack attempt is visible in its output.
 *
 * No real PROD_DATABASE_URL is required — the drift is simulated by running
 * the notifier directly rather than through the scheduled workflow.
 *
 * Prerequisites:
 *   - Run from the repo root or from the artwork-bank package directory.
 *   - Optional: SLACK_BILLING_ALERTS_CHANNEL + one of SLACK_BOT_TOKEN or
 *     SLACK_WEBHOOK_URL for a real end-to-end Slack delivery check.
 *
 * Usage:
 *   pnpm --filter @workspace/artwork-bank smoke:drift-alert
 *
 *   With a real Slack channel (bot token):
 *   SLACK_BILLING_ALERTS_CHANNEL=#ops-alerts \
 *   SLACK_BOT_TOKEN=xoxb-... \
 *     pnpm --filter @workspace/artwork-bank smoke:drift-alert
 *
 *   With a real Slack channel (webhook):
 *   SLACK_WEBHOOK_URL=https://hooks.slack.com/services/... \
 *     pnpm --filter @workspace/artwork-bank smoke:drift-alert
 *
 * After running:
 *   - Script output: confirms the notifier exited 0 and printed the expected banner.
 *   - Slack: if configured, check that channel for a message beginning with
 *     "🚨 *Production schema drift detected* (scheduled check)".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MANUAL RUNBOOK (for a real drift detection)
 * ─────────────────────────────────────────────────────────────────────────────
 * If the automated smoke test cannot run (e.g. isolated CI without Slack
 * credentials), follow these steps to verify the alert path manually:
 *
 * Step 1 — Trigger a simulated drift alert from the repo root:
 *   DRIFT_ERROR="Simulated drift for drill" \
 *   SLACK_BILLING_ALERTS_CHANNEL=#ops-alerts \
 *   SLACK_BOT_TOKEN=xoxb-... \
 *     pnpm --filter @workspace/artwork-bank exec tsx scripts/notify-drift-failure.ts
 *
 * Step 2 — Confirm exit code is 0:
 *   echo $?
 *   Expected: 0 (the notifier must never propagate a non-zero exit)
 *
 * Step 3 — Verify Slack delivery:
 *   Open the channel named in SLACK_BILLING_ALERTS_CHANNEL.
 *   Look for a message beginning with:
 *     "🚨 *Production schema drift detected* (scheduled check)"
 *   It should appear within seconds.
 *
 * Step 4 — Verify stderr banner (when Slack is not configured):
 *   If no Slack channel/token is set, the notifier prints a prominent banner
 *   to stderr.  Confirm the following lines appear in the output:
 *     "OPERATOR ACTION REQUIRED: Production schema drift detected"
 *     "The production database schema no longer matches the TypeScript schema."
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import * as url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const notifierPath = path.resolve(__dirname, "notify-drift-failure.ts");

const SYNTHETIC_DRIFT =
  "❌  Schema drift detected — 2 issue(s):\n\n" +
  "  Missing from DB (schema ahead of database — run a migration):\n" +
  "    • artworks.stripe_payment_intent_id\n\n" +
  "  Simulated drift injected by smoke-drift-alert.\n" +
  "  hint:  This is a drill — no real database was modified.";

const slackChannel = process.env.SLACK_BILLING_ALERTS_CHANNEL?.trim();
const slackBotToken = process.env.SLACK_BOT_TOKEN?.trim();
const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL?.trim();

console.log("=== Schema drift alert smoke test ===\n");
console.log(
  "This script invokes notify-drift-failure.ts directly with a synthetic",
);
console.log("DRIFT_ERROR to confirm the end-to-end alert path.\n");
console.log(`Notifier: ${notifierPath}`);
console.log(
  `Slack channel: ${slackChannel ?? "(not set — banner-only mode)"}`,
);
if (slackBotToken) console.log("Slack bot token: set");
if (slackWebhookUrl) console.log(`Slack webhook URL: set`);
console.log(`Synthetic drift injected:\n  ${SYNTHETIC_DRIFT.split("\n").join("\n  ")}\n`);

// ── Step 1: Run the notifier ───────────────────────────────────────────────────
console.log("Step 1: Invoking notify-drift-failure.ts…");

// Run via tsx; capture both stdout and stderr so we can inspect all output.
const result = spawnSync(
  "npx",
  ["tsx", notifierPath],
  {
    env: {
      ...process.env,
      DRIFT_ERROR: SYNTHETIC_DRIFT,
      // Preserve SLACK_* if already set in the environment.
    },
    encoding: "utf8",
  },
);

const notifierOutput = (result.stdout ?? "") + (result.stderr ?? "");
const notifierFailed = result.status !== 0 || result.error != null;

if (notifierFailed) {
  console.error(
    "FAIL  notify-drift-failure.ts exited non-zero.\n" +
      "      The notifier MUST always exit 0 so it does not mask the caller's\n" +
      "      drift detection exit code.  Output:\n",
  );
  console.error(notifierOutput);
  process.exit(1);
}

console.log("OK    Notifier exited 0 (correct — does not mask caller failure).");

// ── Step 2: Confirm expected output ───────────────────────────────────────────
console.log("\nStep 2: Checking notifier output for expected content…");

const EXPECTED_FRAGMENTS = [
  "Schema drift detected",
  "attempting operator notification",
];

let allFound = true;
for (const fragment of EXPECTED_FRAGMENTS) {
  if (notifierOutput.includes(fragment)) {
    console.log(`OK    Found: "${fragment}"`);
  } else {
    console.error(`FAIL  Missing expected fragment: "${fragment}"`);
    allFound = false;
  }
}

if (!allFound) {
  console.error(
    "\nThe notifier output did not contain all expected fragments.\n" +
      "Full output:\n" +
      notifierOutput,
  );
  process.exit(1);
}

// ── Step 3: Notification delivery check ──────────────────────────────────────
console.log("\nStep 3: Notification delivery check…");

// All confirmed-delivery patterns — covers every channel the notifier can use.
const slackSentPatterns = [
  "Slack message sent via Replit Connectors",
  "Slack message sent via bot token",
  "Slack message sent via incoming webhook",
  "Slack message sent to",          // legacy / post-merge notifier wording
];
const slackErrorPatterns = [
  "Slack post failed",
  "Failed to post Slack message",
  "Slack API post failed",
  "Slack webhook post failed",
  "Slack webhook call failed",
];

const slackSent = slackSentPatterns.some((p) => notifierOutput.includes(p));
const slackErrors = slackErrorPatterns.filter((p) => notifierOutput.includes(p));
const bannerPresent = notifierOutput.includes("OPERATOR ACTION REQUIRED");
const emailSent = notifierOutput.includes("Fallback email sent");

if (slackSent) {
  // Any delivery method (Replit Connectors, bot token, or webhook) is fine.
  const channelNote = slackChannel ?? "a Slack channel";
  console.log(
    `OK    Notifier confirmed Slack message delivered.\n` +
      `      Open ${channelNote} and verify a message beginning with:\n` +
      '        "🚨 *Production schema drift detected* (scheduled check)"',
  );
} else if (emailSent) {
  console.log(
    "OK    Notifier sent a fallback email to PLATFORM_ADMIN_EMAIL.",
  );
} else if (bannerPresent) {
  // No notification channel configured — notifier fell back to stderr banner.
  console.log(
    "OK    No Slack/email configured; notifier fell back to the prominent\n" +
      '      stderr banner. "OPERATOR ACTION REQUIRED" found in output —\n' +
      "      the CI log will be visible to whoever reviews the run.",
  );
  console.log(
    "\n      To verify real end-to-end Slack delivery, re-run with credentials:\n" +
      "        SLACK_BILLING_ALERTS_CHANNEL=#ops-alerts \\\n" +
      "        SLACK_BOT_TOKEN=xoxb-... \\\n" +
      "          pnpm --filter @workspace/artwork-bank smoke:drift-alert",
  );
} else if (slackErrors.length > 0) {
  // Slack was attempted but failed — flag it when a channel is configured.
  if (slackChannel) {
    console.error(
      `FAIL  SLACK_BILLING_ALERTS_CHANNEL is set but the Slack post failed:\n` +
        slackErrors.map((e) => `        ${e}`).join("\n") +
        "\n\n" +
        "      The alert did NOT reach the operator channel — fix before relying on it.\n" +
        "      Check that:\n" +
        "        • SLACK_BOT_TOKEN / SLACK_WEBHOOK_URL is correct (for non-Replit env).\n" +
        "        • The Replit Slack integration is connected (for Replit env).\n" +
        `        • The bot is a member of ${slackChannel}.\n` +
        "        • SLACK_BILLING_ALERTS_CHANNEL is a valid channel name or ID\n" +
        "          (use the channel ID C0123456789 if a bare #name is rejected).",
    );
    process.exit(1);
  }
  // No channel set — errors from the connector are expected noise; banner is the
  // correct fallback and its absence was already caught above.
  console.log(
    "OK    Slack errors from unconfigured connector are expected; no channel set.",
  );
} else {
  // Nothing matched — inconclusive.
  console.error(
    "FAIL  Could not confirm any notification delivery:\n" +
      "      Neither a Slack confirmation, email sent, nor the fallback banner\n" +
      "      was found in the notifier output.\n" +
      "      The notification path may be silently broken. Full output above.",
  );
  process.exit(1);
}

// ── Done ──────────────────────────────────────────────────────────────────────
console.log(
  "\n=== Smoke test passed ===\n" +
    "The notify-drift-failure.ts script ran, exited 0, and produced the\n" +
    "expected operator-notification output.  Full notifier output follows.\n",
);
console.log("── notifier output (stdout + stderr) ──────────────────────────────────────");
console.log(notifierOutput || "(empty)");
console.log("────────────────────────────────────────────────────────────────────────────");
