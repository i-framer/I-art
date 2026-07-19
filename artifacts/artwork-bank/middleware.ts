import { NextRequest, NextResponse } from "next/server";

const ADMIN_PATHS = ["/dashboard", "/settings", "/orders", "/catalog"];

/**
 * Platform-owned domains — requests from these are never treated as custom domains.
 * Custom domains are anything else (e.g. www.janeart.com).
 */
const PLATFORM_DOMAIN_SUFFIXES = [
  ".replit.dev",
  ".replit.app",
  ".repl.co",
  "localhost",
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

function isPlatformDomain(host: string): boolean {
  const configuredHost = getConfiguredPlatformHost();
  if (
    configuredHost &&
    (host === configuredHost || host.endsWith(`.${configuredHost}`))
  ) {
    return true;
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

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const host = (request.headers.get("host") ?? "").split(":")[0]; // strip port

  // ── 1. Custom domain resolution ────────────────────────────────────────────
  // Only attempt for non-platform hosts and non-passthrough paths.
  if (
    !isPlatformDomain(host) &&
    !CUSTOM_DOMAIN_PASSTHROUGH_PREFIXES.some((p) => pathname.startsWith(p))
  ) {
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
    } catch {
      // DNS lookup timed out or lookup API unavailable — fall through to 404
    }
    // Unknown custom domain: let Next.js serve a 404
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
