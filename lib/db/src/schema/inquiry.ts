import { pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenantsTable } from "./tenant";
import { artworksTable } from "./artwork";

export const inquiryStatusEnum = pgEnum("inquiry_status", ["NEW", "HANDLED"]);

export const inquiriesTable = pgTable("inquiry", {
  id: text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenantsTable.id),
  artworkId: text("artwork_id")
    .notNull()
    .references(() => artworksTable.id),
  artworkTitle: text("artwork_title").notNull(),
  buyerName: text("buyer_name").notNull(),
  buyerEmail: text("buyer_email").notNull(),
  message: text("message").notNull(),
  emailError: text("email_error"),
  status: inquiryStatusEnum("status").default("NEW").notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
