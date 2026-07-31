/**
 * Smoke-test script: Schema-push failure alert end-to-end verification.
 *
 * Simulates a production schema push failure by invoking
 * `notify-schema-push-failure.ts` directly with a synthetic SCHEMA_PUSH_ERROR,
 * then confirms:
 *   1. The notifier script exits 0 (it must never mask the caller's failure).
 *   2. The expected operator banner / Slack attempt is visible in its output.
 *
 * No real PROD_DATABASE_URL is required — the push failure is simulated by
 * running the notifier directly rather than through post-merge.sh.
 *
 * Prerequisites:
 *   - Run from the repo root or from the artwork-bank package directory.
 *   - Optional: SLACK_BILLING_ALERTS_CHANNEL set + Slack connector connected
 *     in Replit Integrations for a real end-to-end Slack delivery check.
 *
 * Usage:
 *   pnpm --filter @workspace/artwork-bank smoke:schema-push-alert
 *
 *   With a real Slack channel:
 *   SLACK_BILLING_ALERTS_CHANNEL=#ops-alerts \
 *     pnpm --filter @workspace/artwork-bank smoke:schema-push-alert
 *
 * After running:
 *   - Script output: confirms the notifier exited 0 and printed the expected banner.
 *   - Slack:         if SLACK_BILLING_ALERTS_CHANNEL is set, check that channel for
 *                    a message beginning with "🚨 *Production schema push FAILED*".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MANUAL RUNBOOK (for a real post-merge failure)
 * ─────────────────────────────────────────────────────────────────────────────
 * If the automated smoke test cannot run (e.g. isolated CI without Replit
 * connector access), follow these steps to verify the alert path manually:
 *
 * Step 1 — Trigger a simulated failure from the repo root:
 *   SCHEMA_PUSH_ERROR="Simulated push failure for drill" \
 *   SLACK_BILLING_ALERTS_CHANNEL=#ops-alerts \
 *     pnpm --filter @workspace/artwork-bank exec tsx scripts/notify-schema-push-failure.ts
 *
 * Step 2 — Confirm exit code is 0:
 *   echo $?
 *   Expected: 0 (the notifier must never propagate a non-zero exit)
 *
 * Step 3 — Verify Slack delivery:
 *   Open the channel named in SLACK_BILLING_ALERTS_CHANNEL.
 *   Look for a message beginning with:
 *     "🚨 *Production schema push FAILED* after a merge"
 *   It should appear within seconds.
 *
 * Step 4 — Verify stderr banner (when Slack is not configured):
 *   If SLACK_BILLING_ALERTS_CHANNEL is NOT set, the notifier prints a prominent
 *   banner to stderr.  Confirm the following lines appear in CI logs:
 *     "OPERATOR ACTION REQUIRED: Production schema push failed after merge."
 *     "The production database may be out of sync with the current schema."
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import * as url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const notifierPath = path.resolve(__dirname, "notify-schema-push-failure.ts");

const SYNTHETIC_ERROR =
  "ERROR: relation \"artworks\" already exists\n" +
  "detail: Simulated push failure injected by smoke-schema-push-alert.\n" +
  "hint:  This is a drill — no real database was modified.";

const slackChannel = process.env.SLACK_BILLING_ALERTS_CHANNEL?.trim();

console.log("=== Schema push failure alert smoke test ===\n");
console.log(
  "This script invokes notify-schema-push-failure.ts directly with a synthetic",
);
console.log("SCHEMA_PUSH_ERROR to confirm the end-to-end alert path.\n");
console.log(`Notifier: ${notifierPath}`);
console.log(
  `Slack channel: ${slackChannel ?? "(not set — banner-only mode)"}`,
);
console.log(`Synthetic error injected:\n  ${SYNTHETIC_ERROR.split("\n").join("\n  ")}\n`);

// ── Step 1: Run the notifier ──────────────────────────────────────────────────
console.log("Step 1: Invoking notify-schema-push-failure.ts…");

// Run via tsx; capture both stdout and stderr so we can inspect all output.
// The notifier writes primarily to stderr (console.error), so we must capture
// both streams — execFileSync only returns stdout.
const result = spawnSync(
  "npx",
  ["tsx", notifierPath],
  {
    env: {
      ...process.env,
      SCHEMA_PUSH_ERROR: SYNTHETIC_ERROR,
      // Preserve SLACK_BILLING_ALERTS_CHANNEL if already set in the environment.
    },
    encoding: "utf8",
  },
);

const notifierOutput = (result.stdout ?? "") + (result.stderr ?? "");
const notifierFailed = result.status !== 0 || result.error != null;

if (notifierFailed) {
  console.error(
    "FAIL  notify-schema-push-failure.ts exited non-zero.\n" +
      "      The notifier MUST always exit 0 so it does not mask the caller's\n" +
      "      push failure exit code.  Output:\n",
  );
  console.error(notifierOutput);
  process.exit(1);
}

console.log("OK    Notifier exited 0 (correct — does not mask caller failure).");

// ── Step 2: Confirm expected output ──────────────────────────────────────────
console.log("\nStep 2: Checking notifier output for expected content…");

const combined = notifierOutput;

const EXPECTED_FRAGMENTS = [
  "Production schema push failed",
  "attempting operator notification",
];

let allFound = true;
for (const fragment of EXPECTED_FRAGMENTS) {
  if (combined.includes(fragment)) {
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
      combined,
  );
  process.exit(1);
}

// ── Step 3: Slack delivery check ─────────────────────────────────────────────
console.log("\nStep 3: Slack delivery check…");

if (!slackChannel) {
  // No channel configured — the notifier falls back to a prominent stderr
  // banner.  Assert the key fallback lines actually appeared in the output so
  // a regression that silently drops the banner would fail this check too.
  const bannerPresent = combined.includes("OPERATOR ACTION REQUIRED");
  const contextPresent = combined.includes("Production schema push failed");

  if (bannerPresent && contextPresent) {
    console.log(
      "OK    SLACK_BILLING_ALERTS_CHANNEL is not set; notifier fell back to the\n" +
        '      stderr banner. "OPERATOR ACTION REQUIRED" and failure context found\n' +
        "      in output — the CI log will be visible to whoever reviews the run.",
    );
    console.log(
      "\n      To verify real end-to-end Slack delivery, re-run with the channel set:\n" +
        "        SLACK_BILLING_ALERTS_CHANNEL=#ops-alerts \\\n" +
        "          pnpm --filter @workspace/artwork-bank smoke:schema-push-alert",
    );
  } else {
    console.error(
      "FAIL  SLACK_BILLING_ALERTS_CHANNEL is not set but the required fallback\n" +
        "      banner was not found in the notifier output.\n" +
        `      Missing: ${!bannerPresent ? '"OPERATOR ACTION REQUIRED"' : ""} ${!contextPresent ? '"Production schema push failed"' : ""}`.trim() +
        "\n      The fallback notification path may be broken. Full output above.",
    );
    process.exit(1);
  }
} else {
  // A channel is configured — the notifier must confirm a successful Slack post.
  // A failed post with a configured channel means the alert did NOT reach the
  // operator, so this smoke test must fail.
  const slackErrorPatterns = ["Slack post failed", "Failed to post Slack message"];
  const slackErrors = slackErrorPatterns.filter((p) => combined.includes(p));
  const slackSent = combined.includes("Slack message sent to");

  if (slackSent) {
    console.log(
      `OK    Notifier confirmed Slack message sent to ${slackChannel}.\n` +
        `      Open ${slackChannel} in Slack and verify a message beginning with:\n` +
        '        "🚨 *Production schema push FAILED* after a merge"',
    );
  } else if (slackErrors.length > 0) {
    console.error(
      `FAIL  SLACK_BILLING_ALERTS_CHANNEL is set but the Slack post failed:\n` +
        slackErrors.map((e) => `        ${e}`).join("\n") +
        "\n\n" +
        "      The alert did NOT reach the operator channel — fix before shipping.\n" +
        "      Check that:\n" +
        "        • The Slack integration is connected in Replit Integrations.\n" +
        `        • The bot is a member of ${slackChannel}.\n` +
        "        • SLACK_BILLING_ALERTS_CHANNEL is a valid channel name or ID\n" +
        "          (use the channel ID C0123456789 if a bare #name is rejected).",
    );
    process.exit(1);
  } else {
    // Neither a confirmed send nor an error was detected — inconclusive.
    console.error(
      `FAIL  SLACK_BILLING_ALERTS_CHANNEL is set but no Slack confirmation\n` +
        `      ("Slack message sent to …") was found in the notifier output.\n` +
        "      The delivery status is unknown; treating as a failure.\n" +
        `      Check ${slackChannel} in Slack and review the full notifier output above.`,
    );
    process.exit(1);
  }
}

// ── Done ──────────────────────────────────────────────────────────────────────
console.log(
  "\n=== Smoke test passed ===\n" +
    "The notify-schema-push-failure.ts script ran, exited 0, and produced the\n" +
    "expected operator-notification output.  Full notifier output follows.\n",
);
console.log("── notifier output (stdout + stderr) ──────────────────────────────────────");
console.log(combined || "(empty)");
console.log("────────────────────────────────────────────────────────────────────────────");
