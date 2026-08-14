/**
 * Unit tests confirming that BlobStoreNotFoundError (and StorageNotConfiguredError)
 * thrown during a fetch are surfaced as hard 500 errors rather than being
 * silently swallowed as generic 404s.
 *
 * BlobNotFoundError means a specific file is absent — that should remain a 404.
 * BlobStoreNotFoundError / StorageNotConfiguredError means the store itself is
 * misconfigured, which is always an operator error that must be visible.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { BlobStoreNotFoundError, BlobNotFoundError, BlobError } from "@vercel/blob";

// ── Shared session mock — includes tenantId required by the ownership guard ────

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn().mockResolvedValue({ userId: "user-1", tenantId: "tenant-1" }),
}));

// ── DB mock — ownership check always grants access for this tenant ─────────────

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      artworkImagesTable: {
        findFirst: vi.fn().mockResolvedValue({ id: "img-1" }),
      },
    },
  },
  artworkImagesTable: {
    objectPath: "objectPath",
    tenantId: "tenantId",
  },
}));

// Drizzle-orm operators are no-ops in unit tests (the DB mock ignores them).
vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: any[]) => args),
  eq: vi.fn((...args: any[]) => args),
}));

// ── object-storage mock ────────────────────────────────────────────────────────

vi.mock("@/lib/object-storage", () => ({
  fetchObject: vi.fn(),
  StorageNotConfiguredError: class StorageNotConfiguredError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "StorageNotConfiguredError";
    }
  },
}));

import { fetchObject } from "@/lib/object-storage";
import { GET as serveGET } from "@/app/api/storage/serve/route";
import { NextRequest } from "next/server";

function makeServeRequest(path = "/objects/uploads/abc-123") {
  return new NextRequest(
    `http://localhost/api/storage/serve?path=${encodeURIComponent(path)}`,
  );
}

/** Build a minimal upstream Response as fetchObject would return. */
function fakeUpstreamResponse(contentType = "image/jpeg", body = "fake-bytes") {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": contentType, "Content-Length": String(body.length) },
  });
}

describe("GET /api/storage/serve — BlobError / StorageNotConfiguredError handling", () => {
  beforeEach(() => {
    vi.mocked(fetchObject).mockReset();
  });

  it("returns 500 when fetchObject throws BlobStoreNotFoundError", async () => {
    vi.mocked(fetchObject).mockRejectedValueOnce(new BlobStoreNotFoundError());

    const res = await serveGET(makeServeRequest());

    expect(res.status).toBe(500);
  });

  it("returns 500 for any BlobError subclass that is not BlobNotFoundError", async () => {
    class OtherBlobError extends BlobError {
      constructor() {
        super("some other blob problem");
        this.name = "OtherBlobError";
      }
    }
    vi.mocked(fetchObject).mockRejectedValueOnce(new OtherBlobError());

    const res = await serveGET(makeServeRequest());

    expect(res.status).toBe(500);
  });

  it("returns 404 (not 500) for a BlobNotFoundError", async () => {
    vi.mocked(fetchObject).mockRejectedValueOnce(new BlobNotFoundError());

    const res = await serveGET(makeServeRequest());

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
  });

  it("returns 404 for a generic non-config error", async () => {
    vi.mocked(fetchObject).mockRejectedValueOnce(new Error("blob lookup failed"));

    const res = await serveGET(makeServeRequest());

    expect(res.status).toBe(404);
  });

  it("returns 200 with Content-Type and body on success (no redirect)", async () => {
    vi.mocked(fetchObject).mockResolvedValueOnce(
      fakeUpstreamResponse("image/png", "PNG bytes"),
    );

    const res = await serveGET(makeServeRequest());

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/image\/png/);
    // Must not redirect.
    expect(res.headers.get("location")).toBeNull();
    // Safe image types are served inline.
    expect(res.headers.get("Content-Disposition")).toBe("inline");
    // MIME sniffing must be disabled.
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const text = await res.text();
    expect(text).toBe("PNG bytes");
  });

  it("forces Content-Disposition: attachment for image/svg+xml to prevent stored XSS", async () => {
    vi.mocked(fetchObject).mockResolvedValueOnce(
      fakeUpstreamResponse("image/svg+xml", "<svg><script>alert(1)</script></svg>"),
    );

    const res = await serveGET(makeServeRequest());

    expect(res.status).toBe(200);
    // SVG must be forced to download — never opened as an app-origin document.
    expect(res.headers.get("Content-Disposition")).toBe("attachment");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("returns 400 for an invalid (non-/objects/) path", async () => {
    const res = await serveGET(makeServeRequest("/bad/path"));

    expect(res.status).toBe(400);
    expect(vi.mocked(fetchObject)).not.toHaveBeenCalled();
  });

  it("returns 400 when no path query param is supplied", async () => {
    const req = new NextRequest("http://localhost/api/storage/serve");
    const res = await serveGET(req);

    expect(res.status).toBe(400);
    expect(vi.mocked(fetchObject)).not.toHaveBeenCalled();
  });
});
