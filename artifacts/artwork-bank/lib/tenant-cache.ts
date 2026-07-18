import { cache } from "react";
import { db } from "@workspace/db";
import { tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

/**
 * React-cached tenant lookup — deduplicates across layout + page within a single request.
 */
export const getTenantBySlug = cache(async (slug: string) => {
  return db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.slug, slug),
  });
});

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
