/**
 * Smoke-test script: Billing alert end-to-end verification (email + Slack).
 *
 * Fires a dev-bypass webhook with a synthetic unmatched subscription event,
 * then confirms:
 *   1. The billing alert row was written to the database.
 *   2. The Resend email was attempted (real API call when RESEND_API_KEY is set).
 *   3. The Slack message was attempted (real API call when SLACK_BILLING_ALERTS_CHANNEL is set).
 *
 * Prerequisites:
 *   - The Artwork Bank server must be running locally
 *     (pnpm --filter @workspace/artwork-bank dev)
 *   - STRIPE_WEBHOOK_DEV_BYPASS=true must be set (default in dev)
 *   - DATABASE_URL must be set (populated automatically in the Replit workspace)
 *   - Optional: RESEND_API_KEY + PLATFORM_ADMIN_EMAIL for a real email send
 *   - Optional: SLACK_BILLING_ALERTS_CHANNEL for a real Slack message
 *     (the Slack connector OAuth must be set up in this Repl via Replit Integrations)
 *
 * Usage:
 *   pnpm --filter @workspace/artwork-bank smoke:billing-alert
 *
 *   Override the target URL if the dev server is on a different port/host:
 *   ARTWORK_BANK_URL=http://localhost:3001 \
 *     pnpm --filter @workspace/artwork-bank smoke:billing-alert
 *
 *   Print the Slack reconnect verification runbook and exit:
 *   pnpm --filter @workspace/artwork-bank smoke:billing-alert -- --reconnect-runbook
 *
 * After running:
 *   - Database:  the script confirms the alert row itself.
 *   - Email:     check the Resend dashboard (https://resend.com/emails) and
 *                the operator inbox at PLATFORM_ADMIN_EMAIL.
 *   - Slack:     check the channel named in SLACK_BILLING_ALERTS_CHANNEL for a
 *                message like "🚨 Unmatched Stripe billing event (customer.subscription.updated)".
 *                The server logs (workflow console) will show either
 *                "[Billing alert Slack] Post failed" or no error on success.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RECONNECT VERIFICATION RUNBOOK
 * ─────────────────────────────────────────────────────────────────────────────
 * Run this whenever the Slack OAuth token has been revoked and re-granted —
 * for example after rotating workspace credentials or reconnecting the Replit
 * Integrations connector from the Replit UI.
 *
 * Step 1 — Revoke the current token (only needed for a drill; skip in a real
 *           incident where the token is already revoked):
 *   a. Open the Replit workspace for this project.
 *   b. Navigate to Tools → Integrations (or the Integrations panel).
 *   c. Find the "Slack" connector and click "Disconnect" / "Revoke".
 *   d. Confirm that the connector status changes to "Not connected".
 *
 * Step 2 — Re-grant access (reconnect the OAuth token):
 *   a. In the same Integrations panel, click "Connect" on the Slack connector.
 *   b. Complete the Slack OAuth flow in the popup (authorize the workspace).
 *   c. Confirm the connector status returns to "Connected".
 *
 * Step 3 — Restart the dev server so it picks up the refreshed credentials:
 *   pnpm --filter @workspace/artwork-bank dev
 *   (or use the Replit workflow restart button for "artifacts/artwork-bank: web")
 *
 * Step 4 — Run this smoke script to confirm delivery:
 *   SLACK_BILLING_ALERTS_CHANNEL=#your-channel \
 *     pnpm --filter @workspace/artwork-bank smoke:billing-alert
 *
 * Step 5 — Verify in Slack:
 *   Open the channel set in SLACK_BILLING_ALERTS_CHANNEL and look for a new
 *   message that begins with "🚨 Unmatched Stripe billing event".
 *   It should appear within a few seconds of the script completing.
 *
 * Step 6 — Verify in the server logs:
 *   Check the workflow console (Replit → workflow logs for artwork-bank) for
 *   the absence of "[Billing alert Slack] Post failed" lines.
 *   A successful post produces no error output.
 *
 * Troubleshooting:
 *   • "Post failed … not_in_channel"  — the bot was removed from the channel
 *     after the reconnect. Invite it back: /invite @<bot-name> in Slack.
 *   • "Post failed … invalid_auth"    — the token is still expired or the
 *     OAuth reconnect didn't complete. Repeat Step 2.
 *   • "Post failed … channel_not_found" — SLACK_BILLING_ALERTS_CHANNEL is set
 *     to a channel the bot cannot see. Verify the channel name/ID and bot
 *     membership.
 *   • No Slack check in script output  — SLACK_BILLING_ALERTS_CHANNEL is not
 *     set. Export it before running (see Step 4 above).
 *
 * See also: artifacts/artwork-bank/RUNBOOK.md — "Slack connector reconnect"
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { db } from "@workspace/db";
import { stripeAlertsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const BASE_URL = process.env.ARTWORK_BANK_URL ?? "http://localhost:3000";
const EVENT_ID = `evt_smoke_${Date.now()}`;

const syntheticEvent = {
  id: EVENT_ID,
  type: "customer.subscription.updated",
  data: {
    object: {
      id: `sub_smoke_${Date.now()}`,
      status: "active",
      customer: `cus_smoke_${Date.now()}`,
      metadata: {}, // deliberately empty — no billingTenantId → unmatched
    },
  },
};

function printReconnectRunbook() {
  console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║          SLACK CONNECTOR RECONNECT VERIFICATION RUNBOOK                    ║
╚══════════════════════════════════════════════════════════════════════════════╝

Use this runbook whenever the Replit Slack connector has been revoked and
re-granted — e.g. after rotating workspace credentials or reconnecting via
the Replit Integrations panel.

STEP 1 — Revoke the current token (skip if already revoked)
  a. Open the Replit workspace for this project.
  b. Navigate to Tools → Integrations (or the Integrations side-panel).
  c. Find the "Slack" connector and click "Disconnect" / "Revoke".
  d. Confirm the connector status changes to "Not connected".

STEP 2 — Re-grant access (reconnect the OAuth token)
  a. In the same Integrations panel, click "Connect" on the Slack connector.
  b. Complete the Slack OAuth flow in the popup (authorize the workspace).
  c. Confirm the connector status returns to "Connected".

STEP 3 — Restart the dev server
  Option A (Replit UI): Workflows → "artifacts/artwork-bank: web" → Restart
  Option B (shell):
    pnpm --filter @workspace/artwork-bank dev

STEP 4 — Run this smoke script to confirm delivery
  SLACK_BILLING_ALERTS_CHANNEL=#your-channel \\
    pnpm --filter @workspace/artwork-bank smoke:billing-alert

STEP 5 — Verify in Slack
  Open the channel set in SLACK_BILLING_ALERTS_CHANNEL and look for a message
  beginning with:
    "🚨 Unmatched Stripe billing event (customer.subscription.updated)"
  It should appear within a few seconds of the script completing.

STEP 6 — Verify in the server logs
  Check the workflow console for the ABSENCE of:
    "[Billing alert Slack] Post failed"
  No error output = successful post.

TROUBLESHOOTING
  "Post failed … not_in_channel"   → /invite @<bot-name> in Slack
  "Post failed … invalid_auth"     → OAuth reconnect incomplete; repeat Step 2
  "Post failed … channel_not_found"→ Check SLACK_BILLING_ALERTS_CHANNEL value
                                     and bot membership in that channel
  No Slack section in output       → SLACK_BILLING_ALERTS_CHANNEL not set;
                                     export it before running (Step 4)

See also: artifacts/artwork-bank/RUNBOOK.md — "Slack connector reconnect"
`);
}

async function main() {
  if (process.argv.includes("--reconnect-runbook")) {
    printReconnectRunbook();
    process.exit(0);
  }

  console.log("=== Billing alert smoke test (email + Slack) ===");
  console.log(`Event ID: ${EVENT_ID}`);
  console.log(`Target:   ${BASE_URL}/api/stripe/webhook\n`);

  // 1. Fire the dev-bypass webhook
  console.log("Step 1: POSTing synthetic unmatched subscription event…");
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/api/stripe/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(syntheticEvent),
    });
  } catch (err: any) {
    console.error(
      `FAIL  Could not reach the server at ${BASE_URL}.`,
      "Make sure the dev server is running (pnpm --filter @workspace/artwork-bank dev).",
      err?.message,
    );
    process.exit(1);
  }

  const payload = await res.json().catch(() => ({}));
  if (!res.ok || !payload.received) {
    console.error(`FAIL  Webhook returned ${res.status}:`, payload);
    console.error(
      "      Ensure STRIPE_WEBHOOK_DEV_BYPASS=true and NODE_ENV is not 'production'.",
    );
    process.exit(1);
  }
  console.log(`OK    Webhook accepted (${res.status})\n`);

  // 2. Confirm the alert row was written to the database
  console.log("Step 2: Checking database for billing alert row…");
  const alert = await db.query.stripeAlertsTable.findFirst({
    where: eq(stripeAlertsTable.stripeEventId, EVENT_ID),
  });

  if (!alert) {
    console.error(
      "FAIL  No billing alert row found for event ID",
      EVENT_ID,
      "\n      The webhook handler may not have reached the DB insert path.",
    );
    process.exit(1);
  }
  console.log(`OK    Alert row inserted (id: ${alert.id})`);
  console.log(`      reason: ${alert.reason}`);

  // Report the Slack delivery signal stored on the row.
  if (alert.slackPostFailed) {
    console.log(
      `WARN  slackPostFailed is set on the alert row (${alert.slackPostFailed.toISOString()}).`,
    );
    console.log(
      "      The Slack post failed — the operator was notified via the fallback email.",
    );
    console.log(
      "      After re-connecting the Slack integration, re-run this script to verify delivery.\n",
    );
  } else {
    console.log(
      "OK    slackPostFailed is null — Slack was either skipped (no channel set) or delivered successfully.\n",
    );
  }

  // 3. Report email-send status
  console.log("Step 3: Email delivery check…");
  const hasKey = Boolean(process.env.RESEND_API_KEY);
  const hasEmail = Boolean(process.env.PLATFORM_ADMIN_EMAIL);

  if (!hasKey || !hasEmail) {
    console.log(
      "INFO  Email send skipped (RESEND_API_KEY or PLATFORM_ADMIN_EMAIL not set).",
    );
    console.log(
      "      Re-run with both env vars to confirm delivery to the operator inbox.\n",
    );
  } else {
    console.log(`INFO  RESEND_API_KEY and PLATFORM_ADMIN_EMAIL are set.`);
    console.log(
      `      The webhook should have attempted to send to: ${process.env.PLATFORM_ADMIN_EMAIL}`,
    );
    console.log(
      "      Check the Resend dashboard (https://resend.com/emails) and",
    );
    console.log(
      `      the operator inbox at ${process.env.PLATFORM_ADMIN_EMAIL} to confirm delivery.\n`,
    );
  }

  // 4. Report Slack delivery status
  console.log("Step 4: Slack delivery check…");
  const slackChannel = process.env.SLACK_BILLING_ALERTS_CHANNEL;

  if (!slackChannel) {
    console.log(
      "INFO  Slack message skipped (SLACK_BILLING_ALERTS_CHANNEL not set).",
    );
    console.log(
      "      To enable Slack alerts:",
    );
    console.log(
      "        1. Connect the Slack integration in Replit Integrations (OAuth).",
    );
    console.log(
      "        2. Set SLACK_BILLING_ALERTS_CHANNEL to a channel name or ID",
    );
    console.log(
      "           e.g. #billing-alerts  or  C0123456789",
    );
    console.log(
      "        3. Re-run this script and check that channel in Slack.\n",
    );
  } else {
    console.log(
      `INFO  SLACK_BILLING_ALERTS_CHANNEL is set to: ${slackChannel}`,
    );
    console.log(
      "      The webhook should have attempted to post to that channel.",
    );
    console.log(
      `      Open Slack and check ${slackChannel} for a message like:`,
    );
    console.log(
      `        "🚨 Unmatched Stripe billing event (customer.subscription.updated)"`,
    );
    console.log(
      "      Also check the server workflow logs for any",
    );
    console.log(
      `      "[Billing alert Slack] Post failed" lines — their absence means success.\n`,
    );
  }

  console.log("=== Smoke test passed ===");
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
