import {
  pgTable,
  text,
  boolean,
  timestamp,
  pgEnum,
  integer,
  index,
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
  /** Optional public location (e.g. suburb / state) shown on the storefront and used for discovery filters. */
  location: text("location"),
  stripeAccountId: text("stripe_account_id"),
  /**
   * Cached from Stripe account.updated webhook — true once the Connect account
   * can accept charges (onboarding complete, not restricted).  null means we
   * have never received an account.updated event for this account yet.
   */
  stripeChargesEnabled: boolean("stripe_charges_enabled"),
  /**
   * Cached from Stripe account.updated webhook — true once Stripe can send
   * payouts to the gallery's bank account.  null = not yet received.
   */
  stripePayoutsEnabled: boolean("stripe_payouts_enabled"),
  iframerAccountId: text("iframer_account_id"),
  /** Email of the platform admin who last linked or unlinked the i-Framer account. */
  iframerAccountLinkedBy: text("iframer_account_linked_by"),
  /** When the i-Framer account was last linked or unlinked by a platform admin. */
  iframerAccountLinkedAt: timestamp("iframer_account_linked_at", {
    withTimezone: true,
  }),
  /**
   * The i-Framer portal URL entered by the tenant during self-service verification.
   * Stored so it can be displayed back to the tenant and used for periodic re-checks.
   */
  iframerPortalUrl: text("iframer_portal_url"),
  /**
   * When the last i-Framer Premium verification succeeded.
   * Used to determine whether a re-check is needed (verification TTL is 24 h).
   * Null means the tenant has never been verified self-service.
   */
  iframerVerifiedAt: timestamp("iframer_verified_at", { withTimezone: true }),
  /**
   * Per-tenant platform commission override in basis points (hundredths of a percent).
   * e.g. 500 = 5.00 %, 350 = 3.50 %.
   * Null means use the global PLATFORM_FEE_PERCENT env var default.
   * Set to 350 when an i-Framer Premium subscription is verified; cleared when it lapses.
   */
  commissionBasisPoints: integer("commission_basis_points"),
  /**
   * Set when the Slack audit notification for an i-Framer account link/unlink
   * failed (auth error, network error, etc.). Null means the notification
   * either succeeded or Slack is not configured.
   * Cleared automatically when the replay succeeds.
   */
  iframerSlackPostFailed: timestamp("iframer_slack_post_failed", {
    withTimezone: true,
  }),
  /**
   * JSON-encoded payload stored alongside iframerSlackPostFailed so the
   * replay action can reconstruct the exact notification:
   * { action: "linked"|"unlinked", accountId: string|null, adminEmail: string|undefined }
   */
  iframerSlackFailedPayload: text("iframer_slack_failed_payload"),
  // ── Platform subscription billing (charged by the platform account, not Connect) ──
  stripeCustomerId: text("stripe_customer_id").unique(),
  stripeSubscriptionId: text("stripe_subscription_id").unique(),
  /** Mirrors Stripe subscription status: active, trialing, past_due, canceled, ... */
  subscriptionStatus: text("subscription_status"),
  /** When the Stripe trial ends (from customer.subscription.* webhooks); null when not trialing. */
  trialEnd: timestamp("trial_end", { withTimezone: true }),
  /** Manual comp flag — bypasses the paywall (future i-Framer premium bundle hook). */
  billingExempt: boolean("billing_exempt").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (t) => [
  index("tenant_business_name_trgm_idx").using("gin", t.businessName.op("gin_trgm_ops")),
]);

export const insertTenantSchema = createInsertSchema(tenantsTable).omit({
  createdAt: true,
  updatedAt: true,
});
export type InsertTenant = z.infer<typeof insertTenantSchema>;
export type Tenant = typeof tenantsTable.$inferSelect;
