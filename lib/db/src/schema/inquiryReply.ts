import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenantsTable } from "./tenant";
import { inquiriesTable } from "./inquiry";
import { usersTable } from "./user";

export const inquiryRepliesTable = pgTable("inquiry_reply", {
  id: text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenantsTable.id),
  inquiryId: text("inquiry_id")
    .notNull()
    .references(() => inquiriesTable.id),
  sentByUserId: text("sent_by_user_id").references(() => usersTable.id),
  message: text("message").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
});
