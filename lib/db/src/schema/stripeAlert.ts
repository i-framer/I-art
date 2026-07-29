import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Persists Stripe webhook events that could not be matched to a tenant.
 * These are surfaced in the platform-admin billing alerts panel so they can be
 * investigated and dismissed once resolved.
 */
export const stripeAlertsTable = pgTable(
  "stripe_alert",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** Stripe event ID — unique per event. */
    stripeEventId: text("stripe_event_id").notNull().unique(),
    /** e.g. "customer.subscription.updated" */
    eventType: text("event_type").notNull(),
    /** Stripe customer ID extracted from the event (if available). */
    customerId: text("customer_id"),
    /** Stripe subscription ID extracted from the event (if available). */
    subscriptionId: text("subscription_id"),
    /** Human-readable reason the event was unmatched. */
    reason: text("reason").notNull(),
    /** When the operator dismissed/resolved this alert. Null = unresolved. */
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    /**
     * Set when the Slack billing-alert post failed (auth error, network error,
     * etc.). Null means Slack either succeeded or was not configured.
     * Operators can query this column to find alerts that were never delivered
     * to Slack (e.g. after a token rotation) and decide whether to re-send.
     */
    slackPostFailed: timestamp("slack_post_failed", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("stripe_alert_dismissed_at_created_at_idx").on(
      table.dismissedAt,
      table.createdAt,
    ),
  ],
);

export type StripeAlert = typeof stripeAlertsTable.$inferSelect;
