/**
 * Middleware unit tests — custom domain routing.
 *
 * Verifies that:
 *  - A request from an unrecognised custom domain (tenant lookup → 404) is
 *    rewritten to /unknown-domain rather than producing a raw Next.js error.
 *  - A request from a recognised custom domain (lookup → 200 + slug) is
 *    rewritten to /t/[slug].
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// Import after vitest globals are set up.
import { middleware } from "@/middleware";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(host: string, pathname = "/"): NextRequest {
  const url = new URL(`http://${host}${pathname}`);
  return new NextRequest(url, { headers: { host } });
}

/** Extract the rewrite destination from the response headers. */
function rewriteTarget(response: Response): string | null {
  return response.headers.get("x-middleware-rewrite");
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("middleware — custom domain routing", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear platform-URL env vars so getInternalBaseUrl() returns the local
    // fallback (http://127.0.0.1:<PORT>), keeping the test self-contained.
    delete process.env.NEXT_PUBLIC_SITE_URL;
    delete process.env.VERCEL_URL;
    delete process.env.REPLIT_DEV_DOMAIN;
    process.env.PORT = "3000";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Restore original env
    Object.assign(process.env, originalEnv);
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
  });

  // ── Unknown domain ────────────────────────────────────────────────────────

  it("rewrites an unrecognised custom domain to /unknown-domain", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({}),
      }),
    );

    const req = makeRequest("www.unknowngallery.com");
    const res = await middleware(req);

    const target = rewriteTarget(res);
    expect(target).not.toBeNull();
    expect(target).toMatch(/\/unknown-domain/);
  });

  it("passes the correct domain to the tenant lookup endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    await middleware(makeRequest("some-gallery.art"));

    expect(fetchMock).toHaveBeenCalledOnce();
    const calledUrl: string = fetchMock.mock.calls[0][0];
    expect(calledUrl).toContain("domain=some-gallery.art");
  });

  // ── Recognised domain ─────────────────────────────────────────────────────

  it("rewrites a recognised custom domain to /t/[slug]", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ slug: "jane-smith-studio" }),
      }),
    );

    const req = makeRequest("janeart.com");
    const res = await middleware(req);

    const target = rewriteTarget(res);
    expect(target).not.toBeNull();
    expect(target).toMatch(/\/t\/jane-smith-studio/);
    expect(target).not.toMatch(/\/unknown-domain/);
  });

  it("preserves the request pathname when rewriting a recognised domain", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ slug: "blue-door-gallery" }),
      }),
    );

    const req = makeRequest("bluedoor.art", "/about");
    const res = await middleware(req);

    const target = rewriteTarget(res);
    expect(target).toMatch(/\/t\/blue-door-gallery\/about/);
  });

  // ── Platform domain passthrough ────────────────────────────────────────────

  it("does not call the tenant lookup for localhost requests", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await middleware(makeRequest("localhost"));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── Operational failure (5xx) — don't falsely show unknown-domain ──────────

  it("does not rewrite to /unknown-domain when the lookup returns a 5xx error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({}),
      }),
    );

    const req = makeRequest("gallery.example.com");
    const res = await middleware(req);

    const target = rewriteTarget(res);
    // A 5xx is an operational failure — the middleware falls through
    // (NextResponse.next()), so there is no x-middleware-rewrite header.
    expect(target).toBeNull();
  });

  it("does not rewrite to /unknown-domain when the lookup times out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new DOMException("The operation was aborted.", "AbortError")),
    );

    const req = makeRequest("gallery.example.com");
    const res = await middleware(req);

    const target = rewriteTarget(res);
    expect(target).toBeNull();
  });
});
