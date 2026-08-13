import {
  pgTable,
  pgEnum,
  text,
  integer,
  timestamp,
  date,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenantsTable } from "./tenant";
import { representedArtistsTable } from "./representedArtist";
import { artworksTable } from "./artwork";
import { ordersTable } from "./order";

/**
 * Consignment & Commission Tracker — Task #82
 *
 * Tables:
 *  consignment_agreement — per-artist commission agreement
 *  consignment_item      — artwork linked to an agreement (intake/return)
 *  consignment_sale      — sale recorded against a consigned item
 *  artist_payment        — payment disbursed to an artist
 */

// ── Enums ────────────────────────────────────────────────────────────────────

export const agreementStatusEnum = pgEnum("agreement_status", [
  "ACTIVE",
  "EXPIRED",
  "CANCELLED",
]);

export const consignmentItemStatusEnum = pgEnum("consignment_item_status", [
  "IN_STOCK",
  "SOLD",
  "RETURNED",
]);

export const salePaymentStatusEnum = pgEnum("sale_payment_status", [
  "PENDING",
  "PAID",
]);

// ── Tables ────────────────────────────────────────────────────────────────────

/**
 * A commission agreement between a gallery/framer and one of their
 * represented artists. Specifies the artist's share of each sale (as a
 * percentage, e.g. 60 = 60% to artist) and optional term dates.
 */
export const consignmentAgreementsTable = pgTable("consignment_agreement", {
  id: text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  artistId: text("artist_id")
    .notNull()
    .references(() => representedArtistsTable.id, { onDelete: "restrict" }),
  /** Artist's share of each sale in percentage points (e.g. 60 = 60 %). */
  artistPct: integer("artist_pct").notNull(),
  /** Optional minimum acceptable sale price in cents. */
  minPriceCents: integer("min_price_cents"),
  startDate: date("start_date"),
  endDate: date("end_date"),
  status: agreementStatusEnum("status").notNull().default("ACTIVE"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * An artwork physically received under a consignment agreement.
 * Tracks intake date, return date, and current status.
 */
export const consignmentItemsTable = pgTable("consignment_item", {
  id: text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  agreementId: text("agreement_id")
    .notNull()
    .references(() => consignmentAgreementsTable.id, { onDelete: "restrict" }),
  artworkId: text("artwork_id")
    .notNull()
    .references(() => artworksTable.id, { onDelete: "restrict" }),
  intakeDate: date("intake_date").notNull(),
  returnDate: date("return_date"),
  status: consignmentItemStatusEnum("status").notNull().default("IN_STOCK"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * A sale recorded against a consigned item. Stores the full sale price,
 * the calculated artist and gallery amounts, and an optional link to a
 * Stripe-backed storefront order.
 */
export const consignmentSalesTable = pgTable("consignment_sale", {
  id: text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  itemId: text("item_id")
    .notNull()
    .references(() => consignmentItemsTable.id, { onDelete: "restrict" }),
  /** Total sale price in cents. */
  salePriceCents: integer("sale_price_cents").notNull(),
  /** Artist's portion in cents (salePriceCents * artistPct / 100, rounded down). */
  artistAmountCents: integer("artist_amount_cents").notNull(),
  /** Gallery's portion in cents (salePriceCents - artistAmountCents). */
  galleryAmountCents: integer("gallery_amount_cents").notNull(),
  /** Optional link to a storefront order (Stripe-backed sale). */
  orderId: text("order_id").references(() => ordersTable.id, {
    onDelete: "set null",
  }),
  paymentStatus: salePaymentStatusEnum("payment_status")
    .notNull()
    .default("PENDING"),
  saleDate: date("sale_date").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * A payment disbursed to an artist against one or more outstanding sales.
 * Records the amount paid and an optional reference/note.
 */
export const artistPaymentsTable = pgTable("artist_payment", {
  id: text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  artistId: text("artist_id")
    .notNull()
    .references(() => representedArtistsTable.id, { onDelete: "restrict" }),
  amountCents: integer("amount_cents").notNull(),
  paymentDate: date("payment_date").notNull(),
  reference: text("reference"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ConsignmentAgreement =
  typeof consignmentAgreementsTable.$inferSelect;
export type InsertConsignmentAgreement =
  typeof consignmentAgreementsTable.$inferInsert;

export type ConsignmentItem = typeof consignmentItemsTable.$inferSelect;
export type InsertConsignmentItem = typeof consignmentItemsTable.$inferInsert;

export type ConsignmentSale = typeof consignmentSalesTable.$inferSelect;
export type InsertConsignmentSale = typeof consignmentSalesTable.$inferInsert;

export type ArtistPayment = typeof artistPaymentsTable.$inferSelect;
export type InsertArtistPayment = typeof artistPaymentsTable.$inferInsert;
