/**
 * Storage upload route — auth, content-type validation, and storage-error
 * branches — real-DB integration.
 *
 * app/api/storage/upload/route.ts:
 *   POST /api/storage/upload
 *   Auth: session.userId required → 401 if missing.
 *   Content-Type: must be image/* → 400 if not.
 *   Empty body → 400.
 *   Success: calls putObject() → returns { objectPath }.
 *   StorageNotConfiguredError → 500 with config message.
 *   BlobError (non-notfound) → 500 with config message.
 *   Other errors → 500 with generic message.
 */
import { afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { randomUUID } from "node:crypto";

function uid() {
  return randomUUID();
}

const mockSession: { value: { userId: string | null } } = {
  value: { userId: null },
};
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => mockSession.value),
}));

vi.mock("@/lib/object-storage", () => ({
  putObject: vi.fn(),
  StorageNotConfiguredError: class StorageNotConfiguredError extends Error {
    constructor(msg = "Storage not configured") {
      super(msg);
      this.name = "StorageNotConfiguredError";
    }
  },
}));

import { POST as uploadPOST } from "@/app/api/storage/upload/route";
import { putObject } from "@/lib/object-storage";
const mockPutObject = vi.mocked(putObject);

/** A ReadableStream that closes immediately (zero bytes — empty body). */
function closedStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.close(); } });
}

/** A ReadableStream that yields exactly one byte then closes. */
function oneByte(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([0x42]));
      controller.close();
    },
  });
}

function makeRequest(opts: {
  contentType?: string;
  body?: ReadableStream | null;
  contentLength?: number;
}) {
  const headers = new Headers();
  if (opts.contentType !== undefined) {
    headers.set("content-type", opts.contentType);
  }
  if (opts.contentLength !== undefined) {
    headers.set("content-length", String(opts.contentLength));
  }
  // NextRequest needs a full URL
  const req = new Request("https://example.com/api/storage/upload", {
    method: "POST",
    headers,
    body: opts.body ?? null,
    // @ts-expect-error -- duplex required for streaming bodies in Node.js fetch
    duplex: "half",
  });
  return req as any;
}

afterEach(() => {
  mockSession.value = { userId: null };
  mockPutObject.mockReset();
});

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration(
  "Storage upload route auth/errors — real-DB integration",
  () => {
    it("no session → 401, putObject not called", async () => {
      mockSession.value = { userId: null };
      const req = makeRequest({
        contentType: "image/jpeg",
        body: new ReadableStream(),
      });

      const res = await uploadPOST(req);

      expect(res.status).toBe(401);
      expect(mockPutObject).not.toHaveBeenCalled();
    });

    it("valid session + non-image content-type → 400", async () => {
      mockSession.value = { userId: `user-${uid()}` };
      const req = makeRequest({
        contentType: "application/pdf",
        body: new ReadableStream(),
      });

      const res = await uploadPOST(req);
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toMatch(/image/i);
      expect(mockPutObject).not.toHaveBeenCalled();
    });

    it("valid session + missing content-type → 400", async () => {
      mockSession.value = { userId: `user-${uid()}` };
      const req = makeRequest({ body: new ReadableStream() });

      const res = await uploadPOST(req);

      expect(res.status).toBe(400);
      expect(mockPutObject).not.toHaveBeenCalled();
    });

    it("valid session + null body → 400", async () => {
      mockSession.value = { userId: `user-${uid()}` };
      const req = makeRequest({ contentType: "image/jpeg", body: null });

      const res = await uploadPOST(req);

      expect(res.status).toBe(400);
      expect(mockPutObject).not.toHaveBeenCalled();
    });

    it("valid session + image/jpeg body → 200 with objectPath", async () => {
      mockSession.value = { userId: `user-${uid()}` };
      mockPutObject.mockResolvedValue(undefined);
      const req = makeRequest({
        contentType: "image/jpeg",
        body: oneByte(),
      });

      const res = await uploadPOST(req);
      const resBody = await res.json();

      expect(res.status).toBe(200);
      expect(resBody.objectPath).toMatch(/^\/objects\/uploads\//);
    });

    it("valid session + image/png body → objectPath uses a fresh UUID each call", async () => {
      mockSession.value = { userId: `user-${uid()}` };
      mockPutObject.mockResolvedValue(undefined);

      const res1 = await uploadPOST(
        makeRequest({ contentType: "image/png", body: oneByte() }),
      );
      const res2 = await uploadPOST(
        makeRequest({ contentType: "image/png", body: oneByte() }),
      );

      const { objectPath: p1 } = (await res1.json()) as { objectPath: string };
      const { objectPath: p2 } = (await res2.json()) as { objectPath: string };
      expect(p1).not.toBe(p2);
    });

    it("valid session + StorageNotConfiguredError → 500 with misconfigured message", async () => {
      mockSession.value = { userId: `user-${uid()}` };
      const { StorageNotConfiguredError } = await import("@/lib/object-storage");
      mockPutObject.mockRejectedValue(
        new StorageNotConfiguredError("no env vars"),
      );
      const req = makeRequest({
        contentType: "image/jpeg",
        body: oneByte(),
      });

      const res = await uploadPOST(req);
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.error).toMatch(/misconfigured/i);
    });

    it("valid session + generic error → 500 with upload failed message", async () => {
      mockSession.value = { userId: `user-${uid()}` };
      mockPutObject.mockRejectedValue(new Error("network timeout"));
      const req = makeRequest({
        contentType: "image/jpeg",
        body: oneByte(),
      });

      const res = await uploadPOST(req);
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.error).toMatch(/upload failed/i);
    });

    it("Content-Length > 25 MB → 413, putObject not called", async () => {
      mockSession.value = { userId: `user-${uid()}` };
      const OVER_LIMIT = 25 * 1024 * 1024 + 1; // one byte over 25 MB
      const req = makeRequest({
        contentType: "image/jpeg",
        body: new ReadableStream(),
        contentLength: OVER_LIMIT,
      });

      const res = await uploadPOST(req);

      expect(res.status).toBe(413);
      expect(mockPutObject).not.toHaveBeenCalled();
    });

    it("Content-Length === MAX_SIZE_BYTES (exactly 25 MB) → 200, putObject called", async () => {
      mockSession.value = { userId: `user-${uid()}` };
      mockPutObject.mockResolvedValue(undefined);
      const MAX_SIZE_BYTES = 25 * 1024 * 1024;
      const exactChunk = new Uint8Array(MAX_SIZE_BYTES);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(exactChunk);
          controller.close();
        },
      });
      const req = makeRequest({
        contentType: "image/jpeg",
        body,
        contentLength: MAX_SIZE_BYTES,
      });

      const res = await uploadPOST(req);

      expect(res.status).toBe(200);
      expect(mockPutObject).toHaveBeenCalledTimes(1);
    });

    it("Content-Length === MAX_SIZE_BYTES - 1 (one byte under) → 200, putObject called", async () => {
      mockSession.value = { userId: `user-${uid()}` };
      mockPutObject.mockResolvedValue(undefined);
      const MAX_SIZE_BYTES = 25 * 1024 * 1024;
      const underLimit = MAX_SIZE_BYTES - 1;
      const chunk = new Uint8Array(underLimit);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk);
          controller.close();
        },
      });
      const req = makeRequest({
        contentType: "image/jpeg",
        body,
        contentLength: underLimit,
      });

      const res = await uploadPOST(req);

      expect(res.status).toBe(200);
      expect(mockPutObject).toHaveBeenCalledTimes(1);
    });

    it("Content-Length: 1 (under limit) but actual body > 25 MB → 413, putObject not called", async () => {
      mockSession.value = { userId: `user-${uid()}` };
      // The fast-path sees Content-Length: 1 and lets the request through.
      // The post-read byte counter must still catch the oversized body and
      // return 413 without calling putObject.
      const OVER_LIMIT = 25 * 1024 * 1024 + 1;
      const bigChunk = new Uint8Array(OVER_LIMIT);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bigChunk);
          controller.close();
        },
      });
      const req = makeRequest({
        contentType: "image/jpeg",
        body,
        contentLength: 1, // declared small — fast-path must not trust this
      });

      const res = await uploadPOST(req);

      expect(res.status).toBe(413);
      expect(mockPutObject).not.toHaveBeenCalled();
    });

    it("no Content-Length header but body > 25 MB → 413, putObject not called", async () => {
      mockSession.value = { userId: `user-${uid()}` };
      // Build a ReadableStream that yields one chunk just over the 25 MB limit.
      // No content-length header is set, simulating a chunked/streaming upload.
      const OVER_LIMIT = 25 * 1024 * 1024 + 1;
      const bigChunk = new Uint8Array(OVER_LIMIT);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bigChunk);
          controller.close();
        },
      });
      const req = makeRequest({ contentType: "image/jpeg", body });

      const res = await uploadPOST(req);

      expect(res.status).toBe(413);
      expect(mockPutObject).not.toHaveBeenCalled();
    });

    it("no Content-Length header + body exactly at MAX_SIZE_BYTES → 200, putObject called", async () => {
      mockSession.value = { userId: `user-${uid()}` };
      mockPutObject.mockResolvedValue(undefined);
      // Exactly 25 MB — must be accepted, not rejected.
      const MAX_SIZE_BYTES = 25 * 1024 * 1024;
      const exactChunk = new Uint8Array(MAX_SIZE_BYTES);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(exactChunk);
          controller.close();
        },
      });
      const req = makeRequest({ contentType: "image/jpeg", body });

      const res = await uploadPOST(req);

      expect(res.status).toBe(200);
      expect(mockPutObject).toHaveBeenCalledTimes(1);
    });

    it("no Content-Length header + body is MAX_SIZE_BYTES + 1 → 413, putObject not called", async () => {
      mockSession.value = { userId: `user-${uid()}` };
      // One byte over the limit — must be rejected.
      const ONE_OVER = 25 * 1024 * 1024 + 1;
      const overChunk = new Uint8Array(ONE_OVER);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(overChunk);
          controller.close();
        },
      });
      const req = makeRequest({ contentType: "image/jpeg", body });

      const res = await uploadPOST(req);

      expect(res.status).toBe(413);
      expect(mockPutObject).not.toHaveBeenCalled();
    });

    it("no Content-Length header + body is MAX_SIZE_BYTES - 1 → 200, putObject called", async () => {
      mockSession.value = { userId: `user-${uid()}` };
      mockPutObject.mockResolvedValue(undefined);
      // One byte under the limit — must be accepted.
      const MAX_SIZE_BYTES = 25 * 1024 * 1024;
      const underChunk = new Uint8Array(MAX_SIZE_BYTES - 1);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(underChunk);
          controller.close();
        },
      });
      const req = makeRequest({ contentType: "image/jpeg", body });

      const res = await uploadPOST(req);

      expect(res.status).toBe(200);
      expect(mockPutObject).toHaveBeenCalledTimes(1);
    });

    it("valid session → putObject IS called with correct entityId format and content-type", async () => {
      mockSession.value = { userId: `user-${uid()}` };
      mockPutObject.mockResolvedValue(undefined);
      const req = makeRequest({
        contentType: "image/webp",
        body: oneByte(),
      });

      await uploadPOST(req);

      expect(mockPutObject).toHaveBeenCalledTimes(1);
      const [entityId, , contentType] = mockPutObject.mock.calls[0]!;
      expect(entityId).toMatch(/^uploads\/[0-9a-f-]{36}$/);
      expect(contentType).toBe("image/webp");
    });

    it("no Content-Length header + body > MAX_SIZE_BYTES sent as many small chunks → 413, putObject not called", async () => {
      mockSession.value = { userId: `user-${uid()}` };
      // 101 chunks × 256 KiB = 25,856 KiB ≈ 25.25 MiB, which exceeds the 25 MiB limit.
      // (100 × 256 KiB = exactly 25 MiB, which is the accepted boundary — use 101.)
      const CHUNK_COUNT = 101;
      const CHUNK_SIZE = 256 * 1024; // 256 KiB
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < CHUNK_COUNT; i++) {
            controller.enqueue(new Uint8Array(CHUNK_SIZE));
          }
          controller.close();
        },
      });
      const req = makeRequest({ contentType: "image/jpeg", body });

      const res = await uploadPOST(req);

      expect(res.status).toBe(413);
      expect(mockPutObject).not.toHaveBeenCalled();
    });

    it("no Content-Length header + small early chunks then one chunk that tips total over MAX_SIZE_BYTES → 413, putObject not called", async () => {
      mockSession.value = { userId: `user-${uid()}` };
      // 10 × 2 MiB = 20 MiB (well under the 25 MiB limit after each chunk).
      // Then one final chunk of 5 MiB + 1 byte brings the running total to
      // 25 MiB + 1 byte, which must trigger the 413 mid-stream, not on the
      // first chunk.
      const MAX_SIZE_BYTES = 25 * 1024 * 1024;
      const SMALL_CHUNK_SIZE = 2 * 1024 * 1024; // 2 MiB
      const SMALL_CHUNK_COUNT = 10; // 10 × 2 MiB = 20 MiB
      const FINAL_CHUNK_SIZE = MAX_SIZE_BYTES - SMALL_CHUNK_COUNT * SMALL_CHUNK_SIZE + 1; // 5 MiB + 1 byte
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < SMALL_CHUNK_COUNT; i++) {
            controller.enqueue(new Uint8Array(SMALL_CHUNK_SIZE));
          }
          // This final chunk pushes the total to MAX_SIZE_BYTES + 1.
          controller.enqueue(new Uint8Array(FINAL_CHUNK_SIZE));
          controller.close();
        },
      });
      const req = makeRequest({ contentType: "image/jpeg", body });

      const res = await uploadPOST(req);

      expect(res.status).toBe(413);
      expect(mockPutObject).not.toHaveBeenCalled();
    });

    it("slow-drip stream: thousands of 1-KiB chunks whose cumulative total exceeds 25 MiB → 413, putObject not called", async () => {
      mockSession.value = { userId: `user-${uid()}` };
      // Each individual chunk is only 1 KiB — well under the 25 MiB limit.
      // We send MAX_SIZE_BYTES / 1 KiB + 1 = 25,601 chunks so the running
      // total tips over MAX_SIZE_BYTES (25 MiB) on the last chunk.
      // This confirms the incremental counter is never reset or capped between
      // reads and that the route aborts early without buffering everything.
      const CHUNK_SIZE = 1024; // 1 KiB
      const MAX_SIZE_BYTES = 25 * 1024 * 1024;
      // Number of chunks to reach exactly MAX_SIZE_BYTES, then one more to tip over.
      const CHUNKS_TO_LIMIT = MAX_SIZE_BYTES / CHUNK_SIZE; // 25,600 — exactly at the limit (accepted)
      const CHUNK_COUNT = CHUNKS_TO_LIMIT + 1; // 25,601 — one extra chunk pushes total to MAX+1 KiB
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const chunk = new Uint8Array(CHUNK_SIZE);
          for (let i = 0; i < CHUNK_COUNT; i++) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      });
      const req = makeRequest({ contentType: "image/jpeg", body });

      const res = await uploadPOST(req);

      expect(res.status).toBe(413);
      expect(mockPutObject).not.toHaveBeenCalled();
    }, 5_000 /* must complete within 5 s */);

    it("slow-drip stream: exactly 25,600 × 1-KiB chunks (= 25 MiB exactly) → 200, putObject called", async () => {
      mockSession.value = { userId: `user-${uid()}` };
      mockPutObject.mockResolvedValue(undefined);
      // Each individual chunk is only 1 KiB.  We send exactly MAX_SIZE_BYTES / 1 KiB
      // = 25,600 chunks so the running total reaches MAX_SIZE_BYTES precisely.
      // The boundary condition (> vs >=) must allow this through, not reject it.
      const CHUNK_SIZE = 1024; // 1 KiB
      const MAX_SIZE_BYTES = 25 * 1024 * 1024;
      const CHUNK_COUNT = MAX_SIZE_BYTES / CHUNK_SIZE; // 25,600 — exactly at the limit
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const chunk = new Uint8Array(CHUNK_SIZE);
          for (let i = 0; i < CHUNK_COUNT; i++) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      });
      const req = makeRequest({ contentType: "image/jpeg", body });

      const res = await uploadPOST(req);

      expect(res.status).toBe(200);
      expect(mockPutObject).toHaveBeenCalledTimes(1);
    }, 5_000 /* must complete within 5 s */);

    it("drip stream: thousands of tiny async-delayed chunks whose cumulative total exceeds 25 MiB → 413, putObject not called", async () => {
      mockSession.value = { userId: `user-${uid()}` };
      // Simulate an adversarial or network-dripped upload where each chunk
      // arrives after a micro-task delay (setImmediate / Promise.resolve), as
      // would happen with HTTP/2 multiplexed DATA frames or a slow sender that
      // yields control between frames.
      //
      // Each chunk is 1 KiB — individually negligible.  We send 25,601 chunks:
      //   25,600 × 1 KiB = 25 MiB exactly (the accepted boundary)
      //   25,601 × 1 KiB = 25 MiB + 1 KiB (one chunk over — must be rejected)
      //
      // The async gap between chunks means the route's byte-counter must keep
      // its running total across await boundaries without resetting it.  This
      // mirrors a real out-of-order or interleaved delivery pattern.
      const CHUNK_SIZE = 1024; // 1 KiB
      const MAX_SIZE_BYTES = 25 * 1024 * 1024;
      const CHUNKS_TO_LIMIT = MAX_SIZE_BYTES / CHUNK_SIZE; // 25,600 — exactly at the limit (accepted)
      const CHUNK_COUNT = CHUNKS_TO_LIMIT + 1; // 25,601 — one extra chunk pushes total to MAX + 1 KiB
      const chunk = new Uint8Array(CHUNK_SIZE);
      let sent = 0;
      // Guard: once reader.cancel() fires, prevent the in-flight setImmediate
      // from calling controller.enqueue() on an already-cancelled controller,
      // which would throw ERR_INVALID_STATE and fail the suite.
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= CHUNK_COUNT) {
            controller.close();
            return;
          }
          // Yield to the event loop between each chunk, simulating async drip
          // delivery and ensuring the route handles interleaved await points.
          return new Promise<void>((resolve) => {
            setImmediate(() => {
              if (!cancelled && sent < CHUNK_COUNT) {
                controller.enqueue(chunk);
                sent++;
              }
              resolve();
            });
          });
        },
        cancel() {
          cancelled = true;
        },
      });
      const req = makeRequest({ contentType: "image/jpeg", body });

      const res = await uploadPOST(req);

      expect(res.status).toBe(413);
      expect(mockPutObject).not.toHaveBeenCalled();
    }, 30_000 /* async delays: allow generous wall-clock budget */);

    it("async-drip stream: exactly 25,600 × 1-KiB chunks (= 25 MiB exactly) via pull-based stream → 200, putObject called once", async () => {
      mockSession.value = { userId: `user-${uid()}` };
      mockPutObject.mockResolvedValue(undefined);
      // Exactly 25 MiB delivered as 25,600 individual 1-KiB chunks, each
      // separated by a setImmediate delay — the same async-drip pattern used
      // by the over-limit counterpart, but stopping at the boundary rather
      // than one chunk past it.  The route's `> MAX_SIZE_BYTES` guard must
      // accept this: 25,600 × 1,024 = 26,214,400 bytes = MAX_SIZE_BYTES
      // exactly, which is NOT greater than the limit.
      const CHUNK_SIZE = 1024; // 1 KiB
      const MAX_SIZE_BYTES = 25 * 1024 * 1024;
      const CHUNK_COUNT = MAX_SIZE_BYTES / CHUNK_SIZE; // 25,600 — exactly at the limit
      const chunk = new Uint8Array(CHUNK_SIZE);
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= CHUNK_COUNT) {
            controller.close();
            return;
          }
          // Yield to the event loop between each chunk, mirroring HTTP/2
          // DATA-frame drip delivery and ensuring the byte counter holds its
          // running total across all await boundaries.
          return new Promise<void>((resolve) => {
            setImmediate(() => {
              if (sent < CHUNK_COUNT) {
                controller.enqueue(chunk);
                sent++;
              }
              resolve();
            });
          });
        },
      });
      const req = makeRequest({ contentType: "image/jpeg", body });

      const res = await uploadPOST(req);

      expect(res.status).toBe(200);
      expect(mockPutObject).toHaveBeenCalledTimes(1);
    }, 30_000 /* async delays: allow generous wall-clock budget */);

    it("async-drip stream over limit: route calls reader.cancel() after crossing the limit, not after draining all remaining chunks", async () => {
      mockSession.value = { userId: `user-${uid()}` };
      // This test proves TWO things:
      //   1. reader.cancel() is actually invoked (the stream's cancel() hook fires).
      //   2. The route stops pulling after at most CHUNKS_TO_LIMIT + 1 chunks —
      //      not after draining the much-larger TOTAL_CHUNKS available in the stream.
      //
      // With 1-KiB chunks:
      //   CHUNKS_TO_LIMIT = 25,600  → cumulative = 25 MiB exactly (accepted boundary)
      //   CHUNKS_TO_LIMIT + 1 = 25,601 → cumulative = 25 MiB + 1 KiB (first over-limit read)
      //
      // The stream is deliberately over-provisioned with TOTAL_CHUNKS = 50,000 chunks
      // (≈ 48.8 MiB).  A broken implementation that buffered everything before
      // returning 413 would pull all 50,000 chunks; the assertion
      // chunksRead ≤ CHUNKS_TO_LIMIT + 1 catches that.
      const CHUNK_SIZE = 1024; // 1 KiB
      const MAX_SIZE_BYTES = 25 * 1024 * 1024;
      const CHUNKS_TO_LIMIT = MAX_SIZE_BYTES / CHUNK_SIZE; // 25,600
      const TOTAL_CHUNKS = 50_000; // ≈ 2× the limit — stream keeps offering more data

      let chunksRead = 0; // count of pull() invocations = chunks actually consumed
      let cancelCalled = false; // flips to true when the stream's cancel() hook fires
      let sent = 0;
      const chunk = new Uint8Array(CHUNK_SIZE);
      // Guard: once reader.cancel() fires, prevent the in-flight setImmediate
      // from calling controller.enqueue() on an already-cancelled controller,
      // which would throw ERR_INVALID_STATE and fail the suite.
      let cancelled = false;

      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= TOTAL_CHUNKS) {
            controller.close();
            return;
          }
          // Yield to the event loop between each chunk (async-drip pattern).
          return new Promise<void>((resolve) => {
            setImmediate(() => {
              if (!cancelled && sent < TOTAL_CHUNKS) {
                chunksRead++;
                controller.enqueue(chunk);
                sent++;
              }
              resolve();
            });
          });
        },
        // This cancel() hook is called by the WHATWG streams spec whenever
        // reader.cancel() is invoked.  Asserting it fired proves the route
        // calls reader.cancel() rather than merely breaking out of the loop
        // and leaving the stream open.
        cancel() {
          cancelCalled = true;
          cancelled = true;
        },
      });

      const req = makeRequest({ contentType: "image/jpeg", body });
      const res = await uploadPOST(req);

      expect(res.status).toBe(413);
      expect(mockPutObject).not.toHaveBeenCalled();

      // Direct proof that reader.cancel() was invoked by the route.
      expect(cancelCalled).toBe(true);

      // Early-abort proof: the route must stop consuming chunks as soon as the
      // running total exceeds MAX_SIZE_BYTES.  The stream still had
      // TOTAL_CHUNKS - chunksRead chunks left to offer; a buffering implementation
      // would have consumed all 50,000.  We allow at most CHUNKS_TO_LIMIT + 1
      // (the over-limit chunk that triggers the abort).
      expect(chunksRead).toBeLessThanOrEqual(CHUNKS_TO_LIMIT + 1);
      // Lower bound: the route must have read at least the chunks needed to
      // reach the limit (25,600) plus the one that crossed it (25,601).
      expect(chunksRead).toBeGreaterThanOrEqual(CHUNKS_TO_LIMIT + 1);
    }, 30_000 /* async delays: allow generous wall-clock budget */);

    it("zero-byte body (ReadableStream that closes immediately) → 400, putObject not called", async () => {
      mockSession.value = { userId: `user-${uid()}` };
      // A non-null ReadableStream that closes without yielding any data.
      // The route must reject this with 400, not silently pass an empty Blob
      // to putObject and create a corrupt DB record.
      const req = makeRequest({
        contentType: "image/jpeg",
        body: closedStream(),
      });

      const res = await uploadPOST(req);

      expect(res.status).toBe(400);
      expect(mockPutObject).not.toHaveBeenCalled();
    });

    it("Content-Length: 0 + empty ReadableStream → 400, putObject not called", async () => {
      mockSession.value = { userId: `user-${uid()}` };
      // Content-Length: 0 passes the fast-path guard (0 is not > MAX_SIZE_BYTES),
      // so the route must still reach the post-read totalBytes === 0 check and
      // reject the request rather than calling putObject with an empty Blob.
      const req = makeRequest({
        contentType: "image/jpeg",
        body: closedStream(),
        contentLength: 0,
      });

      const res = await uploadPOST(req);

      expect(res.status).toBe(400);
      expect(mockPutObject).not.toHaveBeenCalled();
    });

    it("no Content-Length header + exactly 1-byte body → 200, putObject called with the byte", async () => {
      mockSession.value = { userId: `user-${uid()}` };
      mockPutObject.mockResolvedValue(undefined);
      // A single 1-byte chunk with no Content-Length header confirms the lower
      // boundary: the body-reading loop must not reject or silently drop tiny uploads.
      const oneByte = new Uint8Array([0x42]); // arbitrary single byte
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(oneByte);
          controller.close();
        },
      });
      const req = makeRequest({ contentType: "image/jpeg", body });

      const res = await uploadPOST(req);

      expect(res.status).toBe(200);
      expect(mockPutObject).toHaveBeenCalledTimes(1);
      // Confirm the blob passed to putObject contains exactly the 1 byte we sent.
      const blobArg: Blob = mockPutObject.mock.calls[0]![1] as Blob;
      expect(blobArg.size).toBe(1);
    }, 1_000 /* must complete within 1 s */);

    it("forged small Content-Length + multipart-like multi-chunk body whose cumulative total exceeds 25 MB → 413, putObject not called", async () => {
      mockSession.value = { userId: `user-${uid()}` };
      // Attack scenario: the client declares Content-Length: 100 (tiny, well under
      // the fast-path limit) but then streams 101 independent chunks of 256 KiB each.
      //   101 × 256 KiB = 25,856 KiB ≈ 25.25 MiB — over the 25 MiB limit.
      //   Each individual chunk is only 256 KiB — far under the limit on its own.
      // The fast-path must not trust the declared Content-Length.
      // The per-request byte counter must accumulate across all chunks and
      // return 413 once the running total exceeds MAX_SIZE_BYTES.
      const CHUNK_COUNT = 101;
      const CHUNK_SIZE = 256 * 1024; // 256 KiB — each chunk is individually tiny
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < CHUNK_COUNT; i++) {
            controller.enqueue(new Uint8Array(CHUNK_SIZE));
          }
          controller.close();
        },
      });
      const req = makeRequest({
        contentType: "image/jpeg",
        body,
        contentLength: 100, // forged — deliberately much smaller than the real body
      });

      const res = await uploadPOST(req);

      expect(res.status).toBe(413);
      expect(mockPutObject).not.toHaveBeenCalled();
    });

    it("multipart/form-data body > 25 MiB → 400 or 413, putObject not called", async () => {
      mockSession.value = { userId: `user-${uid()}` };
      // Real browser file-pickers send multipart/form-data instead of a raw
      // image/* body.  The current route rejects multipart at the content-type
      // guard (400), but if that guard ever widens to accept form uploads the
      // size limit must still hold (413).  Either rejection status is correct;
      // 200 is the only failure mode.
      //
      // Build a minimal multipart/form-data envelope:
      //   --<boundary>\r\n
      //   Content-Disposition: form-data; name="file"; filename="big.jpg"\r\n
      //   Content-Type: image/jpeg\r\n
      //   \r\n
      //   <25 MiB + 1 byte of file data>
      //   \r\n--<boundary>--\r\n
      //
      // The outer Content-Type header is multipart/form-data, so it does NOT
      // start with "image/" and the current guard returns 400 immediately.
      const boundary = "----FormBoundary" + uid().replace(/-/g, "");
      const preamble = [
        `--${boundary}\r\n`,
        `Content-Disposition: form-data; name="file"; filename="big.jpg"\r\n`,
        `Content-Type: image/jpeg\r\n`,
        `\r\n`,
      ].join("");
      const epilogue = `\r\n--${boundary}--\r\n`;
      const preambleBytes = new TextEncoder().encode(preamble);
      const epilogueBytes = new TextEncoder().encode(epilogue);
      const OVER_LIMIT = 25 * 1024 * 1024 + 1; // one byte over 25 MiB
      const fileData = new Uint8Array(OVER_LIMIT);

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(preambleBytes);
          controller.enqueue(fileData);
          controller.enqueue(epilogueBytes);
          controller.close();
        },
      });

      const req = makeRequest({
        contentType: `multipart/form-data; boundary=${boundary}`,
        body,
      });

      const res = await uploadPOST(req);

      // 400 = content-type guard (current behaviour); 413 = size guard (future).
      // 200 is the only forbidden outcome.
      expect([400, 413]).toContain(res.status);
      expect(mockPutObject).not.toHaveBeenCalled();
    });

    it("indefinitely open stream: producer never closes after crossing the limit → 413 within 1 s, no hang", async () => {
      mockSession.value = { userId: `user-${uid()}` };
      // Adversarial scenario: the client crosses the 25 MiB limit but then
      // stalls — holding the connection open without sending more data and
      // without ever calling controller.close().  A naive implementation that
      // awaits `done === true` from the reader would hang here forever.
      //
      // The route must call reader.cancel() as soon as the running total
      // exceeds MAX_SIZE_BYTES.  The WHATWG streams spec guarantees that
      // reader.cancel() invokes the underlying source's cancel() hook, which
      // in this test unblocks the pending pull() promise so the stream can
      // clean up.  The overall uploadPOST() call must therefore resolve within
      // the 1 s vitest timeout rather than hanging indefinitely.
      const CHUNK_SIZE = 1024; // 1 KiB
      const MAX_SIZE_BYTES = 25 * 1024 * 1024;
      const CHUNKS_TO_LIMIT = MAX_SIZE_BYTES / CHUNK_SIZE; // 25,600 — cumulative = 25 MiB exactly (accepted)

      let sent = 0;
      let cancelCalled = false;
      // Capture the resolve callback of the blocking pull() promise so that
      // cancel() can release it, letting the ReadableStream internals finish.
      let pendingResolve: (() => void) | null = null;

      const chunk = new Uint8Array(CHUNK_SIZE);
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent < CHUNKS_TO_LIMIT + 1) {
            // Send chunks synchronously (no setImmediate) until one chunk past
            // the limit has been enqueued.  At that point the route will call
            // reader.cancel() on the very next await reader.read() return.
            controller.enqueue(chunk);
            sent++;
            return;
          }
          // All CHUNKS_TO_LIMIT + 1 chunks have been sent.  From here the
          // producer intentionally holds the stream open — returning a Promise
          // that never resolves on its own.  Only the cancel() hook below can
          // unblock it, which fires when reader.cancel() is called by the route.
          return new Promise<void>((resolve) => {
            pendingResolve = resolve;
          });
        },
        cancel() {
          cancelCalled = true;
          // Unblock the stalled pull() promise so the ReadableStream internals
          // can settle.  Without this the stream would remain suspended even
          // after cancellation; resolving it here lets Vitest confirm no open
          // handles remain at the end of the test.
          if (pendingResolve) pendingResolve();
        },
      });

      const req = makeRequest({ contentType: "image/jpeg", body });

      const res = await uploadPOST(req);

      expect(res.status).toBe(413);
      expect(mockPutObject).not.toHaveBeenCalled();
      // Confirm reader.cancel() was actually invoked — not merely a loop break.
      expect(cancelCalled).toBe(true);
    }, 1_000 /* must complete within 1 s — hangs would be caught immediately */);
    it("stall mid-stream (under limit): client sends 4 KiB then stalls forever without closing → 408 within deadline, no hang", async () => {
      mockSession.value = { userId: `user-${uid()}` };

      // Use a short read-timeout so the test completes quickly.
      // getReadTimeoutMs() in the route reads process.env.UPLOAD_READ_TIMEOUT_MS
      // on each call, so stubbing it here is sufficient.
      vi.stubEnv("UPLOAD_READ_TIMEOUT_MS", "2000");

      // Build a stream that emits 4 × 1-KiB chunks (4 KiB — well under 25 MiB)
      // then stalls permanently: neither sending more data nor closing the stream.
      // The stream therefore never triggers the byte-limit guard.  Only a
      // server-side read deadline can unblock the route.
      const INITIAL_CHUNKS = 4;
      const CHUNK_SIZE = 1024; // 1 KiB
      const chunk = new Uint8Array(CHUNK_SIZE);
      let sent = 0;
      let cancelCalled = false;
      let pendingResolve: (() => void) | null = null;

      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent < INITIAL_CHUNKS) {
            controller.enqueue(chunk);
            sent++;
            return; // synchronous — no delay between the initial chunks
          }
          // All initial chunks have been sent.  The producer intentionally
          // stalls here: returning a Promise that never resolves on its own.
          // The route's read timeout will fire and call reader.cancel(), which
          // invokes the cancel() hook below and unblocks this promise.
          return new Promise<void>((resolve) => {
            pendingResolve = resolve;
          });
        },
        cancel() {
          cancelCalled = true;
          // Unblock the stalled pull() promise so the ReadableStream internals
          // can settle cleanly and Vitest reports no open handles.
          if (pendingResolve) pendingResolve();
        },
      });

      const req = makeRequest({ contentType: "image/jpeg", body });

      const res = await uploadPOST(req);

      // Restore the env var so subsequent tests use the default timeout.
      vi.unstubAllEnvs();

      // The route must abort the stalled upload, not hang indefinitely.
      expect(res.status).toBe(408);
      expect(mockPutObject).not.toHaveBeenCalled();

      // Confirm the route actually called reader.cancel() rather than just
      // timing out internally while leaving the stream open.
      expect(cancelCalled).toBe(true);
    }, 6_000 /* 2 s timeout + generous headroom; hangs caught immediately */);

    it("multipart/form-data with sub-25-MiB image → 200, putObject called with file bytes", async () => {
      mockSession.value = { userId: `user-${uid()}` };
      mockPutObject.mockResolvedValue(undefined);

      // Build a well-formed multipart/form-data body using the platform FormData
      // and File APIs so the boundary encoding is handled correctly.  The file
      // field must be named "file" and contain an image/* blob.
      const fileBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]); // JPEG magic header
      const file = new File([fileBytes], "photo.jpg", { type: "image/jpeg" });
      const formData = new FormData();
      formData.append("file", file);

      // new Request() with a FormData body sets Content-Type automatically
      // to "multipart/form-data; boundary=…".
      const req = new Request("https://example.com/api/storage/upload", {
        method: "POST",
        body: formData,
      }) as any;

      const res = await uploadPOST(req);
      const resBody = await res.json();

      expect(res.status).toBe(200);
      expect(resBody.objectPath).toMatch(/^\/objects\/uploads\//);
      expect(mockPutObject).toHaveBeenCalledTimes(1);

      // putObject must have received the exact bytes from the file field —
      // not just a blob of the right length, but the same byte sequence.
      const blobArg: Blob = mockPutObject.mock.calls[0]![1] as Blob;
      const uploadedBytes = new Uint8Array(await blobArg.arrayBuffer());
      expect(uploadedBytes).toEqual(fileBytes);
    });

    it("concurrent uploads: near-limit → 200 and over-limit → 413 independently", async () => {
      // This test confirms that the per-request byte counter (totalBytes) is
      // local to each invocation and does not bleed between concurrent calls.
      mockSession.value = { userId: `user-${uid()}` };
      mockPutObject.mockResolvedValue(undefined);

      const MAX_SIZE_BYTES = 25 * 1024 * 1024;

      // Near-limit request: exactly MAX_SIZE_BYTES (should be accepted → 200).
      const nearLimitChunk = new Uint8Array(MAX_SIZE_BYTES);
      const nearLimitBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(nearLimitChunk);
          controller.close();
        },
      });
      const nearLimitReq = makeRequest({
        contentType: "image/jpeg",
        body: nearLimitBody,
      });

      // Over-limit request: MAX_SIZE_BYTES + 1 (should be rejected → 413).
      const overLimitChunk = new Uint8Array(MAX_SIZE_BYTES + 1);
      const overLimitBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(overLimitChunk);
          controller.close();
        },
      });
      const overLimitReq = makeRequest({
        contentType: "image/jpeg",
        body: overLimitBody,
      });

      // Fire both concurrently.
      const [nearRes, overRes] = await Promise.all([
        uploadPOST(nearLimitReq),
        uploadPOST(overLimitReq),
      ]);

      expect(nearRes.status).toBe(200);
      expect(overRes.status).toBe(413);
    });
  },
);
