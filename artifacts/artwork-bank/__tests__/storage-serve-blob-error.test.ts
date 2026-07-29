/**
 * Unit tests confirming that BlobStoreNotFoundError (and StorageNotConfiguredError)
 * thrown during a serve-URL lookup are surfaced as hard 500 errors rather than
 * being silently swallowed as generic 404s.
 *
 * BlobNotFoundError means a specific file is absent — that should remain a 404.
 * BlobStoreNotFoundError / StorageNotConfiguredError means the store itself is
 * misconfigured, which is always an operator error that must be visible.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { BlobStoreNotFoundError, BlobNotFoundError, BlobError } from "@vercel/blob";

// ── Shared session mock ────────────────────────────────────────────────────────

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn().mockResolvedValue({ userId: "user-1" }),
}));

// ── object-storage mock ────────────────────────────────────────────────────────

vi.mock("@/lib/object-storage", () => ({
  getServeUrl: vi.fn(),
  StorageNotConfiguredError: class StorageNotConfiguredError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "StorageNotConfiguredError";
    }
  },
}));

import { getServeUrl, StorageNotConfiguredError } from "@/lib/object-storage";
import { GET as serveGET } from "@/app/api/storage/serve/route";
import { NextRequest } from "next/server";

function makeServeRequest(path = "/objects/uploads/abc-123") {
  return new NextRequest(
    `http://localhost/api/storage/serve?path=${encodeURIComponent(path)}`,
  );
}

describe("GET /api/storage/serve — BlobError / StorageNotConfiguredError handling", () => {
  beforeEach(() => {
    vi.mocked(getServeUrl).mockReset();
  });

  it("returns 500 when getServeUrl throws BlobStoreNotFoundError", async () => {
    vi.mocked(getServeUrl).mockRejectedValueOnce(new BlobStoreNotFoundError());

    const res = await serveGET(makeServeRequest());

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/misconfigured/i);
  });

  it("returns 500 when getServeUrl throws StorageNotConfiguredError", async () => {
    vi.mocked(getServeUrl).mockRejectedValueOnce(
      new StorageNotConfiguredError("PRIVATE_OBJECT_DIR not set"),
    );

    const res = await serveGET(makeServeRequest());

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/misconfigured/i);
  });

  it("returns 500 for any BlobError subclass that is not BlobNotFoundError", async () => {
    class OtherBlobError extends BlobError {
      constructor() {
        super("some other blob problem");
        this.name = "OtherBlobError";
      }
    }
    vi.mocked(getServeUrl).mockRejectedValueOnce(new OtherBlobError());

    const res = await serveGET(makeServeRequest());

    expect(res.status).toBe(500);
  });

  it("returns 404 (not 500) for a BlobNotFoundError", async () => {
    vi.mocked(getServeUrl).mockRejectedValueOnce(new BlobNotFoundError());

    const res = await serveGET(makeServeRequest());

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
  });

  it("returns 404 for a generic non-config error", async () => {
    vi.mocked(getServeUrl).mockRejectedValueOnce(new Error("blob lookup failed"));

    const res = await serveGET(makeServeRequest());

    expect(res.status).toBe(404);
  });

  it("returns 302 redirect to the signed URL on success", async () => {
    vi.mocked(getServeUrl).mockResolvedValueOnce(
      "https://example-store.public.blob.vercel-storage.com/uploads/abc-123",
    );

    const res = await serveGET(makeServeRequest());

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "https://example-store.public.blob.vercel-storage.com/uploads/abc-123",
    );
  });

  it("returns 400 for an invalid (non-/objects/) path", async () => {
    const res = await serveGET(makeServeRequest("/bad/path"));

    expect(res.status).toBe(400);
    expect(vi.mocked(getServeUrl)).not.toHaveBeenCalled();
  });

  it("returns 400 when no path query param is supplied", async () => {
    const req = new NextRequest("http://localhost/api/storage/serve");
    const res = await serveGET(req);

    expect(res.status).toBe(400);
    expect(vi.mocked(getServeUrl)).not.toHaveBeenCalled();
  });
});
