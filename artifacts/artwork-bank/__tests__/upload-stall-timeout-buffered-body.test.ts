/**
 * Confirm the upload stall deadline fires even when the runtime has already
 * buffered the bytes it received from the client.
 *
 * Background — why this file exists
 * ──────────────────────────────────
 * `upload-stall-timeout-http-layer-integration.test.ts` drives back-pressure
 * through a raw TCP socket and a plain Node.js http.Server shim, where each
 * TCP write propagates directly into a ReadableStream chunk.  That covers the
 * "stream is fully lazy" case.
 *
 * In a real Next.js deployment (especially behind Vercel's edge infrastructure)
 * the runtime may buffer received bytes in memory *before* calling the route
 * handler.  A naive read of the code might suggest that, in this case,
 * reader.read() returns instantly for the buffered data and the deadline timer
 * never gets a chance to fire — defeating slow-loris protection entirely.
 *
 * The concern is actually unfounded: even a pre-buffering runtime can only
 * buffer bytes that the *client has already sent*.  A stalling client — one
 * that opens a connection, sends a small header + initial chunk, and then
 * goes silent — never transmits the remaining body or the EOF signal.  The
 * runtime therefore cannot produce those bytes; the ReadableStream it presents
 * to the handler will exhaust the pre-buffered data on the first read and then
 * block on the *next* reader.read() call just as a raw-socket stream would.
 * The per-chunk timeout fires there.
 *
 * These tests verify that behaviour with a synthetic stream that explicitly
 * models the two-phase nature of a buffered-then-stalled upload:
 *
 *   Phase 1 — "buffered":  first chunk resolves immediately (no I/O wait).
 *   Phase 2 — "stalled":   subsequent reads hang indefinitely (client silent).
 *
 * Isolation
 * ─────────
 * • getSession is mocked so auth always passes without a real DB or cookie.
 * • putObject is mocked so no storage infrastructure is needed.
 * • UPLOAD_READ_TIMEOUT_MS is set to 300 ms so tests finish quickly.
 *
 * Manual runbook — testing against the real Next.js dev server
 * ─────────────────────────────────────────────────────────────
 * The automated tests here use the real route handler in-process but supply a
 * synthetic ReadableStream.  To verify the *full* stack — actual Next.js
 * request-parsing pipeline, any edge buffering, TLS, etc. — run this
 * procedure manually against `next dev`:
 *
 *   1. Start the dev server with a short stall timeout:
 *
 *        UPLOAD_READ_TIMEOUT_MS=1000 pnpm --filter @workspace/artwork-bank dev
 *
 *   2. In a second terminal, send a stalling chunked upload via curl.
 *      Replace <SESSION_COOKIE> with a valid iron-session cookie obtained by
 *      logging into the dev app and copying the Set-Cookie value.
 *
 *        # Send headers + one 4-byte chunk, then hang (Ctrl-C after ~3 s):
 *        (printf 'POST /api/storage/upload HTTP/1.1\r\n' \
 *                'Host: 127.0.0.1:3000\r\n' \
 *                'Content-Type: image/jpeg\r\n' \
 *                'Transfer-Encoding: chunked\r\n' \
 *                'Cookie: <SESSION_COOKIE>\r\n' \
 *                'Connection: close\r\n' \
 *                '\r\n' \
 *                '4\r\nXXXX\r\n'; \
 *         sleep 10) | nc 127.0.0.1 3000
 *
 *      Expected: within ~1 s (UPLOAD_READ_TIMEOUT_MS) you see:
 *
 *        HTTP/1.1 408 Request Timeout
 *        ...
 *        {"error":"Upload timed out: client stalled mid-stream"}
 *
 *   3. As a sanity check, run a fast upload (should return 200 within 1 s):
 *
 *        curl -s -o /dev/null -w '%{http_code}' \
 *             -X POST 'http://127.0.0.1:3000/api/storage/upload' \
 *             -H 'Content-Type: image/jpeg' \
 *             -H 'Cookie: <SESSION_COOKIE>' \
 *             --data-binary @/dev/urandom \
 *             --max-time 2
 *
 *      This will likely return 200 or 413, not 408 — confirming that a
 *      non-stalling client is not affected by the read deadline.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Auth mock — always returns a logged-in user ───────────────────────────────

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ userId: "buffered-body-test-user" })),
}));

// ── Storage mock — putObject should not be called on a stalled upload ─────────

vi.mock("@/lib/object-storage", () => ({
  putObject: vi.fn().mockResolvedValue(undefined),
  StorageNotConfiguredError: class StorageNotConfiguredError extends Error {
    constructor(message?: string) {
      super(message ?? "Storage not configured");
      this.name = "StorageNotConfiguredError";
    }
  },
}));

// ── Route + storage imports (after mocks are in place) ────────────────────────

import { POST } from "@/app/api/storage/upload/route";
import { putObject } from "@/lib/object-storage";
import { NextRequest } from "next/server";

const mockPutObject = vi.mocked(putObject);

// ── Env helpers ───────────────────────────────────────────────────────────────

const savedEnv: Record<string, string | undefined> = {};

function saveAndSet(overrides: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(overrides)) {
    savedEnv[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  for (const key of Object.keys(savedEnv)) {
    delete savedEnv[key];
  }
}

// ── Stream factory — models a runtime-buffered upload ────────────────────────

/**
 * Build a ReadableStream that models what a buffering runtime presents to the
 * route handler when a client stalls mid-upload.
 *
 * Phase 1 — immediate:  `initialChunk` is enqueued synchronously the moment
 *            the first pull() is called.  This simulates bytes the runtime had
 *            already received and buffered before calling the handler.
 *
 * Phase 2 — stall:      after the initial chunk is consumed, subsequent pull()
 *            calls never resolve.  `neverResolve` returns a Promise that hangs
 *            forever, mirroring a client that has gone silent.
 *
 * @param initialChunk  The pre-buffered bytes (already received from client).
 */
function makeBufferedThenStalledStream(
  initialChunk: Uint8Array,
): ReadableStream<Uint8Array> {
  let initialSent = false;
  // Holds a reference to an outstanding pull() controller so we can clean up
  // in cancel().  In practice cancel() is called by readChunkWithTimeout when
  // the deadline fires; we just need to avoid leaking resources.
  let pendingResolve: ((value: ReadableStreamReadResult<Uint8Array>) => void) | null = null;

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!initialSent) {
        // Phase 1: immediately enqueue the pre-buffered bytes.
        initialSent = true;
        controller.enqueue(initialChunk);
        return;
      }
      // Phase 2: hang — the client is stalling, no more bytes arrive.
      // Return a Promise that never resolves so pull() stays pending until
      // the reader is cancelled (by the route's readChunkWithTimeout).
      return new Promise<void>((resolve) => {
        pendingResolve = () => resolve();
      });
    },
    cancel() {
      // Unblock any dangling pull() so the stream can be GC'd cleanly.
      if (pendingResolve) {
        pendingResolve(undefined as any);
        pendingResolve = null;
      }
    },
  });
}

/**
 * Build a complete, non-stalling ReadableStream — all bytes delivered
 * immediately.  Used by the happy-path test to confirm that a fast client
 * still gets 200.
 */
function makeImmediateStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildRequest(stream: ReadableStream<Uint8Array>): NextRequest {
  return new NextRequest("http://127.0.0.1/api/storage/upload", {
    method: "POST",
    headers: { "Content-Type": "image/jpeg" },
    body: stream,
    duplex: "half",
  });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockPutObject.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe(
  "upload stall deadline — buffered-body simulation (models Next.js pre-buffering)",
  () => {
    it(
      "stall after buffered initial chunk: route returns 408 within the deadline",
      async () => {
        /**
         * This is the core regression guard for the Next.js buffering concern.
         *
         * Setup:
         *   - Phase 1: 4 bytes are immediately available (buffered).
         *   - Phase 2: the stream then hangs forever (client stalled).
         *
         * If the route's readChunkWithTimeout() only wraps the *first* read()
         * call it would incorrectly see the buffered data and continue waiting
         * for the next chunk — but the timeout is applied to *every* read(),
         * including the blocking second one.  This test confirms 408 fires.
         */
        const READ_TIMEOUT_MS = 300;
        saveAndSet({ UPLOAD_READ_TIMEOUT_MS: String(READ_TIMEOUT_MS) });

        const stream = makeBufferedThenStalledStream(
          new Uint8Array([0x42, 0x43, 0x44, 0x45]), // 4 buffered bytes
        );
        const request = buildRequest(stream);

        const start = Date.now();
        const response = await POST(request as any);
        const elapsed = Date.now() - start;

        // The route must return 408, not hang or return any other status.
        expect(response.status).toBe(408);

        const body = (await response.json()) as { error?: string };
        expect(body.error).toMatch(/timed out|stalled/i);

        // The timeout must have fired (elapsed ≥ READ_TIMEOUT_MS) but the test
        // must not hang (elapsed < 3× READ_TIMEOUT_MS is a generous bound).
        expect(elapsed).toBeGreaterThanOrEqual(READ_TIMEOUT_MS);
        expect(elapsed).toBeLessThan(READ_TIMEOUT_MS * 3 + 500);

        // Storage must never be called on a stalled upload.
        expect(mockPutObject).not.toHaveBeenCalled();

        restoreEnv();
      },
      3_000,
    );

    it(
      "stall after a larger buffered initial chunk: route returns 408, not 200",
      async () => {
        /**
         * Vary the initial chunk size (1 KiB) to rule out any edge case where
         * the route treats a large first read as a complete upload.
         * A 1 KiB chunk is well under the 25 MiB limit, so the route should
         * proceed to the next read() — where it stalls and fires 408.
         */
        const READ_TIMEOUT_MS = 300;
        saveAndSet({ UPLOAD_READ_TIMEOUT_MS: String(READ_TIMEOUT_MS) });

        const initialChunk = new Uint8Array(1024).fill(0xab);
        const stream = makeBufferedThenStalledStream(initialChunk);
        const request = buildRequest(stream);

        const response = await POST(request as any);

        expect(response.status).toBe(408);
        const body = (await response.json()) as { error?: string };
        expect(body.error).toMatch(/timed out|stalled/i);
        expect(mockPutObject).not.toHaveBeenCalled();

        restoreEnv();
      },
      3_000,
    );

    it(
      "non-stalling buffered stream (all bytes immediately available): route returns 200",
      async () => {
        /**
         * Sanity check: when the runtime pre-buffers the *complete* body (all
         * bytes already received and the stream closed), the route reads them
         * instantly and must return 200.  This confirms the read deadline does
         * not fire spuriously for fast clients.
         */
        const READ_TIMEOUT_MS = 300;
        saveAndSet({ UPLOAD_READ_TIMEOUT_MS: String(READ_TIMEOUT_MS) });

        mockPutObject.mockResolvedValue(undefined);

        // A complete 4-byte body — stream closes after the first chunk.
        const stream = makeImmediateStream(
          new Uint8Array([0x42, 0x43, 0x44, 0x45]),
        );
        const request = buildRequest(stream);

        const response = await POST(request as any);

        expect(response.status).toBe(200);
        const body = (await response.json()) as { objectPath?: string };
        expect(body.objectPath).toMatch(/^\/objects\/uploads\//);
        expect(mockPutObject).toHaveBeenCalledTimes(1);

        restoreEnv();
      },
      3_000,
    );

    it(
      "stall with no initial buffered data: route returns 408 (baseline consistency)",
      async () => {
        /**
         * Edge case: runtime buffers zero bytes (stream starts stalled
         * immediately).  This is functionally equivalent to what the TCP-layer
         * test covers, but exercised here through the same synthetic-stream
         * mechanism for consistency.
         */
        const READ_TIMEOUT_MS = 300;
        saveAndSet({ UPLOAD_READ_TIMEOUT_MS: String(READ_TIMEOUT_MS) });

        // A stream whose very first pull() hangs — no initial data at all.
        let released = false;
        const neverEndsStream = new ReadableStream<Uint8Array>({
          pull() {
            return new Promise<void>((resolve) => {
              // Store the resolver so cancel() can unblock it cleanly.
              const id = setInterval(() => {
                if (released) {
                  clearInterval(id);
                  resolve();
                }
              }, 50);
            });
          },
          cancel() {
            released = true;
          },
        });

        const request = buildRequest(neverEndsStream);

        const response = await POST(request as any);

        expect(response.status).toBe(408);
        expect(mockPutObject).not.toHaveBeenCalled();

        restoreEnv();
      },
      3_000,
    );
  },
);
