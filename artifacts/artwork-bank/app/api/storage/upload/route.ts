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
 * Total wall-clock deadline for the entire body-reading loop, in milliseconds.
 *
 * A slow-drip attacker can evade the per-chunk deadline by sending one tiny
 * chunk just before each per-read timeout fires, keeping the connection alive
 * indefinitely while never triggering the byte-limit guard.  This deadline
 * caps the total time spent in the reading loop regardless of chunk cadence.
 *
 * The deadline is enforced by including it in every Promise.race() call so
 * that a read which began just before the deadline is interrupted the moment
 * the timer fires — not after the per-chunk timeout fires independently.
 *
 * Configurable via UPLOAD_TOTAL_TIMEOUT_MS so integration tests can inject a
 * short deadline without altering production behaviour.  Defaults to 2 min.
 */
function getTotalTimeoutMs(): number {
  return Number(process.env.UPLOAD_TOTAL_TIMEOUT_MS ?? "120000");
}

type ReadResult = {
  chunks: BlobPart[];
  totalBytes: number;
  oversized: boolean;
  timedOut: boolean;
  timeoutKind: "read" | "total" | null;
};
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
    const { chunks, oversized, timedOut, timeoutKind } =
      await readStreamWithDeadlines(
        reader,
        MAX_MULTIPART_TOTAL_BYTES,
        getReadTimeoutMs(),
        getTotalTimeoutMs(),
      );

    if (timedOut) return timeoutResponse(timeoutKind);

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
  const { chunks, totalBytes, oversized, timedOut, timeoutKind } =
    await readStreamWithDeadlines(
      reader,
      MAX_SIZE_BYTES,
      getReadTimeoutMs(),
      getTotalTimeoutMs(),
    );

  if (timedOut) return timeoutResponse(timeoutKind);
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

/**
 * Read all chunks from `reader` with two concurrently enforced deadlines:
 *
 *   Per-chunk deadline (readTimeoutMs):
 *     Each individual reader.read() must resolve within this window.  A client
 *     that sends data and then stalls indefinitely is caught here.
 *
 *   Total wall-clock deadline (totalTimeoutMs):
 *     The entire reading loop must complete within this window.  A slow-drip
 *     client that sends one tiny burst just under the per-chunk deadline and
 *     then repeats — never stalling long enough on any single read to trigger
 *     the per-chunk guard — is caught here.
 *
 * Both deadlines are wired into every Promise.race() so that a read that is
 * already in-flight is interrupted the instant either timer fires, rather than
 * waiting for the current read to resolve first.
 *
 * Also enforces a running byte limit: cancels the reader and sets oversized if
 * the accumulated byte count exceeds `limitBytes`.
 */
async function readStreamWithDeadlines(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  limitBytes: number,
  readTimeoutMs: number,
  totalTimeoutMs: number,
): Promise<ReadResult> {
  const chunks: BlobPart[] = [];
  let totalBytes = 0;
  let oversized = false;
  let timedOut = false;
  let timeoutKind: "read" | "total" | null = null;

  // Build the total-deadline promise once outside the loop.  It persists
  // across all iterations, so it fires at the absolute wall-clock limit
  // regardless of how many reads have completed — unlike a per-iteration
  // Date.now() check, which can only detect an overrun *after* the current
  // read returns.
  //
  // Adding .catch(() => {}) suppresses the unhandled-rejection warning for the
  // brief moments between loop iterations when no Promise.race is active.  The
  // rejection is still consumed correctly inside the race when it fires.
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  const totalTimeoutPromise = new Promise<never>((_, reject) => {
    totalTimer = setTimeout(() => {
      const err = new Error("Upload timed out: upload took too long");
      err.name = "UploadTotalTimeout";
      reject(err);
    }, totalTimeoutMs);
  });
  totalTimeoutPromise.catch(() => {});

  try {
    while (true) {
      // Per-chunk deadline: a fresh timer for each reader.read() call.
      // Cleared in the inner finally so fast reads leave no lingering handles.
      let readTimer: ReturnType<typeof setTimeout> | undefined;
      const readTimeoutPromise = new Promise<never>((_, reject) => {
        readTimer = setTimeout(() => {
          const err = new Error(
            `Upload stalled: no data received within ${readTimeoutMs} ms`,
          );
          err.name = "UploadReadTimeout";
          reject(err);
        }, readTimeoutMs);
      });

      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await Promise.race([
          reader.read(),
          readTimeoutPromise,
          totalTimeoutPromise,
        ]);
      } finally {
        clearTimeout(readTimer);
      }

      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > limitBytes) {
        oversized = true;
        // Cancel the stream to signal the sender to stop sending.
        reader.cancel().catch(() => {});
        break;
      }
      // Cast required: Uint8Array<ArrayBufferLike> is not assignable to BlobPart
      // (which requires ArrayBufferView<ArrayBuffer>) in strict TS, but the
      // runtime behaviour is identical.
      chunks.push(result.value as unknown as BlobPart);
    }
  } catch (err) {
    // Best-effort cleanup — ignore errors from cancel() itself.
    reader.cancel().catch(() => {});
    timedOut = true;
    if (err instanceof Error && err.name === "UploadTotalTimeout") {
      timeoutKind = "total";
    } else if (err instanceof Error && err.name === "UploadReadTimeout") {
      timeoutKind = "read";
    }
  } finally {
    // Always clear the total-deadline timer.  If the loop completed normally
    // (no timeout), this prevents the timer from firing after the function
    // returns and causing a spurious unhandled rejection.
    clearTimeout(totalTimer);
  }

  return { chunks, totalBytes, oversized, timedOut, timeoutKind };
}

function timeoutResponse(kind: "read" | "total" | null) {
  const message =
    kind === "total"
      ? "Upload timed out: upload took too long"
      : "Upload timed out: client stalled mid-stream";
  return NextResponse.json({ error: message }, { status: 408 });
}
