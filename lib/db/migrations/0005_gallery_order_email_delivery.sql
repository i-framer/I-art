ALTER TABLE "order" ADD COLUMN IF NOT EXISTS "gallery_order_email_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN IF NOT EXISTS "gallery_order_email_error" text;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN IF NOT EXISTS "gallery_order_email_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN IF NOT EXISTS "gallery_order_email_last_attempt_at" timestamp with time zone;