/**
 * POST /api/storage/upload
 *
 * Single-step server-side file upload. The browser sends either:
 *   (a) the raw file bytes with Content-Type: image/*
 *   (b) a multipart/form-data body with a "file" field
 *
 * This route uploads the bytes to the configured storage backend using a
 * server-to-server call, entirely avoiding browser CORS restrictions.
 *
 * Why server-side instead of @vercel/blob/client browser upload:
 *   The @vercel/blob/client upload() function sends PUT requests to
 *   https://vercel.com/api/blob (the Vercel management API), which does not
 *   emit CORS headers for arbitrary browser origins. The result is a 400 with
 *   "No Access-Control-Allow-Origin" in the browser console. Proxying through
 *   our own API route keeps BLOB_READ_WRITE_TOKEN server-side only and removes
 *   the CORS dependency.
 *
 * Request (raw):
 *   POST /api/storage/upload
 *   Content-Type: image/*
 *   Body: raw file bytes
 *
 * Request (form):
 *   POST /api/storage/upload
 *   Content-Type: multipart/form-data; boundary=…
 *   Body: multipart body with a "file" field whose sub-type is image/*
 *
 * Response 200:
 *   { objectPath: "/objects/uploads/<uuid>" }
 *
 * The caller must then call addArtworkImage(artworkId, objectPath, filename)
 * to create the DB record.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  putObject,
  StorageNotConfiguredError,
} from "@/lib/object-storage";
import { BlobError, BlobNotFoundError } from "@vercel/blob";

export const dynamic = "force-dynamic";

const ALLOWED_CONTENT_TYPE_PREFIX = "image/";
const MAX_SIZE_BYTES = 25 * 1024 * 1024; // 25 MiB — file-level limit

// Extra budget for multipart envelope (boundary markers, part headers, CRLF).
// A typical multipart envelope is well under 1 KiB; 64 KiB is a generous cap
// that prevents rejecting a valid 25 MiB file while still bounding buffering.
const MULTIPART_OVERHEAD_BUDGET = 64 * 1024; // 64 KiB
const MAX_MULTIPART_TOTAL_BYTES = MAX_SIZE_BYTES + MULTIPART_OVERHEAD_BUDGET;

// ─── helpers ─────────────────────────────────────────────────────────────────

function storageSizeError() {
  return NextResponse.json(
    { error: `File exceeds the maximum allowed size of ${MAX_SIZE_BYTES / (1024 * 1024)} MB` },
    { status: 413 },
  );
}

function handleStorageError(err: unknown) {
  if (
    err instanceof StorageNotConfiguredError ||
    (err instanceof BlobError && !(err instanceof BlobNotFoundError))
  ) {
    console.error("[storage/upload] Storage misconfigured:", err);
    return NextResponse.json(
      { error: "Storage misconfigured — check storage environment variables" },
      { status: 500 },
    );
  }
  console.error("[storage/upload] Upload failed:", err);
  return NextResponse.json({ error: "Upload failed" }, { status: 500 });
}

/**
 * Per-chunk read deadline in milliseconds.  If a single reader.read() call
 * does not resolve within this window the upload is aborted with 408.
 *
 * Configurable via UPLOAD_READ_TIMEOUT_MS so integration tests can inject a
 * short deadline without altering production behaviour.  Defaults to 30 s.
 */
function getReadTimeoutMs(): number {
  return Number(process.env.UPLOAD_READ_TIMEOUT_MS ?? "30000");
}

/**
 * Race reader.read() against a deadline.  Clears the timer on success so that
 * fast streams don't accumulate open timer handles.
 *
 * Throws an Error with name "UploadReadTimeout" when the deadline fires.
 */
async function readChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const ms = getReadTimeoutMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`Upload stalled: no data received within ${ms} ms`);
      err.name = "UploadReadTimeout";
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([reader.read(), timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read a ReadableStream<Uint8Array> incrementally, collecting chunks until the
 * stream is exhausted or the running total exceeds `limitBytes`. Cancels the
 * reader as soon as the limit is exceeded so the sender stops early.
 *
 * Returns `{ chunks, totalBytes, oversized }`. The caller checks `oversized`
 * before using `chunks`; if true the body was discarded.
 */
async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  limitBytes: number,
): Promise<{ chunks: BlobPart[]; totalBytes: number; oversized: boolean }> {
  const chunks: BlobPart[] = [];
  let totalBytes = 0;
  let oversized = false;
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > limitBytes) {
        oversized = true;
        await reader.cancel();
        break;
      }
      // Cast required: Uint8Array<ArrayBufferLike> is not assignable to BlobPart
      // (which requires ArrayBufferView<ArrayBuffer>) in strict TS, but the
      // runtime behaviour is identical.
      chunks.push(value as BlobPart);
    }
  } catch {
    throw new Error("stream-read-failed");
  }
  return { chunks, totalBytes, oversized };
}

// ─── route ───────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const contentType = request.headers.get("content-type") ?? "";
  const isRawImage = contentType.startsWith(ALLOWED_CONTENT_TYPE_PREFIX);
  const isMultipart = contentType.startsWith("multipart/form-data");

  if (!isRawImage && !isMultipart) {
    return NextResponse.json(
      { error: "Content-Type must be an image/* type" },
      { status: 400 },
    );
  }

  // ── multipart/form-data path ────────────────────────────────────────────────
  if (isMultipart) {
    if (!request.body) {
      return NextResponse.json({ error: "Request body is empty" }, { status: 400 });
    }

    // Fast-path: reject early if the client declares an oversized Content-Length.
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > MAX_MULTIPART_TOTAL_BYTES) {
      return storageSizeError();
    }

    // Stream-cap the raw body BEFORE parsing.  request.formData() buffers the
    // entire body internally; calling it directly would allow an attacker to
    // force unbounded memory use on requests that omit Content-Length (chunked
    // / streaming).  By reading the stream ourselves first with a hard byte
    // cap, we guarantee at most MAX_MULTIPART_TOTAL_BYTES are ever in memory
    // regardless of what the client claims.
    let chunks: BlobPart[];
    let oversized: boolean;
    try {
      ({ chunks, oversized } = await readBoundedStream(
        request.body,
        MAX_MULTIPART_TOTAL_BYTES,
      ));
    } catch {
      return NextResponse.json(
        { error: "Failed to read request body" },
        { status: 400 },
      );
    }

    if (oversized) {
      // Total request body exceeded MAX_MULTIPART_TOTAL_BYTES — definitely over
      // the file limit even accounting for envelope overhead.
      return storageSizeError();
    }

    // Re-wrap the bounded bytes into a new Request so the platform's built-in
    // multipart parser can decode the form structure safely.
    let formData: FormData;
    try {
      const boundedReq = new Request("https://localhost/", {
        method: "POST",
        headers: { "content-type": contentType },
        body: new Blob(chunks),
        // @ts-expect-error -- duplex required for bodies in some environments
        duplex: "half",
      });
      formData = await boundedReq.formData();
    } catch {
      return NextResponse.json(
        { error: "Failed to parse form data" },
        { status: 400 },
      );
    }

    const fileField = formData.get("file");
    if (!(fileField instanceof File) || fileField.size === 0) {
      return NextResponse.json(
        { error: "Request body is empty" },
        { status: 400 },
      );
    }

    const fileType = fileField.type;
    if (!fileType.startsWith(ALLOWED_CONTENT_TYPE_PREFIX)) {
      return NextResponse.json(
        { error: "Content-Type must be an image/* type" },
        { status: 400 },
      );
    }

    // Check the extracted file size against the file-level limit (not the
    // total body limit — a valid 25 MiB file is fine even though the multipart
    // body is slightly larger due to envelope overhead).
    if (fileField.size > MAX_SIZE_BYTES) {
      return storageSizeError();
    }

    const uuid = crypto.randomUUID();
    const entityId = `uploads/${uuid}`;
    const objectPath = `/objects/${entityId}`;

    try {
      await putObject(entityId, fileField, fileType);
      return NextResponse.json({ objectPath });
    } catch (err) {
      return handleStorageError(err);
    }
  }

  // ── raw image/* path ────────────────────────────────────────────────────────

  if (!request.body) {
    return NextResponse.json({ error: "Request body is empty" }, { status: 400 });
  }

  // Fast-path: reject early if the client declares an oversized Content-Length.
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_SIZE_BYTES) {
    return storageSizeError();
  }

  // Enforce the limit on the actual byte stream regardless of whether the
  // client supplied a Content-Length header (chunked / streaming uploads skip
  // it).  We count bytes incrementally so we can abort as soon as the limit is
  // exceeded, avoiding buffering the entire oversized body into RAM.
  // readChunkWithTimeout races each read against a deadline so that a client
  // that stalls mid-stream (sending neither data nor EOF) is rejected with 408
  // rather than hanging the server connection indefinitely.
  const chunks: BlobPart[] = [];
  let totalBytes = 0;
  let oversized = false;

  const reader = request.body.getReader();
  try {
    while (true) {
      const { done, value } = await readChunkWithTimeout(reader);
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_SIZE_BYTES) {
        oversized = true;
        // Cancel the stream to signal the sender to stop sending.
        await reader.cancel();
        break;
      }
      // Cast required: ReadableStreamReadResult yields Uint8Array<ArrayBufferLike>
      // which TypeScript's strict DOM types don't consider assignable to BlobPart
      // (which requires ArrayBufferView<ArrayBuffer>).  The runtime behaviour is
      // identical — Blob accepts Uint8Array regardless of the buffer's concrete
      // TypeScript brand.
      chunks.push(value as unknown as BlobPart);
    }
  } catch (err) {
    // Best-effort cleanup — ignore errors from cancel() itself.
    reader.cancel().catch(() => {});

    if (err instanceof Error && err.name === "UploadReadTimeout") {
      return NextResponse.json(
        { error: "Upload timed out: client stalled mid-stream" },
        { status: 408 },
      );
    }
    return NextResponse.json({ error: "Failed to read request body" }, { status: 400 });
  }

  if (oversized) {
    return storageSizeError();
  }

  if (totalBytes === 0) {
    return NextResponse.json({ error: "Request body is empty" }, { status: 400 });
  }

  const uuid = crypto.randomUUID();
  const entityId = `uploads/${uuid}`;
  const objectPath = `/objects/${entityId}`;

  try {
    await putObject(entityId, new Blob(chunks, { type: contentType }), contentType);
    return NextResponse.json({ objectPath });
  } catch (err) {
    return handleStorageError(err);
  }
}
