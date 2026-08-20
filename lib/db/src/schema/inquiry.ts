import { pgEnum, pgTable, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenantsTable } from "./tenant";
import { artworksTable } from "./artwork";

export const inquiryStatusEnum = pgEnum("inquiry_status", ["NEW", "HANDLED"]);

export const inquiriesTable = pgTable(
  "inquiry",
  {
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
    // Automatic retry bookkeeping for the background inquiry email sweep.
    // emailAttempts counts every send attempt (initial + retries).
    emailAttempts: integer("email_attempts").default(0).notNull(),
    emailLastAttemptAt: timestamp("email_last_attempt_at", { withTimezone: true }),
    // Set to a UUID when the sweep atomically claims a row for delivery; cleared
    // to null on success or failure.  requeueNoContactEmailInquiries and other
    // requeue helpers skip rows where this is non-null so a concurrent requeue
    // cannot make an in-flight claimed row re-claimable (which would allow a
    // second sweep pass to double-send the same inquiry email).
    emailClaimNonce: text("email_claim_nonce"),
    status: inquiryStatusEnum("status").default("NEW").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("inquiry_tenant_created_idx").on(
      t.tenantId,
      t.createdAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    index("inquiry_email_retry_idx")
      .on(t.id)
      .where(
        sql`${t.emailError} IS NOT NULL AND ${t.emailAttempts} < 5 AND ${t.archivedAt} IS NULL`,
      ),
  ],
);
