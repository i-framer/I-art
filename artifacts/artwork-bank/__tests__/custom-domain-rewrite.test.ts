/**
 * Locks in the custom-domain routing branch of middleware.ts:
 * an arbitrary host (e.g. www.janeart.com) is looked up via
 * /api/tenant/by-domain and rewritten to /t/{slug}.
 *
 * Covers: known custom domain rewrites root and nested paths, unknown domain
 * falls through to 404, lookup timeout/failure falls through without crashing,
 * passthrough prefixes (/api/, /_next/, /t/) never rewritten, and platform
 * hosts (replit.dev, vercel.app, configured site host) never trigger a lookup.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "../middleware";

const SITE_URL = "https://i-art.com.au";
const CUSTOM_HOST = "www.janeart.com";

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

/** fetch mock that resolves the lookup with a slug. */
function mockLookupSuccess(slug: string) {
  const fetchMock = vi.fn(async (..._args: unknown[]) => ({
    ok: true,
    json: async () => ({ slug }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** fetch mock that returns a non-OK response (unknown domain). */
function mockLookupNotFound() {
  const fetchMock = vi.fn(async () => ({
    ok: false,
    status: 404,
    json: async () => ({ error: "not found" }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** fetch mock that rejects (timeout / network failure). */
function mockLookupFailure(error: Error) {
  const fetchMock = vi.fn(async () => {
    throw error;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("custom domain rewrite", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    process.env.NEXT_PUBLIC_SITE_URL = SITE_URL;
    delete process.env.VERCEL_URL;
  });

  afterEach(() => {
    process.env = { ...origEnv };
    vi.unstubAllGlobals();
  });

  describe("known custom domain", () => {
    it("rewrites the root path to /t/{slug}", async () => {
      const fetchMock = mockLookupSuccess("jane-smith-studio");
      const res = await middleware(makeRequest(CUSTOM_HOST, "/"));
      expect(rewrittenPath(res)).toBe("/t/jane-smith-studio");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const calledUrl = String(fetchMock.mock.calls[0][0]);
      expect(calledUrl).toContain("/api/tenant/by-domain");
      expect(calledUrl).toContain(encodeURIComponent(CUSTOM_HOST));
    });

    it("rewrites nested paths, preserving the path", async () => {
      mockLookupSuccess("jane-smith-studio");
      const about = await middleware(makeRequest(CUSTOM_HOST, "/about"));
      expect(rewrittenPath(about)).toBe("/t/jane-smith-studio/about");

      mockLookupSuccess("jane-smith-studio");
      const deep = await middleware(makeRequest(CUSTOM_HOST, "/artwork/123"));
      expect(rewrittenPath(deep)).toBe("/t/jane-smith-studio/artwork/123");
    });

    it("strips the port from the host before lookup", async () => {
      const fetchMock = mockLookupSuccess("jane-smith-studio");
      const req = new NextRequest(`https://${CUSTOM_HOST}:8443/`, {
        headers: { host: `${CUSTOM_HOST}:8443` },
      });
      const res = await middleware(req);
      expect(rewrittenPath(res)).toBe("/t/jane-smith-studio");
      const calledUrl = String(fetchMock.mock.calls[0][0]);
      expect(calledUrl).toContain(encodeURIComponent(CUSTOM_HOST));
      expect(calledUrl).not.toContain("8443");
    });
  });

  describe("unknown custom domain", () => {
    it("rewrites to /unknown-domain when the lookup returns not-found", async () => {
      const fetchMock = mockLookupNotFound();
      const res = await middleware(makeRequest("unknown.example.com", "/"));
      expect(rewrittenPath(res)).toBe("/unknown-domain");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("lookup service errors (non-404 non-OK responses)", () => {
    it.each([500, 502, 503, 504])(
      "falls through without a rewrite when the lookup returns %i",
      async (status) => {
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => ({ ok: false, status, json: async () => ({}) })),
        );
        const res = await middleware(makeRequest(CUSTOM_HOST, "/"));
        expect(rewrittenPath(res)).toBeNull();
      },
    );
  });

  describe("lookup failures", () => {
    it("falls through without crashing when the lookup times out", async () => {
      mockLookupFailure(
        Object.assign(new Error("The operation was aborted"), {
          name: "TimeoutError",
        }),
      );
      const res = await middleware(makeRequest(CUSTOM_HOST, "/"));
      expect(rewrittenPath(res)).toBeNull();
    });

    it("falls through without crashing on a network error", async () => {
      mockLookupFailure(new Error("fetch failed"));
      const res = await middleware(makeRequest(CUSTOM_HOST, "/about"));
      expect(rewrittenPath(res)).toBeNull();
    });

    it("falls through without crashing when the response body is invalid JSON", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          json: async () => {
            throw new Error("invalid json");
          },
        })),
      );
      const res = await middleware(makeRequest(CUSTOM_HOST, "/"));
      expect(rewrittenPath(res)).toBeNull();
    });
  });

  describe("passthrough prefixes on a custom domain", () => {
    it.each([
      "/api/tenant/by-domain",
      "/_next/webpack-hmr",
      "/t/jane/about",
      "/favicon.ico",
      "/robots.txt",
      "/sitemap.xml",
    ])("never rewrites %s and never triggers a lookup", async (path) => {
      const fetchMock = mockLookupSuccess("jane-smith-studio");
      const res = await middleware(makeRequest(CUSTOM_HOST, path));
      expect(rewrittenPath(res)).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("platform hosts never trigger a custom-domain lookup", () => {
    it.each([
      "myapp.replit.dev",
      "myapp.replit.app",
      "myapp.repl.co",
      "myapp.vercel.app",
      "localhost",
      "i-art.com.au", // configured site host
      "www.i-art.com.au", // subdomain of the configured host
    ])("does not look up %s", async (host) => {
      const fetchMock = mockLookupSuccess("should-not-be-used");
      const res = await middleware(makeRequest(host, "/"));
      expect(rewrittenPath(res)).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not look up the VERCEL_URL host", async () => {
      process.env.VERCEL_URL = "my-preview.vercel-deploy.example";
      const fetchMock = mockLookupSuccess("should-not-be-used");
      const res = await middleware(
        makeRequest("my-preview.vercel-deploy.example", "/"),
      );
      expect(rewrittenPath(res)).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
