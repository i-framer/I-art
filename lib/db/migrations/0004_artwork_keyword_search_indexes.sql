-- The 0003 performance indexes are already deployed. Keep the search rollout
-- separate so existing environments receive these additive indexes as well.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "artwork_title_trgm_idx" ON "artwork" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "artwork_sku_trgm_idx" ON "artwork" USING gin ("sku" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "artwork_represented_artist_idx" ON "artwork" USING btree ("represented_artist_id");--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "represented_artist_name_trgm_idx" ON "represented_artist" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "tenant_business_name_trgm_idx" ON "tenant" USING gin ("business_name" gin_trgm_ops);