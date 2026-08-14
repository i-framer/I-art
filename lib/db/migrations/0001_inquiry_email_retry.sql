-- Add retry-tracking columns for the background inquiry notification email sweep.
-- email_attempts: counts every send attempt (initial + retries); default 0 so
--   existing rows are immediately eligible to be selected by the sweep.
-- email_last_attempt_at: timestamp of the most recent attempt (null = never tried
--   or initial send succeeded without recording an attempt).
ALTER TABLE "inquiry" ADD COLUMN "email_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inquiry" ADD COLUMN "email_last_attempt_at" timestamp with time zone;
