/**
 * Unit tests confirming that BlobStoreNotFoundError (and other BlobError
 * subclasses that are NOT BlobNotFoundError) thrown during an artwork image
 * upload are surfaced as hard 500 errors rather than being silently dropped.
 *
 * BlobNotFoundError means a specific file is absent — that should remain a
 * 400-level or non-fatal outcome.  BlobStoreNotFoundError means the store
 * itself is misconfigured, which is always an operator error that must be
 * visible.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { BlobStoreNotFoundError, BlobNotFoundError, BlobError } from "@vercel/blob";

// ── Shared session mock ────────────────────────────────────────────────────────

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn().mockResolvedValue({ userId: "user-1" }),
}));

// ── blob-upload route ─────────────────────────────────────────────────────────

vi.mock("@vercel/blob/client", () => ({
  handleUpload: vi.fn(),
}));

import { handleUpload } from "@vercel/blob/client";
import { POST as blobUploadPOST } from "@/app/api/storage/blob-upload/route";

function makeBlobUploadRequest() {
  return new Request("http://localhost/api/storage/blob-upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "blob.generate-client-token", payload: {} }),
  });
}

describe("POST /api/storage/blob-upload — BlobError handling", () => {
  beforeEach(() => {
    vi.mocked(handleUpload).mockReset();
  });

  it("returns 500 when handleUpload throws BlobStoreNotFoundError", async () => {
    vi.mocked(handleUpload).mockRejectedValueOnce(new BlobStoreNotFoundError());

    const res = await blobUploadPOST(makeBlobUploadRequest() as any);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/misconfigured/i);
  });

  it("returns 500 for any BlobError subclass that is not BlobNotFoundError", async () => {
    // Simulate a generic BlobError (not BlobNotFoundError or BlobStoreNotFoundError)
    class OtherBlobError extends BlobError {
      constructor() {
        super("some other blob problem");
        this.name = "OtherBlobError";
      }
    }
    vi.mocked(handleUpload).mockRejectedValueOnce(new OtherBlobError());

    const res = await blobUploadPOST(makeBlobUploadRequest() as any);

    expect(res.status).toBe(500);
  });

  it("returns 400 (not 500) for a BlobNotFoundError", async () => {
    // BlobNotFoundError means a specific blob is absent — not a config problem.
    vi.mocked(handleUpload).mockRejectedValueOnce(new BlobNotFoundError());

    const res = await blobUploadPOST(makeBlobUploadRequest() as any);

    // Must remain a non-500 error (400 by default in this route)
    expect(res.status).toBe(400);
  });

  it("returns 400 for a generic non-Blob error (unchanged behaviour)", async () => {
    vi.mocked(handleUpload).mockRejectedValueOnce(new Error("network error"));

    const res = await blobUploadPOST(makeBlobUploadRequest() as any);

    expect(res.status).toBe(400);
  });
});

// ── upload-url route ──────────────────────────────────────────────────────────

vi.mock("@/lib/object-storage", () => ({
  getUploadTarget: vi.fn(),
  StorageNotConfiguredError: class StorageNotConfiguredError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "StorageNotConfiguredError";
    }
  },
}));

import { getUploadTarget, StorageNotConfiguredError } from "@/lib/object-storage";
import { POST as uploadUrlPOST } from "@/app/api/storage/upload-url/route";

function makeUploadUrlRequest() {
  return new Request("http://localhost/api/storage/upload-url", {
    method: "POST",
  });
}

describe("POST /api/storage/upload-url — BlobError / StorageNotConfiguredError handling", () => {
  beforeEach(() => {
    vi.mocked(getUploadTarget).mockReset();
  });

  it("returns 500 when getUploadTarget throws BlobStoreNotFoundError", async () => {
    vi.mocked(getUploadTarget).mockRejectedValueOnce(new BlobStoreNotFoundError());

    const res = await uploadUrlPOST(makeUploadUrlRequest() as any);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/misconfigured/i);
  });

  it("returns 500 when getUploadTarget throws StorageNotConfiguredError", async () => {
    vi.mocked(getUploadTarget).mockRejectedValueOnce(
      new StorageNotConfiguredError("PRIVATE_OBJECT_DIR not set"),
    );

    const res = await uploadUrlPOST(makeUploadUrlRequest() as any);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/misconfigured/i);
  });

  it("returns 500 for any non-config error too (unchanged — upload-url always returns 500)", async () => {
    vi.mocked(getUploadTarget).mockRejectedValueOnce(new Error("sign URL failed"));

    const res = await uploadUrlPOST(makeUploadUrlRequest() as any);

    expect(res.status).toBe(500);
  });

  it("returns 200 with upload target on success", async () => {
    vi.mocked(getUploadTarget).mockResolvedValueOnce({
      provider: "vercel-blob",
      objectPath: "/objects/uploads/abc",
      pathname: "uploads/abc",
    });

    const res = await uploadUrlPOST(makeUploadUrlRequest() as any);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.objectPath).toBe("/objects/uploads/abc");
  });
});
