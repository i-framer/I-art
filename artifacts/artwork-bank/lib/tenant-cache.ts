import { cache } from "react";
import { db } from "@workspace/db";
import { tenantsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

/**
 * React-cached tenant lookup by slug — deduplicates across layout + page within a request.
 */
export const getTenantBySlug = cache(async (slug: string) => {
  return db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.slug, slug),
  });
});

/**
 * React-cached tenant lookup by verified custom domain.
 * Used by storefront routes when the request arrived via a custom domain
 * and was rewritten by the middleware.
 */
export const getTenantByCustomDomain = cache(async (domain: string) => {
  return db.query.tenantsTable.findFirst({
    where: and(
      eq(tenantsTable.customDomain, domain.toLowerCase()),
      eq(tenantsTable.customDomainVerified, true),
    ),
  });
});

/** The CNAME target tenants must point their domain to. */
export const CNAME_TARGET =
  process.env.CNAME_TARGET ?? "cname.i-art.com.au";

/**
 * Format a price stored in cents into a display string (AUD).
 */
export function formatPrice(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-AU", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Format dimensions in mm into a readable string (e.g. "900 × 600 mm").
 */
export function formatDimensions(
  w: number | null,
  h: number | null,
  d: number | null,
): string | null {
  if (!w && !h) return null;
  const parts = [w, h].filter(Boolean).map((v) => `${v}`);
  if (d) parts.push(`${d}`);
  return parts.join(" × ") + " mm";
}
