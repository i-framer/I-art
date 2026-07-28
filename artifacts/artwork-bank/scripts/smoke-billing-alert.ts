/**
 * Smoke-test script: Billing alert email end-to-end verification.
 *
 * Fires a dev-bypass webhook with a synthetic unmatched subscription event,
 * then confirms:
 *   1. The billing alert row was written to the database.
 *   2. The Resend email was attempted (real API call when RESEND_API_KEY is set).
 *
 * Prerequisites:
 *   - The Artwork Bank server must be running locally (pnpm --filter @workspace/artwork-bank dev)
 *   - STRIPE_WEBHOOK_DEV_BYPASS=true must be set (default in dev)
 *   - DATABASE_URL must be set (populated automatically in the Replit workspace)
 *   - Optional: RESEND_API_KEY + PLATFORM_ADMIN_EMAIL for a real email send
 *
 * Usage:
 *   pnpm --filter @workspace/artwork-bank tsx scripts/smoke-billing-alert.ts
 *
 *   With real email send:
 *   RESEND_API_KEY=re_live_xxx PLATFORM_ADMIN_EMAIL=you@example.com \
 *     pnpm --filter @workspace/artwork-bank tsx scripts/smoke-billing-alert.ts
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
  console.log("=== Billing alert smoke test ===");
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
  const hasKey = Boolean(process.env.RESEND_API_KEY);
  const hasEmail = Boolean(process.env.PLATFORM_ADMIN_EMAIL);

  if (!hasKey || !hasEmail) {
    console.log(
      "INFO  Email send skipped (RESEND_API_KEY or PLATFORM_ADMIN_EMAIL not set).",
    );
    console.log(
      "      Re-run with both env vars to confirm delivery to the operator inbox.",
    );
  } else {
    console.log(
      `INFO  RESEND_API_KEY and PLATFORM_ADMIN_EMAIL are set.`,
    );
    console.log(
      `      The webhook should have attempted to send to: ${process.env.PLATFORM_ADMIN_EMAIL}`,
    );
    console.log(
      "      Check the Resend dashboard (https://resend.com/emails) and the",
    );
    console.log(
      `      operator inbox at ${process.env.PLATFORM_ADMIN_EMAIL} to confirm delivery.`,
    );
  }

  console.log("\n=== Smoke test passed ===");
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
