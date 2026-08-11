/**
 * Shared body-reading primitives for the upload route.
 *
 * Extracted into a standalone lib so that:
 *   1. The route (app/api/storage/upload/route.ts) imports the production
 *      implementation.
 *   2. The slow stall test (tests/slow/helpers/upload-stall-server.ts) imports
 *      the same implementation against a plain Node.js HTTP server where the
 *      request body is genuinely streamed from the TCP layer.  This ensures
 *      the slow test exercises the real production code path rather than a
 *      reimplementation, so any regression in the timeout logic is caught.
 *
 * Neither function imports from Next.js, so this module is safe to use outside
 * the Next.js runtime (e.g. in a plain Node.js HTTP server used by tests).
 */

// ── Timeout configuration ─────────────────────────────────────────────────────

/**
 * Per-chunk read deadline in milliseconds.  If a single reader.read() call
 * does not resolve within this window the upload is aborted with 408.
 *
 * Configurable via UPLOAD_READ_TIMEOUT_MS so tests can inject a short deadline
 * without altering production behaviour.  Defaults to 30 s.
 */
export function getReadTimeoutMs(): number {
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
 * Configurable via UPLOAD_TOTAL_TIMEOUT_MS so tests can inject a short
 * deadline without altering production behaviour.  Defaults to 2 min.
 */
export function getTotalTimeoutMs(): number {
  return Number(process.env.UPLOAD_TOTAL_TIMEOUT_MS ?? "120000");
}

// ── Result type ───────────────────────────────────────────────────────────────

export type ReadResult = {
  chunks: BlobPart[];
  totalBytes: number;
  oversized: boolean;
  timedOut: boolean;
  timeoutKind: "read" | "total" | null;
  /**
   * true when reader.read() rejected with a non-timeout error (e.g. ECONNRESET,
   * protocol error).  Callers return 400 for stream errors — the client did not
   * stall; the connection broke.  This is intentionally distinct from `timedOut`
   * so callers cannot accidentally conflate a broken connection with a slow client.
   */
  readError: boolean;
};

// ── Core reading loop ─────────────────────────────────────────────────────────

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
export async function readStreamWithDeadlines(
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
  let readError = false;

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
    if (err instanceof Error && err.name === "UploadTotalTimeout") {
      timedOut = true;
      timeoutKind = "total";
    } else if (err instanceof Error && err.name === "UploadReadTimeout") {
      timedOut = true;
      timeoutKind = "read";
    } else {
      // A genuine stream read error (e.g. client reset, network failure).
      // Do NOT set timedOut — callers must return 400 for stream errors, not 408.
      readError = true;
    }
  } finally {
    // Always clear the total-deadline timer.  If the loop completed normally
    // (no timeout), this prevents the timer from firing after the function
    // returns and causing a spurious unhandled rejection.
    clearTimeout(totalTimer);
  }

  return { chunks, totalBytes, oversized, timedOut, timeoutKind, readError };
}
