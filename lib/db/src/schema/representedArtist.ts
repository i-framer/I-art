import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenantsTable } from "./tenant";

/**
 * Represented artists — used by FRAMER tenants to track consignment artists.
 * The commissionPct field is stored as an integer (e.g. 25 = 25%).
 */
export const representedArtistsTable = pgTable("represented_artist", {
  id: text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  bio: text("bio"),
  commissionPct: integer("commission_pct").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type RepresentedArtist = typeof representedArtistsTable.$inferSelect;
export type InsertRepresentedArtist =
  typeof representedArtistsTable.$inferInsert;
