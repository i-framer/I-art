import {
  pgTable,
  text,
  boolean,
  timestamp,
  pgEnum,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tenantTypeEnum = pgEnum("tenant_type", ["ARTIST", "FRAMER"]);

export const tenantsTable = pgTable("tenant", {
  id: text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  type: tenantTypeEnum("type").notNull(),
  businessName: text("business_name").notNull(),
  slug: text("slug").notNull().unique(),
  customDomain: text("custom_domain").unique(),
  customDomainVerified: boolean("custom_domain_verified")
    .notNull()
    .default(false),
  storefrontEnabled: boolean("storefront_enabled").notNull().default(true),
  contactEmail: text("contact_email"),
  logoUrl: text("logo_url"),
  themeColor: text("theme_color"),
  aboutText: text("about_text"),
  stripeAccountId: text("stripe_account_id"),
  iframerAccountId: text("iframer_account_id"),
  // ── Platform subscription billing (charged by the platform account, not Connect) ──
  stripeCustomerId: text("stripe_customer_id").unique(),
  stripeSubscriptionId: text("stripe_subscription_id").unique(),
  /** Mirrors Stripe subscription status: active, trialing, past_due, canceled, ... */
  subscriptionStatus: text("subscription_status"),
  /** Manual comp flag — bypasses the paywall (future i-Framer premium bundle hook). */
  billingExempt: boolean("billing_exempt").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertTenantSchema = createInsertSchema(tenantsTable).omit({
  createdAt: true,
  updatedAt: true,
});
export type InsertTenant = z.infer<typeof insertTenantSchema>;
export type Tenant = typeof tenantsTable.$inferSelect;
