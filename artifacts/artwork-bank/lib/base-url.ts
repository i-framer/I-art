/**
 * Resolves the public base URL for links embedded in outgoing emails (and any
 * other externally-visible URLs). Priority:
 *
 * 1. NEXT_PUBLIC_SITE_URL   — explicit production/custom site URL
 * 2. VERCEL_URL             — Vercel preview/production
 * 3. REPLIT_DOMAINS (first) — the published Replit deployment domain
 * 4. REPLIT_DEV_DOMAIN      — Replit development workspace (fallback)
 *
 * For tenant-scoped links, a verified custom domain takes precedence over the
 * platform domain (custom-domain hosts are rewritten by the middleware, so
 * paths must NOT include the /t/<slug> prefix there).
 */

/** Platform-level base URL, e.g. "https://example.com" — or null if unknown. */
export function getPlatformBaseUrl(): string | null {
  if (process.env.NEXT_PUBLIC_SITE_URL) {
    return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
  }
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  const replitDomain = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  if (replitDomain) return `https://${replitDomain}`;
  if (process.env.REPLIT_DEV_DOMAIN) {
    return `https://${process.env.REPLIT_DEV_DOMAIN}`;
  }
  return null;
}

export interface TenantDomainInfo {
  slug: string;
  customDomain?: string | null;
  customDomainVerified?: boolean | null;
}

/**
 * Absolute URL for a tenant-scoped path, or undefined if no base URL can be
 * resolved. `path` is relative to the tenant root (e.g. "/orders" or
 * "/<artworkId>") and must start with "/" or be empty.
 *
 * - Verified custom domain:  https://<customDomain><path>
 * - Otherwise:               <platformBase>/t/<slug><path>
 */
export function getTenantUrl(
  tenant: TenantDomainInfo,
  path = "",
): string | undefined {
  if (tenant.customDomain && tenant.customDomainVerified) {
    return `https://${tenant.customDomain}${path}`;
  }
  const base = getPlatformBaseUrl();
  if (!base) return undefined;
  return `${base}/t/${tenant.slug}${path}`;
}
