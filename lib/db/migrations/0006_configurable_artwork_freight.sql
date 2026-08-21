CREATE TYPE "freight_class" AS ENUM ('SMALL', 'MEDIUM', 'LARGE', 'TUBE');--> statement-breakpoint
CREATE TYPE "artwork_shipping_format" AS ENUM ('STANDARD', 'TUBE');--> statement-breakpoint

ALTER TABLE "artwork"
  ADD COLUMN IF NOT EXISTS "shipping_format" "artwork_shipping_format" DEFAULT 'STANDARD' NOT NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "freight_settings" (
  "tenant_id" text PRIMARY KEY NOT NULL REFERENCES "tenant"("id") ON DELETE CASCADE,
  "small_max_mm" integer DEFAULT 800 NOT NULL,
  "medium_max_mm" integer DEFAULT 1500 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "freight_method" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" text NOT NULL REFERENCES "tenant"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "small_cents" integer DEFAULT 0 NOT NULL,
  "medium_cents" integer DEFAULT 0 NOT NULL,
  "large_cents" integer DEFAULT 0 NOT NULL,
  "tube_cents" integer DEFAULT 0 NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "freight_method_tenant_idx" ON "freight_method" ("tenant_id");--> statement-breakpoint

ALTER TABLE "order"
  ADD COLUMN IF NOT EXISTS "freight_method_name" text,
  ADD COLUMN IF NOT EXISTS "freight_class" "freight_class",
  ADD COLUMN IF NOT EXISTS "freight_cents" integer DEFAULT 0 NOT NULL;