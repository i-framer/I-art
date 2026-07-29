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
