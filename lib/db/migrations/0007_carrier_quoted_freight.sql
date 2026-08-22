CREATE TYPE "freight_carrier_provider" AS ENUM ('AUSTRALIA_POST', 'ARAMEX');--> statement-breakpoint
CREATE TYPE "freight_carrier_owner" AS ENUM ('GALLERY', 'PLATFORM');--> statement-breakpoint
CREATE TYPE "freight_quote_source" AS ENUM ('LIVE', 'MANUAL');--> statement-breakpoint

ALTER TABLE "freight_settings"
  ADD COLUMN IF NOT EXISTS "origin_address_line1" text,
  ADD COLUMN IF NOT EXISTS "origin_address_line2" text,
  ADD COLUMN IF NOT EXISTS "origin_suburb" text,
  ADD COLUMN IF NOT EXISTS "origin_state" text,
  ADD COLUMN IF NOT EXISTS "origin_postcode" text,
  ADD COLUMN IF NOT EXISTS "origin_country_code" text DEFAULT 'AU' NOT NULL;--> statement-breakpoint

ALTER TABLE "artwork"
  ADD COLUMN IF NOT EXISTS "package_length_mm" integer,
  ADD COLUMN IF NOT EXISTS "package_width_mm" integer,
  ADD COLUMN IF NOT EXISTS "package_height_mm" integer,
  ADD COLUMN IF NOT EXISTS "packed_weight_grams" integer;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "freight_carrier_account" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" text REFERENCES "tenant"("id") ON DELETE CASCADE,
  "owner" "freight_carrier_owner" DEFAULT 'GALLERY' NOT NULL,
  "provider" "freight_carrier_provider" NOT NULL,
  "label" text NOT NULL,
  "credentials_ciphertext" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "freight_carrier_account_tenant_idx"
  ON "freight_carrier_account" ("tenant_id", "enabled");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "freight_carrier_account_provider_owner_idx"
  ON "freight_carrier_account" ("provider", "owner");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "freight_quote" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" text NOT NULL REFERENCES "tenant"("id") ON DELETE CASCADE,
  "artwork_id" text NOT NULL,
  "carrier_account_id" text REFERENCES "freight_carrier_account"("id") ON DELETE SET NULL,
  "freight_method_id" text REFERENCES "freight_method"("id") ON DELETE SET NULL,
  "source" "freight_quote_source" NOT NULL,
  "provider" text NOT NULL,
  "service_code" text,
  "service_name" text NOT NULL,
  "freight_class" "freight_class",
  "freight_cents" integer NOT NULL,
  "destination_line1" text NOT NULL,
  "destination_line2" text,
  "destination_suburb" text NOT NULL,
  "destination_state" text NOT NULL,
  "destination_postcode" text NOT NULL,
  "destination_country_code" text NOT NULL,
  "package_length_mm" integer NOT NULL,
  "package_width_mm" integer NOT NULL,
  "package_height_mm" integer NOT NULL,
  "packed_weight_grams" integer NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "freight_quote_tenant_artwork_expiry_idx"
  ON "freight_quote" ("tenant_id", "artwork_id", "expires_at");--> statement-breakpoint

ALTER TABLE "order"
  ADD COLUMN IF NOT EXISTS "freight_provider" text,
  ADD COLUMN IF NOT EXISTS "freight_service_code" text,
  ADD COLUMN IF NOT EXISTS "freight_quote_id" text,
  ADD COLUMN IF NOT EXISTS "shipping_address_json" text;