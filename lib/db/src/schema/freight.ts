import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
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

export const freightCarrierProviderEnum = pgEnum("freight_carrier_provider", [
  "AUSTRALIA_POST",
  "ARAMEX",
]);

/**
 * Carrier accounts are owned by a gallery today, but the nullable tenant ID and
 * PLATFORM owner mode leave a safe path for a platform-owned account later.
 */
export const freightCarrierOwnerEnum = pgEnum("freight_carrier_owner", [
  "GALLERY",
  "PLATFORM",
]);

export const freightQuoteSourceEnum = pgEnum("freight_quote_source", [
  "LIVE",
  "MANUAL",
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
  originAddressLine1: text("origin_address_line1"),
  originAddressLine2: text("origin_address_line2"),
  originSuburb: text("origin_suburb"),
  originState: text("origin_state"),
  originPostcode: text("origin_postcode"),
  originCountryCode: text("origin_country_code").notNull().default("AU"),
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

/**
 * Encrypted credentials are deliberately opaque to the data layer. Only
 * server-side carrier adapters decrypt them immediately before a quote request.
 */
export const freightCarrierAccountsTable = pgTable(
  "freight_carrier_account",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id").references(() => tenantsTable.id, {
      onDelete: "cascade",
    }),
    owner: freightCarrierOwnerEnum("owner").notNull().default("GALLERY"),
    provider: freightCarrierProviderEnum("provider").notNull(),
    label: text("label").notNull(),
    credentialsCiphertext: text("credentials_ciphertext").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("freight_carrier_account_tenant_idx").on(t.tenantId, t.enabled),
    index("freight_carrier_account_provider_owner_idx").on(t.provider, t.owner),
  ],
);

/**
 * A gallery may opt into a platform-approved account, but never receives or
 * manages its credentials. Removing either side revokes access automatically.
 */
export const freightCarrierAccountAccessTable = pgTable(
  "freight_carrier_account_access",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    carrierAccountId: text("carrier_account_id")
      .notNull()
      .references(() => freightCarrierAccountsTable.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.carrierAccountId] }),
    index("freight_carrier_account_access_account_idx").on(
      t.carrierAccountId,
      t.enabled,
    ),
  ],
);

/**
 * A quote is persisted rather than trusted from the browser. It captures the
 * exact destination and packed parcel that produced the rate and expires before
 * a payment session can be created from it.
 */
export const freightQuotesTable = pgTable(
  "freight_quote",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    artworkId: text("artwork_id").notNull(),
    carrierAccountId: text("carrier_account_id").references(
      () => freightCarrierAccountsTable.id,
      { onDelete: "set null" },
    ),
    freightMethodId: text("freight_method_id").references(
      () => freightMethodsTable.id,
      { onDelete: "set null" },
    ),
    source: freightQuoteSourceEnum("source").notNull(),
    provider: text("provider").notNull(),
    serviceCode: text("service_code"),
    serviceName: text("service_name").notNull(),
    freightClass: freightClassEnum("freight_class"),
    /** Carrier or manual freight before the artwork-specific packing charge. */
    freightCents: integer("freight_cents").notNull(),
    packagingCents: integer("packaging_cents").notNull().default(0),
    /** The buyer-facing delivery amount charged at checkout. */
    deliveryCents: integer("delivery_cents").notNull().default(0),
    destinationLine1: text("destination_line1").notNull(),
    destinationLine2: text("destination_line2"),
    destinationSuburb: text("destination_suburb").notNull(),
    destinationState: text("destination_state").notNull(),
    destinationPostcode: text("destination_postcode").notNull(),
    destinationCountryCode: text("destination_country_code").notNull(),
    packageLengthMm: integer("package_length_mm").notNull(),
    packageWidthMm: integer("package_width_mm").notNull(),
    packageHeightMm: integer("package_height_mm").notNull(),
    packedWeightGrams: integer("packed_weight_grams").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("freight_quote_tenant_artwork_expiry_idx").on(
      t.tenantId,
      t.artworkId,
      t.expiresAt,
    ),
  ],
);

export type FreightSettings = typeof freightSettingsTable.$inferSelect;
export type FreightMethod = typeof freightMethodsTable.$inferSelect;
export type FreightCarrierAccount = typeof freightCarrierAccountsTable.$inferSelect;
export type FreightCarrierAccountAccess =
  typeof freightCarrierAccountAccessTable.$inferSelect;
export type FreightQuote = typeof freightQuotesTable.$inferSelect;