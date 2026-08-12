/**
 * Task #662 — Confirm the raw-body (non-multipart) path is guarded against
 * slow-drip exhaustion.
 *
 * Context
 * ───────
 * A slow-drip client sends tiny chunks at intervals just within the per-chunk
 * deadline (UPLOAD_READ_TIMEOUT_MS) but collectively takes far longer than the
 * total wall-clock budget (UPLOAD_TOTAL_TIMEOUT_MS).  Without the total-timeout
 * guard, such a client could monopolise a server connection indefinitely while
 * never appearing stalled on any individual read.
 *
 * `readStreamWithDeadlines` (lib/upload-read-stream.ts) uses two guards:
 *
 *   1. Per-chunk guard   — races every reader.read() against UPLOAD_READ_TIMEOUT_MS.
 *                          A client that goes silent on a single chunk is caught here.
 *                          Returns 408 "client stalled mid-stream".
 *
 *   2. Total-wall-clock  — a single AbortSignal that fires at UPLOAD_TOTAL_TIMEOUT_MS
 *                          after the function is called, regardless of individual chunk
 *                          timing. Catches slow-drip clients.
 *                          Returns 408 "upload took too long".
 *
 * This file targets the **total-wall-clock (slow-drip) branch** on the raw
 * image/* path specifically.  The per-chunk/stall branch and multipart path
 * are exercised in separate test files.
 *
 * What this test verifies
 * ───────────────────────
 *  1. A slow-drip stream on the raw path returns 408.
 *  2. The 408 body says "upload took too long" (total timeout, not stall).
 *  3. putObject is never called when the total timeout fires.
 *  4. A fast stream (all bytes immediately) returns 200 — guard is not spurious.
 *  5. Setting UPLOAD_TOTAL_TIMEOUT_MS explicitly controls the deadline.
 *  6. Slow-drip is distinguished from a stall: per-chunk deadline is generous
 *     enough that each individual read succeeds; the total deadline is the one
 *     that actually fires.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ── Auth mock ─────────────────────────────────────────────────────────────────
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ userId: "slow-drip-test-user" })),
}));

// ── Storage mock ──────────────────────────────────────────────────────────────
vi.mock("@/lib/object-storage", () => ({
  putObject: vi.fn().mockResolvedValue(undefined),
  StorageNotConfiguredError: class StorageNotConfiguredError extends Error {
    constructor(message?: string) {
      super(message ?? "Storage not configured");
      this.name = "StorageNotConfiguredError";
    }
  },
}));

import { POST } from "@/app/api/storage/upload/route";
import { putObject } from "@/lib/object-storage";

const mockPutObject = vi.mocked(putObject);

// ── Env helpers ───────────────────────────────────────────────────────────────

const savedEnv: Record<string, string | undefined> = {};

function saveAndSet(overrides: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(overrides)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const key of Object.keys(savedEnv)) delete savedEnv[key];
}

// ── Stream factory — slow-drip ────────────────────────────────────────────────

/**
 * Build a ReadableStream that delivers `totalChunks` single-byte chunks, each
 * delayed by `delayMsBetweenChunks`, then goes silent (never closes).
 *
 * This models a slow-drip client:
 *   - Each individual chunk arrives before the per-chunk deadline fires.
 *   - The total transmission time exceeds UPLOAD_TOTAL_TIMEOUT_MS.
 *   - The stream never closes, so the route would hang forever without the
 *     total-timeout guard.
 */
function makeSlowDripStream(
  delayMsBetweenChunks: number,
  totalChunks: number,
): ReadableStream<Uint8Array> {
  let sentCount = 0;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingResolve: (() => void) | null = null;

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sentCount >= totalChunks) {
        // All chunks sent — go silent to prevent stream closure.
        return new Promise<void>((resolve) => {
          pendingResolve = resolve;
        });
      }

      return new Promise<void>((resolve) => {
        pendingResolve = resolve;
        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          pendingResolve = null;
          sentCount++;
          controller.enqueue(new Uint8Array([0x42]));
          resolve();
        }, delayMsBetweenChunks);
      });
    },
    cancel() {
      if (pendingTimer !== null) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      pendingResolve?.();
      pendingResolve = null;
    },
  });
}

/** Build a NextRequest whose raw body is a slow-drip or fast ReadableStream. */
function buildRawRequest(stream: ReadableStream<Uint8Array>): NextRequest {
  return new NextRequest("https://example.com/api/storage/upload", {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: stream,
    // @ts-expect-error — duplex required for streaming bodies in Node.js
    duplex: "half",
  });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockPutObject.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  restoreEnv();
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("raw-body upload — slow-drip total-timeout guard (Task #662)", () => {
  it(
    "slow-drip stream returns 408 when total deadline fires before stream completes",
    async () => {
      /**
       * Configuration:
       *   UPLOAD_READ_TIMEOUT_MS  = 1000ms  (generous — each 150ms chunk is safe)
       *   UPLOAD_TOTAL_TIMEOUT_MS =  400ms  (fires before 3 chunks × 150ms = 450ms)
       *
       * Expected sequence:
       *   t=0ms:   reading begins, total timer starts
       *   t=150ms: chunk 1 (42) — within per-chunk limit ✓
       *   t=300ms: chunk 2 (42) — within per-chunk limit ✓
       *   t=400ms: TOTAL TIMEOUT fires → 408 "upload took too long"
       */
      const READ_TIMEOUT_MS = 1000;
      const TOTAL_TIMEOUT_MS = 400;
      const CHUNK_DELAY_MS = 150; // 3 × 150 = 450ms > 400ms total

      saveAndSet({
        UPLOAD_READ_TIMEOUT_MS: String(READ_TIMEOUT_MS),
        UPLOAD_TOTAL_TIMEOUT_MS: String(TOTAL_TIMEOUT_MS),
      });

      const stream = makeSlowDripStream(CHUNK_DELAY_MS, /* totalChunks */ 3);
      const req = buildRawRequest(stream);

      const start = Date.now();
      const res = await POST(req as any);
      const elapsed = Date.now() - start;

      expect(res.status).toBe(408);

      const body = (await res.json()) as { error?: string };
      expect(body.error).toMatch(/upload took too long/i);

      // Must fire around the total deadline, not an order of magnitude later.
      expect(elapsed).toBeGreaterThanOrEqual(TOTAL_TIMEOUT_MS - 50);
      expect(elapsed).toBeLessThan(TOTAL_TIMEOUT_MS * 3 + 500);

      expect(mockPutObject).not.toHaveBeenCalled();
    },
    5_000,
  );

  it(
    "slow-drip error message is 'upload took too long' (total), not 'stalled' (per-chunk)",
    async () => {
      /**
       * The two timeout paths emit different error messages:
       *   per-chunk (stall):  "Upload timed out: client stalled mid-stream"
       *   total (slow-drip):  "Upload timed out: upload took too long"
       *
       * This test specifically asserts the slow-drip wording to confirm the
       * total guard fired rather than the per-chunk guard.
       */
      saveAndSet({
        UPLOAD_READ_TIMEOUT_MS: "1000",
        UPLOAD_TOTAL_TIMEOUT_MS: "400",
      });

      const stream = makeSlowDripStream(150, 3);
      const req = buildRawRequest(stream);
      const res = await POST(req as any);

      expect(res.status).toBe(408);
      const { error } = (await res.json()) as { error: string };
      expect(error).toMatch(/upload took too long/i);
      expect(error).not.toMatch(/stalled/i);
    },
    5_000,
  );

  it(
    "putObject is never called on a slow-drip timeout",
    async () => {
      saveAndSet({
        UPLOAD_READ_TIMEOUT_MS: "1000",
        UPLOAD_TOTAL_TIMEOUT_MS: "400",
      });

      const stream = makeSlowDripStream(150, 3);
      const req = buildRawRequest(stream);
      await POST(req as any);

      expect(mockPutObject).not.toHaveBeenCalled();
    },
    5_000,
  );

  it(
    "fast stream (all bytes immediately) still returns 200 — guard is not spurious",
    async () => {
      /**
       * Sanity check: a client that delivers all its bytes immediately (fast
       * client) must still receive 200.  The slow-drip guard must not
       * misfire for normal uploads.
       */
      saveAndSet({
        UPLOAD_READ_TIMEOUT_MS: "1000",
        UPLOAD_TOTAL_TIMEOUT_MS: "400",
      });

      const fastStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0x42, 0x43, 0x44]));
          controller.close();
        },
      });
      const req = buildRawRequest(fastStream);
      const res = await POST(req as any);

      expect(res.status).toBe(200);
      const { objectPath } = (await res.json()) as { objectPath: string };
      expect(objectPath).toMatch(/^\/objects\/uploads\//);
      expect(mockPutObject).toHaveBeenCalledTimes(1);
    },
    5_000,
  );

  it(
    "UPLOAD_TOTAL_TIMEOUT_MS explicitly controls the deadline (tighter budget = earlier 408)",
    async () => {
      /**
       * Confirms the total timeout is configurable: with a 250ms budget and
       * 150ms chunks, the timer fires before the second chunk arrives.
       */
      saveAndSet({
        UPLOAD_READ_TIMEOUT_MS: "1000",
        UPLOAD_TOTAL_TIMEOUT_MS: "250",
      });

      const stream = makeSlowDripStream(150, 5);
      const req = buildRawRequest(stream);

      const start = Date.now();
      const res = await POST(req as any);
      const elapsed = Date.now() - start;

      expect(res.status).toBe(408);
      // Should fire near the 250ms mark, not the 400ms mark.
      expect(elapsed).toBeLessThan(400);
      expect(mockPutObject).not.toHaveBeenCalled();
    },
    5_000,
  );
});
