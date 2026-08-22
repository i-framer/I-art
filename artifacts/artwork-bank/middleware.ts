import { NextRequest, NextResponse } from "next/server";

const ADMIN_PATHS = ["/admin", "/dashboard", "/settings", "/orders", "/catalog"];

/**
 * Platform-owned domains — requests from these are never treated as custom domains.
 * Custom domains are anything else (e.g. www.janeart.com).
 */
const PLATFORM_DOMAIN_SUFFIXES = [
  ".replit.dev",
  ".replit.app",
  ".repl.co",
  ".vercel.app",
  "localhost",
  "127.0.0.1",
];

/**
 * Paths that should never be rewritten to /t/[slug]/...
 * even when the request comes from a custom domain.
 *
 * Critically, paths that already start with /t/ are skipped so that
 * internal storefront links (/t/[slug]/about) and Stripe return URLs
 * (/t/[slug]/order/success) are never double-rewritten. The underlying
 * Next.js routes work correctly on any domain — custom domains just provide
 * a cleaner root-path entry point.
 */
const CUSTOM_DOMAIN_PASSTHROUGH_PREFIXES = [
  "/_next/",
  "/api/",
  "/t/",          // already a tenant-prefixed path — skip to prevent double-rewrite
  "/favicon.ico",
  "/robots.txt",
  "/sitemap.xml",
];

/**
 * Exact-match paths that render on every domain (platform legal pages).
 * Matched exactly — "/terms-foo" or "/terms/x" are still rewritten normally.
 */
const CUSTOM_DOMAIN_PASSTHROUGH_EXACT = ["/terms", "/privacy"];

/** True when a path must never be rewritten to /t/[slug]/... */
function isPassthroughPath(pathname: string): boolean {
  return (
    CUSTOM_DOMAIN_PASSTHROUGH_EXACT.includes(pathname) ||
    CUSTOM_DOMAIN_PASSTHROUGH_PREFIXES.some((p) => pathname.startsWith(p))
  );
}

/** Host of the configured site URL (if any) — treated as a platform domain. */
function getConfiguredPlatformHost(): string | null {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  if (!siteUrl) return null;
  try {
    return new URL(siteUrl).hostname;
  } catch {
    return null;
  }
}

/**
 * Strip a leading "www." to get the registrable apex domain.
 * e.g. "www.i-art.com.au" → "i-art.com.au", "i-art.com.au" → "i-art.com.au".
 * Wildcard tenant subdomains always live under the apex, regardless of whether
 * NEXT_PUBLIC_SITE_URL was configured with or without the "www." prefix.
 */
function apexDomain(host: string): string {
  return host.startsWith("www.") ? host.slice(4) : host;
}

function isPlatformDomain(host: string): boolean {
  const configuredHost = getConfiguredPlatformHost();
  if (configuredHost) {
    const apex = apexDomain(configuredHost);
    // Match the exact configured host (e.g. www.i-art.com.au), its subdomains,
    // and the apex domain and its subdomains (covers *.i-art.com.au when
    // NEXT_PUBLIC_SITE_URL is set to https://www.i-art.com.au).
    if (
      host === configuredHost ||
      host.endsWith(`.${configuredHost}`) ||
      host === apex ||
      host.endsWith(`.${apex}`)
    ) {
      return true;
    }
  }
  if (process.env.VERCEL_URL && host === process.env.VERCEL_URL.split(":")[0]) {
    return true;
  }
  return PLATFORM_DOMAIN_SUFFIXES.some(
    (suffix) => host === suffix.replace(/^\./, "") || host.endsWith(suffix),
  );
}

function getInternalBaseUrl(): string {
  // Vercel production
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL;
  // Vercel preview
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  // Replit dev
  if (process.env.REPLIT_DEV_DOMAIN)
    return `https://${process.env.REPLIT_DEV_DOMAIN}`;
  // Local / self-hosted
  return `http://127.0.0.1:${process.env.PORT ?? 3000}`;
}

/**
 * Tenant subdomain of the configured platform host, e.g.
 * "jane.i-art.com.au" with NEXT_PUBLIC_SITE_URL=https://www.i-art.com.au → "jane".
 * Matches against the apex domain so this works whether NEXT_PUBLIC_SITE_URL
 * includes "www." or not. Returns null for the apex host, "www", and
 * multi-level subdomains.
 */
function getTenantSubdomain(host: string): string | null {
  const configuredHost = getConfiguredPlatformHost();
  if (!configuredHost) return null;
  const apex = apexDomain(configuredHost);
  if (!host.endsWith(`.${apex}`)) return null;
  const sub = host.slice(0, host.length - apex.length - 1);
  if (!sub || sub === "www" || sub.includes(".")) return null;
  return sub;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const host = (request.headers.get("host") ?? "").split(":")[0]; // strip port

  // ── 0. Tenant subdomain rewrite (wildcard *.platform-domain) ───────────────
  // e.g. jane.i-art.com.au/about → /t/jane/about
  const tenantSub = getTenantSubdomain(host);
  if (tenantSub && !isPassthroughPath(pathname)) {
    const rewriteUrl = request.nextUrl.clone();
    rewriteUrl.pathname =
      pathname === "/" ? `/t/${tenantSub}` : `/t/${tenantSub}${pathname}`;
    return NextResponse.rewrite(rewriteUrl);
  }

  // ── 1. Custom domain resolution ────────────────────────────────────────────
  // Only attempt for non-platform hosts and non-passthrough paths.
  if (!isPlatformDomain(host) && !isPassthroughPath(pathname)) {
    try {
      const baseUrl = getInternalBaseUrl();
      const lookupUrl = `${baseUrl}/api/tenant/by-domain?domain=${encodeURIComponent(host)}`;
      const res = await fetch(lookupUrl, {
        // Short timeout so a slow DB doesn't block every request
        signal: AbortSignal.timeout(3000),
        // Revalidate frequently — custom domain changes are uncommon
        next: { revalidate: 60 },
      });

      if (res.ok) {
        const { slug } = (await res.json()) as { slug: string };
        const rewriteUrl = request.nextUrl.clone();
        // e.g. "/" → "/t/jane-smith-studio", "/about" → "/t/jane-smith-studio/about"
        rewriteUrl.pathname =
          pathname === "/"
            ? `/t/${slug}`
            : `/t/${slug}${pathname}`;
        return NextResponse.rewrite(rewriteUrl);
      }
      // Only a definitive 404 means the domain isn't registered.
      // 5xx / gateway errors are operational failures — fall through so we
      // don't falsely tell a valid gallery's visitors the domain isn't registered.
      if (res.status === 404) {
        const notFoundUrl = request.nextUrl.clone();
        notFoundUrl.pathname = "/unknown-domain";
        return NextResponse.rewrite(notFoundUrl);
      }
    } catch {
      // Lookup timed out or network error — operational failure, not an unknown
      // domain. Fall through so Next.js serves whatever it can (or its own 404),
      // rather than falsely telling a valid gallery's visitors the domain isn't
      // registered.
    }
    return NextResponse.next();
  }

  // ── 2. Admin path session pre-check (platform domain only) ─────────────────
  const isAdminPath = ADMIN_PATHS.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );

  if (isAdminPath) {
    const sessionCookie = request.cookies.get("artwork_bank_session");
    if (!sessionCookie?.value) {
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("from", pathname);
      return NextResponse.redirect(loginUrl);
    }
  }

  return NextResponse.next();
}

export const config = {
  // Run on all paths except Next.js static assets
  matcher: ["/((?!_next/static|_next/image).*)", "/favicon.ico"],
};
