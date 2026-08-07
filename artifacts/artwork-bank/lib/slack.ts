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
      if (override.trim() === "") {
        console.warn(
          "[Billing alert Slack] SLACK_CHANNEL_INVOICE_FAILED is set to an empty or whitespace-only string — " +
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
      if (override.trim() === "") {
        console.warn(
          "[Billing alert Slack] SLACK_CHANNEL_SUBSCRIPTION_EVENTS is set to an empty or whitespace-only string — " +
            "falling back to SLACK_BILLING_ALERTS_CHANNEL. " +
            "Remove the variable or give it a non-empty value to suppress this warning.",
        );
      } else {
        return override;
      }
    }
  }

  const fallback = process.env.SLACK_BILLING_ALERTS_CHANNEL;
  if (fallback !== undefined && fallback.trim() === "") {
    console.warn(
      "[Billing alert Slack] SLACK_BILLING_ALERTS_CHANNEL is set to an empty or whitespace-only string — " +
        "Slack notifications will be skipped. " +
        "Remove the variable or give it a non-empty channel name to suppress this warning.",
    );
    return undefined;
  }
  return fallback;
}

/**
 * Post an orphan-sweep error alert to the configured Slack channel when the
 * sweep completes with one or more storage-deletion failures.
 *
 * Reuses SLACK_BILLING_ALERTS_CHANNEL so no additional configuration is needed.
 * If no channel is configured the call is a no-op. Failures are logged but
 * never re-thrown.
 */
export async function sendOrphanSweepSlackNotification({
  errors,
  failedPaths,
}: {
  errors: number;
  failedPaths: string[];
}): Promise<SlackNotificationResult> {
  const channel = process.env.SLACK_BILLING_ALERTS_CHANNEL?.trim();

  if (!channel) {
    console.log(
      "[Orphan sweep Slack skipped — SLACK_BILLING_ALERTS_CHANNEL not configured]",
    );
    return { ok: true };
  }

  const pathList =
    failedPaths.length > 0
      ? failedPaths
          .slice(0, 20)
          .map((p) => `• \`${p}\``)
          .join("\n") +
        (failedPaths.length > 20
          ? `\n• … and ${failedPaths.length - 20} more`
          : "")
      : "(no paths recorded)";

  const text =
    `:warning: *Orphan image sweep completed with errors*\n` +
    `*Failed deletions:* ${errors}\n` +
    `*Paths that could not be deleted:*\n${pathList}\n` +
    `Check server logs for details and re-run the sweep once the underlying issue is resolved.`;

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
        `[Orphan sweep Slack] Post failed (HTTP ${response.status}):`,
        body?.error ?? "(no error field)",
      );
      return { ok: false, error: errorDetail };
    }

    return { ok: true };
  } catch (err) {
    const errorMessage = (err as any)?.message ?? String(err);
    console.error(`[Orphan sweep Slack] Failed to post message: ${errorMessage}`);
    return { ok: false, error: errorMessage };
  }
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

/**
 * Post an alert to the configured Slack channel when a Stripe refund was
 * accepted but the subsequent DB write failed. The operator must reconcile
 * the order manually before allowing any retry.
 *
 * Uses SLACK_BILLING_ALERTS_CHANNEL. If no channel is configured the call is
 * a no-op. Failures are logged but never re-thrown — this is always fire-and-forget.
 */
export async function sendRefundDbFailureSlackNotification({
  stripeRefundId,
  orderId,
  tenantId,
}: {
  stripeRefundId: string;
  orderId: string;
  tenantId: string;
}): Promise<SlackNotificationResult> {
  const channel = process.env.SLACK_BILLING_ALERTS_CHANNEL?.trim();

  if (!channel) {
    console.log(
      "[Refund DB-failure Slack skipped — SLACK_BILLING_ALERTS_CHANNEL not configured]",
      { stripeRefundId, orderId, tenantId },
    );
    return { ok: true };
  }

  const text =
    `:rotating_light: *Stripe refund recorded in Stripe but NOT in the database*\n` +
    `*Stripe refund ID:* \`${stripeRefundId}\`\n` +
    `*Order ID:* \`${orderId}\`\n` +
    `*Tenant:* \`${tenantId}\`\n` +
    `The refund was accepted by Stripe but the order record could not be updated. ` +
    `Do NOT retry the refund — check Stripe for \`${stripeRefundId}\` and update the order manually.`;

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
        `[Refund DB-failure Slack] Post failed (HTTP ${response.status}):`,
        body?.error ?? "(no error field)",
        { stripeRefundId, orderId, tenantId },
      );
      return { ok: false, error: errorDetail };
    }

    return { ok: true };
  } catch (err) {
    const errorMessage = (err as any)?.message ?? String(err);
    console.error(
      `[Refund DB-failure Slack] Failed to post message: ${errorMessage}`,
      { stripeRefundId, orderId, tenantId },
    );
    return { ok: false, error: errorMessage };
  }
}

/**
 * Post an audit message to the configured Slack channel when an i-Framer
 * Premium account is linked to or unlinked from a tenant by a platform admin,
 * or when an operator manually removes the billing comp from an i-Framer-linked
 * tenant via setBillingExempt(false).
 *
 * Actions:
 *   "linked"       — an i-Framer account ID was associated with the tenant
 *   "unlinked"     — the i-Framer account ID was cleared from the tenant
 *   "comp-removed" — billingExempt was flipped to false while iframerAccountId
 *                    is still set (tenant remains linked but loses the comp)
 *
 * Uses SLACK_BILLING_ALERTS_CHANNEL. If no channel is configured the call is
 * a no-op. Failures are logged but never re-thrown.
 */
export async function sendIframerAccountSlackNotification({
  action,
  tenantName,
  tenantSlug,
  accountId,
  adminEmail,
}: {
  action: "linked" | "unlinked" | "comp-removed";
  tenantName: string | undefined;
  tenantSlug: string | undefined;
  accountId: string | null;
  adminEmail: string | undefined;
}): Promise<SlackNotificationResult> {
  const channel = process.env.SLACK_BILLING_ALERTS_CHANNEL?.trim();

  if (!channel) {
    console.log(
      "[i-Framer account Slack skipped — SLACK_BILLING_ALERTS_CHANNEL not configured]",
    );
    return { ok: true };
  }

  const tenantLabel = tenantName
    ? `${tenantName} (\`${tenantSlug ?? tenantName}\`)`
    : `\`${tenantSlug ?? "(unknown)"}\``;

  let text: string;
  if (action === "linked") {
    text =
      `:link: *i-Framer Premium account linked*\n` +
      `*Tenant:* ${tenantLabel}\n` +
      `*Account ID:* \`${accountId ?? "(unknown)"}\`\n` +
      `*Admin:* ${adminEmail ?? "(unknown)"}`;
  } else if (action === "unlinked") {
    text =
      `:chains: *i-Framer Premium account unlinked*\n` +
      `*Tenant:* ${tenantLabel}\n` +
      `*Admin:* ${adminEmail ?? "(unknown)"}`;
  } else {
    // "comp-removed": billing_exempt flipped to false while the i-Framer link remains
    text =
      `:no_entry: *i-Framer Premium comp removed (tenant still linked)*\n` +
      `*Tenant:* ${tenantLabel}\n` +
      `*Account ID:* \`${accountId ?? "(unknown)"}\`\n` +
      `*Admin:* ${adminEmail ?? "(unknown)"}\n` +
      `The i-Framer account link is still set but billing_exempt is now false. ` +
      `The tenant will be locked out until a subscription is active or the comp is restored.`;
  }

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
        `[i-Framer account Slack] Post failed (HTTP ${response.status}):`,
        body?.error ?? "(no error field)",
      );
      return { ok: false, error: errorDetail };
    }

    return { ok: true };
  } catch (err) {
    const errorMessage = (err as any)?.message ?? String(err);
    console.error(
      `[i-Framer account Slack] Failed to post message: ${errorMessage}`,
    );
    return { ok: false, error: errorMessage };
  }
}

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
