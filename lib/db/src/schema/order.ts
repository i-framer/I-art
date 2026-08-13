import {
  pgTable,
  pgEnum,
  text,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenantsTable } from "./tenant";
import { artworksTable } from "./artwork";

export const orderStatusEnum = pgEnum("order_status", [
  "PENDING",
  "PAID",
  "FULFILLED",
  "CANCELLED",
]);

export const fulfillmentTypeEnum = pgEnum("fulfillment_type", [
  "SHIP",
  "PICKUP",
  "FRAMING_JOB",
]);

export const ordersTable = pgTable("order", {
  id: text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenantsTable.id),
  stripeSessionId: text("stripe_session_id").unique(),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  buyerEmail: text("buyer_email").notNull(),
  buyerName: text("buyer_name"),
  status: orderStatusEnum("status").default("PENDING").notNull(),
  fulfillmentType: fulfillmentTypeEnum("fulfillment_type").notNull(),
  totalCents: integer("total_cents").notNull(),
  applicationFeeCents: integer("application_fee_cents"),
  trackingNote: text("tracking_note"),
  // iFramer integration (FRAMING_JOB orders only)
  iframerJobId: text("iframer_job_id"),
  iframerJobError: text("iframer_job_error"),
  // Buyer confirmation email delivery tracking
  emailSentAt: timestamp("email_sent_at", { withTimezone: true }),
  emailError: text("email_error"),
  // Automatic retry bookkeeping for the background email sweep
  emailAttempts: integer("email_attempts").default(0).notNull(),
  emailLastAttemptAt: timestamp("email_last_attempt_at", { withTimezone: true }),
  // Set once when the gallery has been notified that confirmation-email
  // retries were exhausted, so the notification is sent at most once.
  emailFailureNotifiedAt: timestamp("email_failure_notified_at", {
    withTimezone: true,
  }),
  // Buyer status-update email (fulfilled / tracking note changed).
  // Non-null statusEmailQueuedAt means an update email is owed to the buyer;
  // it is cleared once delivered. The sweep retries failures with backoff.
  statusEmailQueuedAt: timestamp("status_email_queued_at", { withTimezone: true }),
  statusEmailError: text("status_email_error"),
  statusEmailAttempts: integer("status_email_attempts").default(0).notNull(),
  statusEmailLastAttemptAt: timestamp("status_email_last_attempt_at", {
    withTimezone: true,
  }),
  /**
   * The platform commission rate actually applied to this order, in basis points
   * (hundredths of a percent). e.g. 500 = 5.00 %, 350 = 3.50 %.
   * Recorded at checkout time so a subsequent change to the tenant's rate
   * does not retroactively alter past orders.
   */
  commissionBasisPoints: integer("commission_basis_points"),
  // Partial / full refund tracking
  refundedAmountCents: integer("refunded_amount_cents"),
  refundedAt: timestamp("refunded_at", { withTimezone: true }),
  stripeRefundId: text("stripe_refund_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const orderItemsTable = pgTable("order_item", {
  id: text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  orderId: text("order_id")
    .notNull()
    .references(() => ordersTable.id, { onDelete: "cascade" }),
  artworkId: text("artwork_id")
    .notNull()
    .references(() => artworksTable.id),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenantsTable.id),
  quantity: integer("quantity").default(1).notNull(),
  priceCents: integer("price_cents").notNull(),
  artworkTitle: text("artwork_title").notNull(),
  artworkSku: text("artwork_sku"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
