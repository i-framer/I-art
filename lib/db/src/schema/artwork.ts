import {
  pgTable,
  text,
  boolean,
  integer,
  timestamp,
  index,
  pgEnum,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenantsTable } from "./tenant";
import { representedArtistsTable } from "./representedArtist";
import { artworkShippingFormatEnum } from "./freight";

export const artworkConditionEnum = pgEnum("artwork_condition", [
  "EXCELLENT",
  "GOOD",
  "FAIR",
  "POOR",
]);

export const artworkStatusEnum = pgEnum("artwork_status", [
  "AVAILABLE",
  "SOLD",
  "RESERVED",
  "HIDDEN",
]);

export const artworksTable = pgTable(
  "artwork",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    representedArtistId: text("represented_artist_id").references(
      () => representedArtistsTable.id,
      { onDelete: "set null" },
    ),
    title: text("title").notNull(),
    sku: text("sku").notNull(),
    medium: text("medium"),
    // Dimensions stored in millimetres
    dimensionsW: integer("dimensions_w"),
    dimensionsH: integer("dimensions_h"),
    dimensionsD: integer("dimensions_d"),
    /** Standard packages are dimension-classified; tube packages use tube rates. */
    shippingFormat: artworkShippingFormatEnum("shipping_format")
      .notNull()
      .default("STANDARD"),
    /**
     * Packed parcel measurements used for live shipping quotes. These include
     * protective packaging and deliberately remain separate from the artwork's
     * display dimensions above.
     */
    packageLengthMm: integer("package_length_mm"),
    packageWidthMm: integer("package_width_mm"),
    packageHeightMm: integer("package_height_mm"),
    packedWeightGrams: integer("packed_weight_grams"),
    /** Artwork-specific materials charge added to the carrier's raw freight. */
    packagingCents: integer("packaging_cents").notNull().default(0),
    condition: artworkConditionEnum("condition"),
    // Price stored in cents (smallest currency unit)
    price: integer("price"),
    status: artworkStatusEnum("status").notNull().default("AVAILABLE"),
    showInGallery: boolean("show_in_gallery").notNull().default(true),
    notes: text("notes"),
    // Edition fields
    isEdition: boolean("is_edition").notNull().default(false),
    editionNumber: integer("edition_number"),
    totalEditions: integer("total_editions"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // SKU must be unique within a tenant
    uniqueIndex("artwork_sku_tenant_idx").on(t.tenantId, t.sku),
    // Public browse only ever returns visible statuses. Keeping this partial
    // index ordered by the page's stable sort avoids scanning hidden artwork.
    index("artwork_public_browse_created_idx")
      .on(t.createdAt.desc().nullsFirst(), t.id.desc().nullsFirst())
      .where(
        sql`${t.showInGallery} = true AND ${t.status} IN ('AVAILABLE', 'SOLD', 'RESERVED')`,
      ),
    // Tenant catalog pages include every artwork, so this must not be partial.
    index("artwork_tenant_created_idx").on(
      t.tenantId,
      t.createdAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    // Contains-style searches on the public browse and tenant catalog pages.
    index("artwork_title_trgm_idx").using("gin", t.title.op("gin_trgm_ops")),
    index("artwork_sku_trgm_idx").using("gin", t.sku.op("gin_trgm_ops")),
    // Lets public artist-name matches retrieve the linked artwork efficiently.
    index("artwork_represented_artist_idx").on(t.representedArtistId),
  ],
);

export type Artwork = typeof artworksTable.$inferSelect;
export type InsertArtwork = typeof artworksTable.$inferInsert;
