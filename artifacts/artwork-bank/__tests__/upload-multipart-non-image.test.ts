/**
 * Task #642 — Confirm the multipart upload rejects files that aren't images
 * even inside a valid multipart/form-data envelope.
 *
 * Context
 * ───────
 * POST /api/storage/upload accepts two body shapes:
 *   (a) raw image/* bytes        — Content-Type: image/*
 *   (b) multipart/form-data      — Content-Type: multipart/form-data; boundary=...
 *
 * The multipart path independently validates the *embedded* file's Content-Type
 * (route.ts lines 171-177):
 *
 *   const fileType = fileField.type;
 *   if (!fileType.startsWith("image/")) {
 *     return NextResponse.json({ error: "Content-Type must be an image/* type" }, { status: 400 });
 *   }
 *
 * This is a separate guard from the outer Content-Type check (line 95-99) that
 * already rejects non-multipart / non-image outer headers. Without this inner
 * check a caller could bypass image validation by wrapping a PDF or text file
 * inside a valid multipart/form-data envelope.
 *
 * What this test verifies
 * ───────────────────────
 *  1. text/plain embedded file → 400 "Content-Type must be an image/* type"
 *  2. application/pdf embedded file → 400 "Content-Type must be an image/* type"
 *  3. application/octet-stream embedded file → 400
 *  4. A valid image/jpeg embedded file → 200 { objectPath }
 *  5. A valid image/png embedded file → 200 { objectPath }
 *  6. Missing "file" field entirely → 400
 *  7. putObject is not called on any validation failure
 *  8. multipart with no body (Content-Type only, body = null) → 400
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ── Auth mock — always returns a logged-in user ───────────────────────────────
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ userId: "multipart-test-user" })),
}));

// ── Storage mock — putObject should not be called on validation failures ──────
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

afterEach(() => {
  mockPutObject.mockClear();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a NextRequest whose body is a valid multipart/form-data body containing
 * a single "file" field with the given type and content.
 *
 * We use the platform's FormData + Request to produce a correctly-encoded
 * multipart body (boundary, part headers, CRLF terminator), then stream those
 * bytes into a NextRequest.
 */
async function makeMultipartRequest(opts: {
  fileName?: string;
  fileType?: string;
  fileContent?: Uint8Array;
  fieldName?: string;
}): Promise<NextRequest> {
  const {
    fileName = "upload.jpg",
    fileType = "image/jpeg",
    fileContent = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), // JPEG magic
    fieldName = "file",
  } = opts;

  const form = new FormData();
  form.append(fieldName, new File([fileContent], fileName, { type: fileType }));

  // Use a temporary Request to get the serialized body + boundary-bearing header.
  const tmp = new Request("https://localhost/", { method: "POST", body: form });
  const bodyBytes = new Uint8Array(await tmp.arrayBuffer());
  const ct = tmp.headers.get("content-type")!; // multipart/form-data; boundary=...

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bodyBytes);
      controller.close();
    },
  });

  return new NextRequest("https://example.com/api/storage/upload", {
    method: "POST",
    headers: { "content-type": ct },
    body: stream,
    // @ts-expect-error — duplex required for streaming bodies in Node.js
    duplex: "half",
  });
}

/** Build a multipart request with no "file" field at all (empty form). */
async function makeMultipartNoFileRequest(): Promise<NextRequest> {
  // FormData with an unrelated field — no "file" key.
  const form = new FormData();
  form.append("other", new Blob(["data"]));

  const tmp = new Request("https://localhost/", { method: "POST", body: form });
  const bodyBytes = new Uint8Array(await tmp.arrayBuffer());
  const ct = tmp.headers.get("content-type")!;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bodyBytes);
      controller.close();
    },
  });

  return new NextRequest("https://example.com/api/storage/upload", {
    method: "POST",
    headers: { "content-type": ct },
    body: stream,
    // @ts-expect-error
    duplex: "half",
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("multipart upload — non-image file rejection (Task #642)", () => {
  it("text/plain inside valid multipart envelope → 400 with image/* error", async () => {
    const req = await makeMultipartRequest({
      fileName: "notes.txt",
      fileType: "text/plain",
      fileContent: new Uint8Array(Buffer.from("hello world")),
    });

    const res = await POST(req as any);
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/image/i);
    expect(mockPutObject).not.toHaveBeenCalled();
  });

  it("application/pdf inside valid multipart envelope → 400 with image/* error", async () => {
    const req = await makeMultipartRequest({
      fileName: "document.pdf",
      fileType: "application/pdf",
      fileContent: new Uint8Array(Buffer.from("%PDF-1.4")),
    });

    const res = await POST(req as any);
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/image/i);
    expect(mockPutObject).not.toHaveBeenCalled();
  });

  it("application/octet-stream inside valid multipart envelope → 400", async () => {
    const req = await makeMultipartRequest({
      fileName: "binary.bin",
      fileType: "application/octet-stream",
      fileContent: new Uint8Array([0x00, 0x01, 0x02, 0x03]),
    });

    const res = await POST(req as any);
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/image/i);
    expect(mockPutObject).not.toHaveBeenCalled();
  });

  it("image/jpeg inside valid multipart envelope → 200 with objectPath", async () => {
    const req = await makeMultipartRequest({
      fileName: "photo.jpg",
      fileType: "image/jpeg",
      fileContent: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    });

    const res = await POST(req as any);
    const body = (await res.json()) as { objectPath?: string };

    expect(res.status).toBe(200);
    expect(body.objectPath).toMatch(/^\/objects\/uploads\//);
    expect(mockPutObject).toHaveBeenCalledTimes(1);
  });

  it("image/png inside valid multipart envelope → 200 with objectPath", async () => {
    const req = await makeMultipartRequest({
      fileName: "picture.png",
      fileType: "image/png",
      fileContent: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]),
    });

    const res = await POST(req as any);
    const body = (await res.json()) as { objectPath?: string };

    expect(res.status).toBe(200);
    expect(body.objectPath).toMatch(/^\/objects\/uploads\//);
    expect(mockPutObject).toHaveBeenCalledTimes(1);
  });

  it("multipart with no 'file' field → 400 (missing file guard)", async () => {
    const req = await makeMultipartNoFileRequest();

    const res = await POST(req as any);
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(400);
    expect(mockPutObject).not.toHaveBeenCalled();
  });

  it("multipart with null body → 400 (body guard fires before file-type check)", async () => {
    const req = new NextRequest("https://example.com/api/storage/upload", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=abc" },
      body: null,
    });

    const res = await POST(req as any);

    expect(res.status).toBe(400);
    expect(mockPutObject).not.toHaveBeenCalled();
  });

  it("putObject receives the correct content-type for a valid multipart image upload", async () => {
    const req = await makeMultipartRequest({
      fileName: "artwork.webp",
      fileType: "image/webp",
      fileContent: new Uint8Array([0x52, 0x49, 0x46, 0x46]), // RIFF magic
    });

    await POST(req as any);

    expect(mockPutObject).toHaveBeenCalledOnce();
    const [_entityId, _body, contentType] = mockPutObject.mock.calls[0]!;
    expect(contentType).toBe("image/webp");
  });
});
