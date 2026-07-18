import { pgTable, text, boolean, integer, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { artworksTable } from "./artwork";
import { tenantsTable } from "./tenant";

export const artworkImagesTable = pgTable("artwork_image", {
  id: text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  artworkId: text("artwork_id")
    .notNull()
    .references(() => artworksTable.id, { onDelete: "cascade" }),
  // Denormalised for efficient tenant-scoped queries without a join
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  // Path stored as returned by GCS presigned upload (e.g. /objects/uploads/uuid)
  objectPath: text("object_path").notNull(),
  filename: text("filename").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  isPrimary: boolean("is_primary").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ArtworkImage = typeof artworkImagesTable.$inferSelect;
export type InsertArtworkImage = typeof artworkImagesTable.$inferInsert;
