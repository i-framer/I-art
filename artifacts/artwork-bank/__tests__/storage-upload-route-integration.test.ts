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
        body: new ReadableStream(),
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
        makeRequest({ contentType: "image/png", body: new ReadableStream() }),
      );
      const res2 = await uploadPOST(
        makeRequest({ contentType: "image/png", body: new ReadableStream() }),
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
        body: new ReadableStream(),
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
        body: new ReadableStream(),
      });

      const res = await uploadPOST(req);
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.error).toMatch(/upload failed/i);
    });

    it("valid session → putObject IS called with correct entityId format and content-type", async () => {
      mockSession.value = { userId: `user-${uid()}` };
      mockPutObject.mockResolvedValue(undefined);
      const req = makeRequest({
        contentType: "image/webp",
        body: new ReadableStream(),
      });

      await uploadPOST(req);

      expect(mockPutObject).toHaveBeenCalledTimes(1);
      const [entityId, , contentType] = mockPutObject.mock.calls[0]!;
      expect(entityId).toMatch(/^uploads\/[0-9a-f-]{36}$/);
      expect(contentType).toBe("image/webp");
    });
  },
);
