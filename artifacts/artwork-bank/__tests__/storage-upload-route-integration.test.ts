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

/** A ReadableStream that closes immediately (empty body). */
function closedStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.close(); } });
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
        body: closedStream(),
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
        makeRequest({ contentType: "image/png", body: closedStream() }),
      );
      const res2 = await uploadPOST(
        makeRequest({ contentType: "image/png", body: closedStream() }),
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
        body: closedStream(),
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
        body: closedStream(),
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
        body: closedStream(),
      });

      await uploadPOST(req);

      expect(mockPutObject).toHaveBeenCalledTimes(1);
      const [entityId, , contentType] = mockPutObject.mock.calls[0]!;
      expect(entityId).toMatch(/^uploads\/[0-9a-f-]{36}$/);
      expect(contentType).toBe("image/webp");
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
