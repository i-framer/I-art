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
import {
  getReadTimeoutMs,
  getTotalTimeoutMs,
  readStreamWithDeadlines,
} from "@/lib/upload-read-stream";

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
  // Capture a safe, non-secret debug string: BlobError messages are
  // standardised ("Access denied", "This store does not exist.", etc.) and
  // contain no credentials.  Including them in the 500 body lets an operator
  // diagnose the root cause from the browser Network tab without needing
  // access to Vercel function logs.
  const errType = err instanceof Error ? err.constructor.name : typeof err;
  const errMsg  = err instanceof Error ? err.message : String(err);
  const debug   = `${errType}: ${errMsg}`;

  if (
    err instanceof StorageNotConfiguredError ||
    (err instanceof BlobError && !(err instanceof BlobNotFoundError))
  ) {
    console.error("[storage/upload] Storage error:", debug, err);
    return NextResponse.json(
      { error: "Storage misconfigured — check storage environment variables", debug },
      { status: 500 },
    );
  }
  console.error("[storage/upload] Upload failed:", debug, err);
  return NextResponse.json({ error: "Upload failed", debug }, { status: 500 });
}

// getReadTimeoutMs, getTotalTimeoutMs, ReadResult, and readStreamWithDeadlines
// are all imported from @/lib/upload-read-stream above.
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

    // Stream-cap the raw body BEFORE parsing, with the same per-chunk and total
    // deadlines used by the raw path.  request.formData() buffers everything
    // internally, so calling it directly would allow:
    //   - unbounded memory use on chunked / streaming requests (no byte cap)
    //   - a slow-drip client to hold the connection open indefinitely (no timeout)
    // Reading through readStreamWithDeadlines enforces both limits before the
    // multipart parser ever sees the bytes.
    const reader = request.body.getReader();
    const { chunks, oversized, timedOut, timeoutKind, readError } =
      await readStreamWithDeadlines(
        reader,
        MAX_MULTIPART_TOTAL_BYTES,
        getReadTimeoutMs(),
        getTotalTimeoutMs(),
      );

    if (timedOut) return timeoutResponse(timeoutKind);
    if (readError) {
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

  // Enforce the byte limit and both timeouts on the actual byte stream.
  // readStreamWithDeadlines races every reader.read() against a per-chunk
  // deadline and a single persistent total-deadline timer, so:
  //   - a client that stalls on any single read is caught by the per-chunk guard
  //   - a slow-drip client that sends tiny bursts just under the per-chunk
  //     deadline is caught by the total-wall-clock guard
  //   - a client that lies about Content-Length is caught by the byte counter
  const reader = request.body.getReader();
  const { chunks, totalBytes, oversized, timedOut, timeoutKind, readError } =
    await readStreamWithDeadlines(
      reader,
      MAX_SIZE_BYTES,
      getReadTimeoutMs(),
      getTotalTimeoutMs(),
    );

  if (timedOut) return timeoutResponse(timeoutKind);
  if (readError) {
    return NextResponse.json(
      { error: "Failed to read request body" },
      { status: 400 },
    );
  }
  if (oversized) return storageSizeError();

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

// readStreamWithDeadlines is imported from @/lib/upload-read-stream above.

function timeoutResponse(kind: "read" | "total" | null) {
  const message =
    kind === "total"
      ? "Upload timed out: upload took too long"
      : "Upload timed out: client stalled mid-stream";
  return NextResponse.json({ error: message }, { status: 408 });
}
