import {
  pgTable,
  text,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenantsTable } from "./tenant";
import { artworksTable } from "./artwork";

/**
 * Certificates of Authenticity (COA) — Task #83
 *
 * Each row represents one issued certificate. Certificate numbers are
 * unique within a tenant and formatted as CERT-{YEAR}-{SEQ} where SEQ is
 * the tenant-scoped sequential issue count (1, 2, 3 …).
 *
 * The certificateSeq column is the raw sequential integer; certificateNumber
 * is the formatted human-readable string stored for display and PDF rendering.
 */
export const certificatesTable = pgTable(
  "certificate",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    artworkId: text("artwork_id")
      .notNull()
      .references(() => artworksTable.id, { onDelete: "restrict" }),
    /** Formatted number, e.g. "CERT-2026-0001". Unique per tenant. */
    certificateNumber: text("certificate_number").notNull(),
    /** Raw sequence integer for the formatted number above. Unique per tenant. */
    certificateSeq: integer("certificate_seq").notNull(),
    /** Optional — the buyer this certificate was issued to. */
    buyerName: text("buyer_name"),
    issuedAt: timestamp("issued_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Certificate number unique within a tenant
    uniqueIndex("certificate_number_tenant_idx").on(
      t.tenantId,
      t.certificateNumber,
    ),
    // Seq unique within a tenant (guards against races)
    uniqueIndex("certificate_seq_tenant_idx").on(t.tenantId, t.certificateSeq),
  ],
);

export type Certificate = typeof certificatesTable.$inferSelect;
export type InsertCertificate = typeof certificatesTable.$inferInsert;
