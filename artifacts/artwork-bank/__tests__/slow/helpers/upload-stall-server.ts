/**
 * Minimal plain Node.js HTTP server used by the upload stall slow test to
 * verify that the per-chunk read timeout fires on a real, fully-live TCP
 * connection — calling the same production `readStreamWithDeadlines` that the
 * upload route uses.
 *
 * WHY THIS SERVER EXISTS (not next dev / next start)
 * ──────────────────────────────────────────────────
 * Next.js 15's App Router fully buffers the HTTP request body via its
 * multi-process worker IPC before invoking the route handler.  This means
 * there is no external HTTP transport (chunked with no terminator,
 * Content-Length + partial body, HTTP/1.0, Expect: 100-continue) that can
 * present a stalling body to the route handler through the Next.js pipeline.
 * Every stalling request either times out at the test window or is rejected
 * by Next.js's HTTP layer before reaching the route.
 *
 * A plain Node.js `createServer` does NOT buffer: it fires the 'request' event
 * as soon as headers arrive and delivers body data as it comes from the TCP
 * socket.  The ReadableStream built from IncomingMessage.on('data') therefore
 * genuinely blocks on reader.read() when the client goes silent — exactly the
 * stall that readStreamWithDeadlines defends against.
 *
 * WHAT THIS SERVER TESTS
 * ──────────────────────
 * This server calls the real `readStreamWithDeadlines` from
 * `lib/upload-read-stream.ts` — the same function imported by the upload
 * route.  Any regression in the production timeout logic (wrong error name,
 * wrong error classification, removed guard, etc.) is therefore caught by this
 * slow test, not just by the in-process synthetic-stream tests.
 *
 * The auth check uses iron-session's `unsealData` directly against the raw
 * Cookie header.  `getSession()` from lib/auth.ts calls `cookies()` from
 * next/headers, which requires Next.js's AsyncLocalStorage request context and
 * is not available outside the Next.js runtime.
 *
 * USAGE (spawned by the slow test)
 * ──────────────────────────────────
 *   UPLOAD_SERVER_PORT=0 \
 *   UPLOAD_READ_TIMEOUT_MS=1500 \
 *   SESSION_SECRET=<value or unset> \
 *   tsx __tests__/slow/helpers/upload-stall-server.ts
 *
 * The server writes "READY:<port>\n" to stdout once it is listening.  Set
 * UPLOAD_SERVER_PORT=0 to let the OS pick a free port.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { unsealData } from "iron-session";
import {
  getReadTimeoutMs,
  getTotalTimeoutMs,
  readStreamWithDeadlines,
} from "../../../lib/upload-read-stream";

// ── Configuration ─────────────────────────────────────────────────────────────

const SESSION_SECRET = process.env.SESSION_SECRET;
const DEV_FALLBACK_SECRET = "dev-fallback-secret-must-be-32-chars!";
/** The password passed to iron-session: real secret when set, dev fallback otherwise. */
const password = SESSION_SECRET || DEV_FALLBACK_SECRET;

/** Cookie name — must match lib/session.ts. */
const COOKIE_NAME = "artwork_bank_session";

// ── Auth helper ───────────────────────────────────────────────────────────────

/**
 * Resolve the userId from the request's Cookie header.
 *
 * Calls iron-session's unsealData directly against the raw header rather than
 * going through getSession() / cookies() from next/headers, which requires a
 * Next.js AsyncLocalStorage context that is not available outside the Next.js
 * runtime.
 */
async function resolveUserId(req: IncomingMessage): Promise<string | null> {
  const cookieHeader = req.headers.cookie ?? "";
  const cookies: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const [k, ...vs] = part.trim().split("=");
    if (k) cookies[k.trim()] = vs.join("=").trim();
  }
  const sealed = cookies[COOKIE_NAME];
  if (!sealed) return null;
  try {
    const session = await unsealData<{ userId?: string }>(sealed, { password });
    return session.userId ?? null;
  } catch {
    return null;
  }
}

// ── Body streaming helper ─────────────────────────────────────────────────────

/**
 * Wrap an IncomingMessage in a WHATWG ReadableStream.
 *
 * Plain Node.js HTTP servers do NOT buffer the request body: data events fire
 * as TCP delivers bytes.  This makes reader.read() genuinely block when the
 * client goes silent, which is exactly what readStreamWithDeadlines needs to
 * fire the per-chunk timeout.
 *
 * No `cancel()` hook — intentionally.  The IncomingMessage shares its
 * underlying TCP socket with the ServerResponse.  Destroying the socket via a
 * cancel hook before res.end() is called would prevent the 408 response from
 * being delivered to the client.
 */
function incomingToReadable(req: IncomingMessage): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      req.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
      });
      req.on("end", () => {
        controller.close();
      });
      req.on("error", (err) => {
        controller.error(err);
      });
    },
    // No cancel() here: see note above.
  });
}

// ── Request handler ───────────────────────────────────────────────────────────

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== "POST" || req.url !== "/api/storage/upload") {
    res.writeHead(404, { "Content-Type": "application/json", "Connection": "close" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  // Auth check — mirrors the real route's first step.
  const userId = await resolveUserId(req);
  if (!userId) {
    res.writeHead(401, { "Content-Type": "application/json", "Connection": "close" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  // Content-type gate — mirrors the real route's second step.
  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.startsWith("image/") && !contentType.startsWith("multipart/form-data")) {
    res.writeHead(400, { "Content-Type": "application/json", "Connection": "close" });
    res.end(JSON.stringify({ error: "Content-Type must be an image/* type" }));
    return;
  }

  // Read the body using the REAL production readStreamWithDeadlines from
  // lib/upload-read-stream.ts.  This is the same function the upload route
  // imports.  Any regression in the production timeout logic is therefore
  // caught by this slow test.
  const reader = incomingToReadable(req).getReader();
  const { timedOut, timeoutKind, readError } = await readStreamWithDeadlines(
    reader,
    25 * 1024 * 1024, // 25 MiB — matches the route's MAX_SIZE_BYTES
    getReadTimeoutMs(),
    getTotalTimeoutMs(),
  );

  if (timedOut) {
    const message =
      timeoutKind === "total"
        ? "Upload timed out: upload took too long"
        : "Upload timed out: client stalled mid-stream";
    res.writeHead(408, { "Content-Type": "application/json", "Connection": "close" });
    res.end(JSON.stringify({ error: message }));
    return;
  }

  if (readError) {
    res.writeHead(400, { "Content-Type": "application/json", "Connection": "close" });
    res.end(JSON.stringify({ error: "Failed to read request body" }));
    return;
  }

  // Body read successfully — return a stub success (putObject is not exercised
  // here; storage credentials are not available in the test environment).
  res.writeHead(200, { "Content-Type": "application/json", "Connection": "close" });
  res.end(JSON.stringify({ objectPath: "/objects/uploads/stall-test-stub" }));
}

// ── Server bootstrap ──────────────────────────────────────────────────────────

const port = parseInt(process.env.UPLOAD_SERVER_PORT ?? "0", 10);
const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error("[upload-stall-server] Unhandled error:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Connection": "close" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  });
});

server.listen(port, "127.0.0.1", () => {
  const addr = server.address() as { port: number };
  // Signal to the test that the server is ready and report the actual port.
  process.stdout.write(`READY:${addr.port}\n`);
});
