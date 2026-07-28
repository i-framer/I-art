/**
 * Slack notification helpers using the Replit connectors SDK.
 * Gracefully skips if SLACK_BILLING_ALERTS_CHANNEL is not set or the SDK call
 * fails — callers must not surface Slack errors to end-users.
 */

import { ReplitConnectors } from "@replit/connectors-sdk";

/**
 * Post a billing-alert message to the configured Slack channel when an
 * unmatched Stripe event is saved as a stripe_alert row.
 *
 * Channel is read from SLACK_BILLING_ALERTS_CHANNEL; if not set the call is a
 * no-op. Failures are logged but never re-thrown.
 */
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
}): Promise<void> {
  const channel = process.env.SLACK_BILLING_ALERTS_CHANNEL;

  if (!channel) {
    console.log(
      `[Billing alert Slack skipped — SLACK_BILLING_ALERTS_CHANNEL not set] ` +
        `eventId=${stripeEventId}`,
    );
    return;
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
      console.error(
        `[Billing alert Slack] Post failed (HTTP ${response.status}):`,
        body?.error ?? "(no error field)",
      );
    }
  } catch (err) {
    console.error(
      `[Billing alert Slack] Failed to post message: ${(err as any)?.message ?? String(err)}`,
    );
  }
}
