CREATE TYPE "public"."tenant_type" AS ENUM('ARTIST', 'FRAMER');--> statement-breakpoint
CREATE TYPE "public"."artwork_condition" AS ENUM('EXCELLENT', 'GOOD', 'FAIR', 'POOR');--> statement-breakpoint
CREATE TYPE "public"."artwork_status" AS ENUM('AVAILABLE', 'SOLD', 'RESERVED', 'HIDDEN');--> statement-breakpoint
CREATE TYPE "public"."fulfillment_type" AS ENUM('SHIP', 'PICKUP', 'FRAMING_JOB');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('PENDING', 'PAID', 'FULFILLED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."inquiry_status" AS ENUM('NEW', 'HANDLED');--> statement-breakpoint
CREATE TABLE "tenant" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "tenant_type" NOT NULL,
	"business_name" text NOT NULL,
	"slug" text NOT NULL,
	"custom_domain" text,
	"custom_domain_verified" boolean DEFAULT false NOT NULL,
	"storefront_enabled" boolean DEFAULT true NOT NULL,
	"contact_email" text,
	"logo_url" text,
	"theme_color" text,
	"about_text" text,
	"location" text,
	"stripe_account_id" text,
	"stripe_charges_enabled" boolean,
	"stripe_payouts_enabled" boolean,
	"iframer_account_id" text,
	"iframer_account_linked_by" text,
	"iframer_account_linked_at" timestamp with time zone,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"subscription_status" text,
	"trial_end" timestamp with time zone,
	"billing_exempt" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_slug_unique" UNIQUE("slug"),
	CONSTRAINT "tenant_custom_domain_unique" UNIQUE("custom_domain"),
	CONSTRAINT "tenant_stripe_customer_id_unique" UNIQUE("stripe_customer_id"),
	CONSTRAINT "tenant_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id")
);
--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "tenant_user" (
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'owner' NOT NULL,
	CONSTRAINT "tenant_user_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "staff_invite" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'staff' NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_invite_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "represented_artist" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"bio" text,
	"commission_pct" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artwork" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"represented_artist_id" text,
	"title" text NOT NULL,
	"sku" text NOT NULL,
	"medium" text,
	"dimensions_w" integer,
	"dimensions_h" integer,
	"dimensions_d" integer,
	"condition" "artwork_condition",
	"price" integer,
	"status" "artwork_status" DEFAULT 'AVAILABLE' NOT NULL,
	"show_in_gallery" boolean DEFAULT true NOT NULL,
	"notes" text,
	"is_edition" boolean DEFAULT false NOT NULL,
	"edition_number" integer,
	"total_editions" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artwork_image" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artwork_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"object_path" text NOT NULL,
	"filename" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artwork_category" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artwork_category_on_artwork" (
	"artwork_id" text NOT NULL,
	"category_id" text NOT NULL,
	CONSTRAINT "artwork_category_on_artwork_artwork_id_category_id_pk" PRIMARY KEY("artwork_id","category_id")
);
--> statement-breakpoint
CREATE TABLE "order_item" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" text NOT NULL,
	"artwork_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"price_cents" integer NOT NULL,
	"artwork_title" text NOT NULL,
	"artwork_sku" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"stripe_session_id" text,
	"stripe_payment_intent_id" text,
	"buyer_email" text NOT NULL,
	"buyer_name" text,
	"status" "order_status" DEFAULT 'PENDING' NOT NULL,
	"fulfillment_type" "fulfillment_type" NOT NULL,
	"total_cents" integer NOT NULL,
	"application_fee_cents" integer,
	"tracking_note" text,
	"iframer_job_id" text,
	"iframer_job_error" text,
	"email_sent_at" timestamp with time zone,
	"email_error" text,
	"email_attempts" integer DEFAULT 0 NOT NULL,
	"email_last_attempt_at" timestamp with time zone,
	"email_failure_notified_at" timestamp with time zone,
	"status_email_queued_at" timestamp with time zone,
	"status_email_error" text,
	"status_email_attempts" integer DEFAULT 0 NOT NULL,
	"status_email_last_attempt_at" timestamp with time zone,
	"refunded_amount_cents" integer,
	"refunded_at" timestamp with time zone,
	"stripe_refund_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_stripe_session_id_unique" UNIQUE("stripe_session_id")
);
--> statement-breakpoint
CREATE TABLE "inquiry" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"artwork_id" text NOT NULL,
	"artwork_title" text NOT NULL,
	"buyer_name" text NOT NULL,
	"buyer_email" text NOT NULL,
	"message" text NOT NULL,
	"email_error" text,
	"status" "inquiry_status" DEFAULT 'NEW' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inquiry_reply" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"inquiry_id" text NOT NULL,
	"sent_by_user_id" text,
	"message" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit_event" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_alert" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stripe_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"customer_id" text,
	"subscription_id" text,
	"reason" text NOT NULL,
	"dismissed_at" timestamp with time zone,
	"slack_post_failed" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_alert_stripe_event_id_unique" UNIQUE("stripe_event_id")
);
--> statement-breakpoint
ALTER TABLE "tenant_user" ADD CONSTRAINT "tenant_user_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_user" ADD CONSTRAINT "tenant_user_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_invite" ADD CONSTRAINT "staff_invite_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "represented_artist" ADD CONSTRAINT "represented_artist_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artwork" ADD CONSTRAINT "artwork_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artwork" ADD CONSTRAINT "artwork_represented_artist_id_represented_artist_id_fk" FOREIGN KEY ("represented_artist_id") REFERENCES "public"."represented_artist"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artwork_image" ADD CONSTRAINT "artwork_image_artwork_id_artwork_id_fk" FOREIGN KEY ("artwork_id") REFERENCES "public"."artwork"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artwork_image" ADD CONSTRAINT "artwork_image_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artwork_category" ADD CONSTRAINT "artwork_category_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artwork_category_on_artwork" ADD CONSTRAINT "artwork_category_on_artwork_artwork_id_artwork_id_fk" FOREIGN KEY ("artwork_id") REFERENCES "public"."artwork"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artwork_category_on_artwork" ADD CONSTRAINT "artwork_category_on_artwork_category_id_artwork_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."artwork_category"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_order_id_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."order"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_artwork_id_artwork_id_fk" FOREIGN KEY ("artwork_id") REFERENCES "public"."artwork"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry" ADD CONSTRAINT "inquiry_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry" ADD CONSTRAINT "inquiry_artwork_id_artwork_id_fk" FOREIGN KEY ("artwork_id") REFERENCES "public"."artwork"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_reply" ADD CONSTRAINT "inquiry_reply_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_reply" ADD CONSTRAINT "inquiry_reply_inquiry_id_inquiry_id_fk" FOREIGN KEY ("inquiry_id") REFERENCES "public"."inquiry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_reply" ADD CONSTRAINT "inquiry_reply_sent_by_user_id_app_user_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artwork_sku_tenant_idx" ON "artwork" USING btree ("tenant_id","sku");--> statement-breakpoint
CREATE INDEX "rate_limit_event_key_created_at_idx" ON "rate_limit_event" USING btree ("key","created_at");--> statement-breakpoint
CREATE INDEX "stripe_alert_dismissed_at_created_at_idx" ON "stripe_alert" USING btree ("dismissed_at","created_at");