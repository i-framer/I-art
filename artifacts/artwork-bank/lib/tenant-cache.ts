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

import { getPlatformBaseUrl } from "./base-url";

/**
 * The CNAME target tenants must point their domain to.
 *
 * Priority:
 * 1. CNAME_TARGET env var — explicit override (e.g. a dedicated cname host)
 * 2. The host of the platform's configured base URL (see lib/base-url.ts)
 * 3. null — no target can be resolved; the settings UI should prompt the
 *    operator to configure CNAME_TARGET instead of showing a wrong host.
 */
export function getCnameTarget(): string | null {
  const explicit = process.env.CNAME_TARGET?.trim();
  if (explicit) return explicit.toLowerCase().replace(/\.$/, "");

  const base = getPlatformBaseUrl();
  if (!base) return null;
  try {
    return new URL(base).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// Re-export pure formatting utilities so existing server-component imports
// continue to work without pulling the DB into client bundles.
export { formatPrice, formatDimensions } from "./format";
