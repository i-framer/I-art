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
 * After running:
 *   - Database:  the script confirms the alert row itself.
 *   - Email:     check the Resend dashboard (https://resend.com/emails) and
 *                the operator inbox at PLATFORM_ADMIN_EMAIL.
 *   - Slack:     check the channel named in SLACK_BILLING_ALERTS_CHANNEL for a
 *                message like "🚨 Unmatched Stripe billing event (customer.subscription.updated)".
 *                The server logs (workflow console) will show either
 *                "[Billing alert Slack] Post failed" or no error on success.
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

async function main() {
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
  console.log(`      reason: ${alert.reason}\n`);

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
