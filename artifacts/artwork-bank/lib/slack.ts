/**
 * Slack notification helpers using the Replit connectors SDK.
 * Gracefully skips if SLACK_BILLING_ALERTS_CHANNEL is not set or the SDK call
 * fails — callers must not surface Slack errors to end-users.
 */

import { ReplitConnectors } from "@replit/connectors-sdk";

/**
 * Resolve the Slack channel for a given Stripe event type.
 *
 * Per-event-type overrides (checked first):
 *   SLACK_CHANNEL_INVOICE_FAILED       → invoice.payment_failed
 *   SLACK_CHANNEL_SUBSCRIPTION_EVENTS  → customer.subscription.*
 *
 * Falls back to SLACK_BILLING_ALERTS_CHANNEL when no specific override is set.
 * Returns undefined when neither an override nor the default is configured.
 */
export function resolveSlackChannel(eventType: string): string | undefined {
  if (eventType === "invoice.payment_failed") {
    const override = process.env.SLACK_CHANNEL_INVOICE_FAILED;
    if (override !== undefined) {
      if (override === "") {
        console.warn(
          "[Billing alert Slack] SLACK_CHANNEL_INVOICE_FAILED is set to an empty string — " +
            "falling back to SLACK_BILLING_ALERTS_CHANNEL. " +
            "Remove the variable or give it a non-empty value to suppress this warning.",
        );
      } else {
        return override;
      }
    }
  }

  if (eventType.startsWith("customer.subscription.")) {
    const override = process.env.SLACK_CHANNEL_SUBSCRIPTION_EVENTS;
    if (override !== undefined) {
      if (override === "") {
        console.warn(
          "[Billing alert Slack] SLACK_CHANNEL_SUBSCRIPTION_EVENTS is set to an empty string — " +
            "falling back to SLACK_BILLING_ALERTS_CHANNEL. " +
            "Remove the variable or give it a non-empty value to suppress this warning.",
        );
      } else {
        return override;
      }
    }
  }

  return process.env.SLACK_BILLING_ALERTS_CHANNEL;
}

/**
 * Post a billing-alert message to the configured Slack channel when an
 * unmatched Stripe event is saved as a stripe_alert row.
 *
 * Channel resolution (per-type overrides fall back to SLACK_BILLING_ALERTS_CHANNEL):
 *   SLACK_CHANNEL_INVOICE_FAILED       → invoice.payment_failed events
 *   SLACK_CHANNEL_SUBSCRIPTION_EVENTS  → customer.subscription.* events
 *   SLACK_BILLING_ALERTS_CHANNEL       → all other events / fallback
 *
 * If no channel is configured the call is a no-op. Failures are logged but
 * never re-thrown.
 */
export type SlackNotificationResult =
  | { ok: true }
  | { ok: false; error: string };

export async function sendBillingAlertSlackNotification({
  stripeEventId,
  eventType,
  customerId,
  subscriptionId,
  reason,
}: {
  stripeEventId: string;
  eventType: string;
  customerId?: string | null;
  subscriptionId?: string | null;
  reason: string;
}): Promise<SlackNotificationResult> {
  const channel = resolveSlackChannel(eventType);

  if (!channel) {
    console.log(
      `[Billing alert Slack skipped — no channel configured for eventType=${eventType}` +
        ` (set SLACK_CHANNEL_INVOICE_FAILED, SLACK_CHANNEL_SUBSCRIPTION_EVENTS,` +
        ` or SLACK_BILLING_ALERTS_CHANNEL)] eventId=${stripeEventId}`,
    );
    return { ok: true };
  }

  const { getPlatformBaseUrl } = await import("@/lib/base-url");
  const baseUrl = getPlatformBaseUrl();
  const panelUrl = baseUrl ? `${baseUrl}/platform` : null;

  // Build a human-readable summary line.
  const details: string[] = [`*Event type:* ${eventType}`];
  if (customerId) details.push(`*Customer ID:* \`${customerId}\``);
  if (subscriptionId) details.push(`*Subscription ID:* \`${subscriptionId}\``);
  details.push(`*Reason:* ${reason}`);
  if (panelUrl) details.push(`<${panelUrl}|View billing alerts panel>`);

  const text =
    `:rotating_light: *Unmatched Stripe billing event* (${eventType})\n` +
    details.join("\n");

  try {
    const connectors = new ReplitConnectors();
    const response = await connectors.proxy("slack", "/chat.postMessage", {
      method: "POST",
      body: JSON.stringify({ channel, text }),
    });

    const body = await response.json().catch(() => null);
    if (!response.ok || (body && !body.ok)) {
      const errorDetail = body?.error ?? `HTTP ${response.status}`;
      console.error(
        `[Billing alert Slack] Post failed (HTTP ${response.status}):`,
        body?.error ?? "(no error field)",
      );
      // Structured entry so monitoring / log-based alerts can filter on this event.
      console.error(
        JSON.stringify({
          type: "slack_billing_alert_failure",
          eventId: stripeEventId,
          channel,
          errorType: "http_error",
          errorMessage: errorDetail,
        }),
      );
      return { ok: false, error: errorDetail };
    }

    return { ok: true };
  } catch (err) {
    const errorMessage = (err as any)?.message ?? String(err);
    console.error(
      `[Billing alert Slack] Failed to post message for eventId=${stripeEventId}: ${errorMessage}`,
    );
    // Structured entry so monitoring / log-based alerts can filter on this event.
    console.error(
      JSON.stringify({
        type: "slack_billing_alert_failure",
        eventId: stripeEventId,
        channel,
        errorType: "sdk_throw",
        errorMessage,
      }),
    );
    return { ok: false, error: errorMessage };
  }
}
