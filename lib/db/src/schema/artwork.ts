import {
  pgTable,
  text,
  boolean,
  integer,
  timestamp,
  pgEnum,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenantsTable } from "./tenant";
import { representedArtistsTable } from "./representedArtist";

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
  ],
);

export type Artwork = typeof artworksTable.$inferSelect;
export type InsertArtwork = typeof artworksTable.$inferInsert;
