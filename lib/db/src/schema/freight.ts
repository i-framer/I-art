import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenantsTable } from "./tenant";

export const freightClassEnum = pgEnum("freight_class", [
  "SMALL",
  "MEDIUM",
  "LARGE",
  "TUBE",
]);

export const artworkShippingFormatEnum = pgEnum("artwork_shipping_format", [
  "STANDARD",
  "TUBE",
]);

/**
 * One settings row per gallery. The standard size class is calculated from the
 * largest saved artwork dimension: <= smallMaxMm is SMALL, <= mediumMaxMm is
 * MEDIUM, and anything larger is LARGE.
 */
export const freightSettingsTable = pgTable("freight_settings", {
  tenantId: text("tenant_id")
    .primaryKey()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  smallMaxMm: integer("small_max_mm").notNull().default(800),
  mediumMaxMm: integer("medium_max_mm").notNull().default(1500),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * A gallery-owned carrier/service with a price for each package class. Rates
 * are stored in cents to keep all payment calculations integer-safe.
 */
export const freightMethodsTable = pgTable(
  "freight_method",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    smallCents: integer("small_cents").notNull().default(0),
    mediumCents: integer("medium_cents").notNull().default(0),
    largeCents: integer("large_cents").notNull().default(0),
    tubeCents: integer("tube_cents").notNull().default(0),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("freight_method_tenant_idx").on(t.tenantId)],
);

export type FreightSettings = typeof freightSettingsTable.$inferSelect;
export type FreightMethod = typeof freightMethodsTable.$inferSelect;