CREATE TABLE IF NOT EXISTS "freight_carrier_account_access" (
  "tenant_id" text NOT NULL REFERENCES "tenant"("id") ON DELETE CASCADE,
  "carrier_account_id" text NOT NULL REFERENCES "freight_carrier_account"("id") ON DELETE CASCADE,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("tenant_id", "carrier_account_id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "freight_carrier_account_access_account_idx"
  ON "freight_carrier_account_access" ("carrier_account_id", "enabled");--> statement-breakpoint

-- Existing gallery credentials cannot remain an active quote source after the
-- platform-ownership cutover. Keep the rows for audit/history, but disable
-- them so an administrator can deliberately re-enter them as platform-owned
-- accounts rather than silently using unreviewed credentials.
UPDATE "freight_carrier_account"
  SET "enabled" = false, "updated_at" = now()
  WHERE "owner" = 'GALLERY' AND "enabled" = true;--> statement-breakpoint

ALTER TABLE "artwork"
  ADD COLUMN IF NOT EXISTS "packaging_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

ALTER TABLE "freight_quote"
  ADD COLUMN IF NOT EXISTS "packaging_cents" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "delivery_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "freight_quote"
  SET "delivery_cents" = "freight_cents"
  WHERE "delivery_cents" = 0;--> statement-breakpoint

ALTER TABLE "order"
  ADD COLUMN IF NOT EXISTS "packaging_cents" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "delivery_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "order"
  SET "delivery_cents" = "freight_cents"
  WHERE "delivery_cents" = 0;