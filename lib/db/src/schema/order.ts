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
