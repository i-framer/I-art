-- Index the query predicates used by browse, tenant administration, background
-- email retries, and order-item lookups.  Retry indexes are partial because
-- only the active candidate rows are scanned by each sweep.
CREATE INDEX "artwork_public_browse_created_idx" ON "artwork" USING btree ("created_at" DESC NULLS FIRST, "id" DESC NULLS FIRST) WHERE "show_in_gallery" = true AND "status" IN ('AVAILABLE', 'SOLD', 'RESERVED');--> statement-breakpoint
CREATE INDEX "artwork_tenant_created_idx" ON "artwork" USING btree ("tenant_id", "created_at" DESC NULLS FIRST, "id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "order_tenant_created_idx" ON "order" USING btree ("tenant_id", "created_at" DESC NULLS FIRST, "id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "order_confirmation_retry_idx" ON "order" USING btree ("id") WHERE "status" = 'PAID' AND "email_sent_at" IS NULL AND "buyer_email" IS NOT NULL AND "buyer_email" <> '' AND "email_attempts" < 5;--> statement-breakpoint
CREATE INDEX "order_gallery_alert_retry_idx" ON "order" USING btree ("id") WHERE "email_attempts" >= 5 AND "email_failure_notified_at" IS NULL AND "buyer_email" IS NOT NULL AND "buyer_email" <> '';--> statement-breakpoint
CREATE INDEX "order_status_email_retry_idx" ON "order" USING btree ("id") WHERE "status_email_queued_at" IS NOT NULL AND "buyer_email" IS NOT NULL AND "buyer_email" <> '' AND "status_email_attempts" < 5;--> statement-breakpoint
CREATE INDEX "order_item_order_id_idx" ON "order_item" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "inquiry_tenant_created_idx" ON "inquiry" USING btree ("tenant_id", "created_at" DESC NULLS FIRST, "id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "inquiry_email_retry_idx" ON "inquiry" USING btree ("id") WHERE "email_error" IS NOT NULL AND "email_attempts" < 5 AND "archived_at" IS NULL;