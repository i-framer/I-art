/**
 * Integration smoke test: Slack billing alerts against the live Replit connector.
 *
 * This test is SKIPPED by default. It only runs when SLACK_INTEGRATION_TEST=true
 * is set in the environment, because it makes a real network call to the Replit
 * connectors SDK and posts an actual message to the configured Slack channel.
 *
 * Prerequisites (all must be set before running):
 *   SLACK_INTEGRATION_TEST=true          — opt-in flag to enable this test
 *   SLACK_BILLING_ALERTS_CHANNEL=<name>  — the Slack channel to post to
 *                                          (e.g. #billing-alerts or C0123456789)
 *
 * The Slack connector must be connected in the Replit Integrations panel. If it
 * was recently reconnected, restart the dev server first so it picks up the new
 * OAuth token (see RUNBOOK.md — "Slack connector reconnect").
 *
 * Run from the workspace root:
 *   SLACK_INTEGRATION_TEST=true \
 *   SLACK_BILLING_ALERTS_CHANNEL=#billing-alerts \
 *     pnpm --filter @workspace/artwork-bank test -- --reporter=verbose slack-reconnect-smoke
 *
 * After the test passes, verify the message arrived in Slack:
 *   Open the channel and look for a message beginning with:
 *     "🚨 Unmatched Stripe billing event (customer.subscription.updated)"
 *
 * See RUNBOOK.md — "Slack connector reconnect" for the full verification
 * procedure after re-authorising the OAuth token.
 */

import { describe, it, expect } from "vitest";
import { sendBillingAlertSlackNotification } from "@/lib/slack";

const RUN_INTEGRATION = process.env.SLACK_INTEGRATION_TEST === "true";

describe.skipIf(!RUN_INTEGRATION)(
  "Slack billing alert — live connector smoke test (SLACK_INTEGRATION_TEST=true)",
  () => {
    it(
      "posts to the real Slack connector and returns { ok: true }",
      async () => {
        const channel = process.env.SLACK_BILLING_ALERTS_CHANNEL;
        if (!channel) {
          throw new Error(
            "SLACK_BILLING_ALERTS_CHANNEL must be set to run the Slack integration smoke test.\n" +
              "Example: SLACK_BILLING_ALERTS_CHANNEL=#billing-alerts SLACK_INTEGRATION_TEST=true pnpm --filter @workspace/artwork-bank test",
          );
        }

        const result = await sendBillingAlertSlackNotification({
          stripeEventId: `evt_smoke_reconnect_${Date.now()}`,
          eventType: "customer.subscription.updated",
          customerId: "cus_smoke_test",
          subscriptionId: "sub_smoke_test",
          reason: "Smoke test — Slack connector reconnect verification",
        });

        expect(result).toMatchObject({ ok: true });
      },
      // Allow up to 15 s for the live network call.
      15_000,
    );
  },
);
