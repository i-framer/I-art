/**
 * Locks in the wildcard tenant-subdomain routing in middleware.ts:
 * {slug}.i-art.com.au → /t/{slug}, driven by NEXT_PUBLIC_SITE_URL.
 *
 * Covers: apex host (no rewrite), www (no rewrite), single-level subdomain
 * (rewrites, incl. nested paths), multi-level subdomain (no rewrite),
 * passthrough prefixes (/api/, /_next/, /t/) never rewritten, and behavior
 * when NEXT_PUBLIC_SITE_URL is unset.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "../middleware";

const SITE_URL = "https://i-art.com.au";

function makeRequest(host: string, path = "/"): NextRequest {
  return new NextRequest(`https://${host}${path}`, {
    headers: { host },
  });
}

/** Extract the rewrite target pathname from a middleware response, if any. */
function rewrittenPath(res: Response): string | null {
  const target = res.headers.get("x-middleware-rewrite");
  return target ? new URL(target).pathname : null;
}

describe("tenant subdomain rewrite", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    process.env.NEXT_PUBLIC_SITE_URL = SITE_URL;
    // Ensure the custom-domain lookup branch never actually fetches
    delete process.env.VERCEL_URL;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network disabled in test");
      }),
    );
  });

  afterEach(() => {
    process.env = { ...origEnv };
    vi.unstubAllGlobals();
  });

  it("rewrites a single-level subdomain root to /t/{slug}", async () => {
    const res = await middleware(makeRequest("jane.i-art.com.au", "/"));
    expect(rewrittenPath(res)).toBe("/t/jane");
  });

  it("rewrites nested paths under a subdomain", async () => {
    const res = await middleware(makeRequest("jane.i-art.com.au", "/about"));
    expect(rewrittenPath(res)).toBe("/t/jane/about");

    const deep = await middleware(
      makeRequest("jane.i-art.com.au", "/artwork/123"),
    );
    expect(rewrittenPath(deep)).toBe("/t/jane/artwork/123");
  });

  it("strips the port before matching the host", async () => {
    const req = new NextRequest("https://jane.i-art.com.au:8443/", {
      headers: { host: "jane.i-art.com.au:8443" },
    });
    const res = await middleware(req);
    expect(rewrittenPath(res)).toBe("/t/jane");
  });

  it("does not rewrite the apex host", async () => {
    const res = await middleware(makeRequest("i-art.com.au", "/"));
    expect(rewrittenPath(res)).toBeNull();
  });

  it("does not rewrite www", async () => {
    const res = await middleware(makeRequest("www.i-art.com.au", "/"));
    expect(rewrittenPath(res)).toBeNull();
  });

  it("does not rewrite multi-level subdomains", async () => {
    const res = await middleware(makeRequest("a.b.i-art.com.au", "/"));
    expect(rewrittenPath(res)).toBeNull();
  });

  it("does not treat a lookalike host as a subdomain", async () => {
    // Ends with "i-art.com.au" but not ".i-art.com.au" — not a platform host,
    // so it falls to the custom-domain branch (fetch disabled → no rewrite).
    const res = await middleware(makeRequest("evil-i-art.com.au", "/"));
    expect(rewrittenPath(res)).toBeNull();
  });

  it.each(["/api/tenant/by-domain", "/_next/webpack-hmr", "/t/jane/about"])(
    "never rewrites passthrough path %s on a tenant subdomain",
    async (path) => {
      const res = await middleware(makeRequest("jane.i-art.com.au", path));
      expect(rewrittenPath(res)).toBeNull();
    },
  );

  it.each(["/favicon.ico", "/robots.txt", "/sitemap.xml"])(
    "never rewrites well-known file %s on a tenant subdomain",
    async (path) => {
      const res = await middleware(makeRequest("jane.i-art.com.au", path));
      expect(rewrittenPath(res)).toBeNull();
    },
  );

  describe("when NEXT_PUBLIC_SITE_URL is unset", () => {
    beforeEach(() => {
      delete process.env.NEXT_PUBLIC_SITE_URL;
    });

    it("does not rewrite what would otherwise be a tenant subdomain", async () => {
      // Not a platform host anymore → custom-domain branch; fetch is disabled,
      // so the middleware must fall through without a rewrite.
      const res = await middleware(makeRequest("jane.i-art.com.au", "/"));
      expect(rewrittenPath(res)).toBeNull();
    });

    it("does not rewrite the apex host either", async () => {
      const res = await middleware(makeRequest("i-art.com.au", "/"));
      expect(rewrittenPath(res)).toBeNull();
    });
  });

  it("handles an invalid NEXT_PUBLIC_SITE_URL without rewriting", async () => {
    process.env.NEXT_PUBLIC_SITE_URL = "not a url";
    const res = await middleware(makeRequest("jane.i-art.com.au", "/"));
    expect(rewrittenPath(res)).toBeNull();
  });
});
