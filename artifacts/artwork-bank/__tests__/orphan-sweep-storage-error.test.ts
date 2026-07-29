/**
 * Unit tests confirming that a misconfigured storage backend (BlobStoreNotFoundError
 * or StorageNotConfiguredError) thrown inside the orphan-sweep route is surfaced as
 * a 500 with a clear "storage misconfigured" message rather than being swallowed
 * by the generic "Sweep failed" catch.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { BlobStoreNotFoundError } from "@vercel/blob";

// ── Mock next/server so the route can be imported in a plain Node environment ──

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) => ({
      status: init?.status ?? 200,
      body,
    }),
  },
}));

// ── Mock the sweep implementation so no DB or real storage is touched ──────────

const sweepOrphanedImageFiles = vi.hoisted(() => vi.fn());

vi.mock("@/lib/orphan-image-sweep", () => ({
  sweepOrphanedImageFiles,
}));

// ── Mock StorageNotConfiguredError so we can throw a local instance ────────────

vi.mock("@/lib/object-storage", () => ({
  StorageNotConfiguredError: class StorageNotConfiguredError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "StorageNotConfiguredError";
    }
  },
}));

import { StorageNotConfiguredError } from "@/lib/object-storage";
import { GET, POST } from "@/app/api/storage/orphan-sweep/route";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(authHeader?: string): Request {
  return {
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "authorization" ? (authHeader ?? null) : null,
    },
  } as unknown as Request;
}

// In test/dev mode with no secret, the endpoint is open — no auth header needed.
const openRequest = makeRequest();

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  sweepOrphanedImageFiles.mockReset();
  // Vitest sets NODE_ENV=test by default, so auth is bypassed (no secret needed).
  delete process.env.ORPHAN_SWEEP_SECRET;
  delete process.env.CRON_SECRET;
});

describe("orphan-sweep route — storage misconfiguration errors", () => {
  it("GET returns 500 with a 'misconfigured' message when sweepOrphanedImageFiles throws BlobStoreNotFoundError", async () => {
    sweepOrphanedImageFiles.mockRejectedValueOnce(new BlobStoreNotFoundError());

    const res = await GET(openRequest);

    expect(res.status).toBe(500);
    expect((res.body as any).error).toMatch(/misconfigured/i);
  });

  it("POST returns 500 with a 'misconfigured' message when sweepOrphanedImageFiles throws BlobStoreNotFoundError", async () => {
    sweepOrphanedImageFiles.mockRejectedValueOnce(new BlobStoreNotFoundError());

    const res = await POST(openRequest);

    expect(res.status).toBe(500);
    expect((res.body as any).error).toMatch(/misconfigured/i);
  });

  it("GET returns 500 with a 'misconfigured' message when sweepOrphanedImageFiles throws StorageNotConfiguredError", async () => {
    sweepOrphanedImageFiles.mockRejectedValueOnce(
      new StorageNotConfiguredError("PRIVATE_OBJECT_DIR not set"),
    );

    const res = await GET(openRequest);

    expect(res.status).toBe(500);
    expect((res.body as any).error).toMatch(/misconfigured/i);
  });

  it("POST returns 500 with a 'misconfigured' message when sweepOrphanedImageFiles throws StorageNotConfiguredError", async () => {
    sweepOrphanedImageFiles.mockRejectedValueOnce(
      new StorageNotConfiguredError("BLOB_READ_WRITE_TOKEN not set"),
    );

    const res = await POST(openRequest);

    expect(res.status).toBe(500);
    expect((res.body as any).error).toMatch(/misconfigured/i);
  });

  it("GET returns 500 with generic 'Sweep failed' for a non-storage error", async () => {
    sweepOrphanedImageFiles.mockRejectedValueOnce(
      new Error("unexpected database failure"),
    );

    const res = await GET(openRequest);

    expect(res.status).toBe(500);
    expect((res.body as any).error).toMatch(/sweep failed/i);
  });

  it("GET returns 200 with sweep result on success", async () => {
    sweepOrphanedImageFiles.mockResolvedValueOnce({
      checked: 10,
      orphaned: 2,
      deleted: 2,
      errors: 0,
      failedPaths: [],
    });

    const res = await GET(openRequest);

    expect(res.status).toBe(200);
    expect((res.body as any).orphaned).toBe(2);
  });
});

// ── Per-row error surfacing ────────────────────────────────────────────────────
//
// When sweepOrphanedImageFiles() returns errors > 0 the route must:
//   a) include the error count in the response body
//   b) include the failed paths in the response body
//   c) respond with HTTP 207 (Multi-Status) so callers and monitoring tools
//      know that some files were not cleaned up
//
// A pure HTTP 200 with no visible error flag would allow operators to miss
// storage failures silently.

describe("orphan-sweep route — per-row error forwarding", () => {
  beforeEach(() => {
    sweepOrphanedImageFiles.mockReset();
    delete process.env.ORPHAN_SWEEP_SECRET;
    delete process.env.CRON_SECRET;
  });

  it("GET returns 207 when errors > 0", async () => {
    sweepOrphanedImageFiles.mockResolvedValueOnce({
      checked: 5,
      orphaned: 3,
      deleted: 2,
      errors: 1,
      failedPaths: ["/objects/uploads/bad-file.jpg"],
    });

    const res = await GET(openRequest);

    expect(res.status).toBe(207);
  });

  it("POST returns 207 when errors > 0", async () => {
    sweepOrphanedImageFiles.mockResolvedValueOnce({
      checked: 5,
      orphaned: 3,
      deleted: 2,
      errors: 1,
      failedPaths: ["/objects/uploads/bad-file.jpg"],
    });

    const res = await POST(openRequest);

    expect(res.status).toBe(207);
  });

  it("GET response body includes the error count when errors > 0", async () => {
    sweepOrphanedImageFiles.mockResolvedValueOnce({
      checked: 5,
      orphaned: 3,
      deleted: 2,
      errors: 1,
      failedPaths: ["/objects/uploads/bad-file.jpg"],
    });

    const res = await GET(openRequest);

    expect((res.body as any).errors).toBe(1);
  });

  it("GET response body includes the failed paths when errors > 0", async () => {
    const failedPath = "/objects/uploads/broken-abc123.jpg";
    sweepOrphanedImageFiles.mockResolvedValueOnce({
      checked: 4,
      orphaned: 2,
      deleted: 1,
      errors: 1,
      failedPaths: [failedPath],
    });

    const res = await GET(openRequest);

    expect((res.body as any).failedPaths).toContain(failedPath);
  });

  it("GET response body includes all failed paths when multiple errors occurred", async () => {
    const path1 = "/objects/uploads/err-1.jpg";
    const path2 = "/objects/uploads/err-2.jpg";
    sweepOrphanedImageFiles.mockResolvedValueOnce({
      checked: 5,
      orphaned: 3,
      deleted: 1,
      errors: 2,
      failedPaths: [path1, path2],
    });

    const res = await GET(openRequest);

    expect(res.status).toBe(207);
    expect((res.body as any).errors).toBe(2);
    expect((res.body as any).failedPaths).toContain(path1);
    expect((res.body as any).failedPaths).toContain(path2);
  });

  it("GET returns 200 (not 207) when errors === 0 even if some paths were deleted", async () => {
    sweepOrphanedImageFiles.mockResolvedValueOnce({
      checked: 10,
      orphaned: 3,
      deleted: 3,
      errors: 0,
      failedPaths: [],
    });

    const res = await GET(openRequest);

    expect(res.status).toBe(200);
    expect((res.body as any).errors).toBe(0);
    expect((res.body as any).failedPaths).toEqual([]);
  });

  it("GET response body always includes deleted count alongside errors", async () => {
    sweepOrphanedImageFiles.mockResolvedValueOnce({
      checked: 6,
      orphaned: 4,
      deleted: 3,
      errors: 1,
      failedPaths: ["/objects/uploads/one-failure.jpg"],
    });

    const res = await GET(openRequest);

    expect(res.status).toBe(207);
    // Both successful and failed counts must be present so operators see the
    // full picture — not just that something went wrong.
    expect((res.body as any).deleted).toBe(3);
    expect((res.body as any).errors).toBe(1);
  });
});
