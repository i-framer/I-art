import { pgTable, text, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenantsTable } from "./tenant";
import { artworksTable } from "./artwork";

export const artworkCategoriesTable = pgTable("artwork_category", {
  id: text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const artworkCategoryOnArtworkTable = pgTable(
  "artwork_category_on_artwork",
  {
    artworkId: text("artwork_id")
      .notNull()
      .references(() => artworksTable.id, { onDelete: "cascade" }),
    categoryId: text("category_id")
      .notNull()
      .references(() => artworkCategoriesTable.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.artworkId, t.categoryId] })],
);

export type ArtworkCategory = typeof artworkCategoriesTable.$inferSelect;
export type ArtworkCategoryOnArtwork =
  typeof artworkCategoryOnArtworkTable.$inferSelect;
