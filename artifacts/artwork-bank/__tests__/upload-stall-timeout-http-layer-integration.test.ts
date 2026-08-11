/**
 * Confirm the upload stall deadline is enforced end-to-end across a real TCP
 * socket — not merely in the route handler's unit logic.
 *
 * Why this test exists
 * ────────────────────
 * UPLOAD_READ_TIMEOUT_MS is documented and exercised in unit tests, but a
 * regression in how Next.js (or the test shim) streams request bodies could
 * silently bypass readChunkWithTimeout() while the unit test still passes.
 * Issuing a genuine fetch / raw-socket request over TCP exposes any
 * transformation between NextResponse.json({ status: 408 }) and the wire.
 *
 * What "stall" means here
 * ───────────────────────
 * The client opens a TCP connection, sends HTTP headers + a small initial
 * chunk (4 bytes, well under the 25 MiB body limit), then stops transmitting.
 * The server's readChunkWithTimeout() races reader.read() against a timer; when
 * the timer fires it rejects the race, the route catches the UploadReadTimeout
 * error, and the server writes HTTP 408 on the still-open socket.
 *
 * Isolation
 * ─────────
 * • getSession is mocked so auth always passes without a real DB or cookie.
 * • putObject is mocked so no real storage infrastructure is needed.
 * • UPLOAD_READ_TIMEOUT_MS is set to 300 ms so the test finishes quickly.
 *   The test timeout is set to 3 s to give ample headroom without depending
 *   on the 30 s production default.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "node:http";
import * as net from "node:net";

// ── Auth mock — always returns a logged-in user so the body-reading path runs ─

const mockSession: { value: { userId: string | null } } = {
  value: { userId: "integration-test-user" },
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => mockSession.value),
}));

// ── Storage mock — putObject must never be called on a stalled upload ─────────

vi.mock("@/lib/object-storage", () => ({
  putObject: vi.fn().mockResolvedValue(undefined),
  StorageNotConfiguredError: class StorageNotConfiguredError extends Error {
    constructor(message?: string) {
      super(message ?? "Storage not configured");
      this.name = "StorageNotConfiguredError";
    }
  },
}));

// ── Route import (after mocks are in place) ───────────────────────────────────

import { POST } from "@/app/api/storage/upload/route";
import { putObject } from "@/lib/object-storage";

const mockPutObject = vi.mocked(putObject);

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Convert a Node.js IncomingMessage body into a WHATWG ReadableStream so the
 * route handler can consume it with getReader() / read().  Data pauses on the
 * Node.js side propagate directly: when the sender stalls, reader.read()
 * blocks, letting the route's per-chunk deadline fire.
 *
 * Important: the cancel() hook does NOT destroy req.  In HTTP/1.1 the request
 * and response share the same TCP socket.  Calling req.destroy() would tear
 * down that socket, preventing the server from writing the 408 response back
 * to the client.  Instead we set a `cancelled` flag so that any belated "data"
 * events (which cannot arrive while the client is stalling) are silently
 * dropped rather than enqueued onto an already-cancelled controller.
 */
function incomingMessageToWebStream(
  req: http.IncomingMessage,
): ReadableStream<Uint8Array> {
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      req.on("data", (chunk: Buffer) => {
        if (!cancelled) {
          controller.enqueue(new Uint8Array(chunk));
        }
      });
      req.on("end", () => {
        if (!cancelled) controller.close();
      });
      req.on("error", (err) => {
        if (!cancelled) controller.error(err);
      });
    },
    cancel() {
      // Mark cancelled to prevent belated enqueues.  Do NOT destroy the socket
      // — req and res share the same TCP connection; destroying req here would
      // prevent the server from sending the 408 response on the same socket.
      cancelled = true;
    },
  });
}

// ── In-process HTTP server ─────────────────────────────────────────────────────
// Wraps the real route handler.  Incoming Node.js headers are forwarded as-is;
// the body is bridged through incomingMessageToWebStream() so a stalling TCP
// client produces a stalling reader.read() inside the route.

let server: http.Server;
let serverPort: number;

async function startServer(): Promise<void> {
  server = http.createServer(async (req, res) => {
    // Forward all request headers to the route.
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") {
        headers[key] = value;
      } else if (Array.isArray(value)) {
        headers[key] = value.join(", ");
      }
    }

    // Bridge the Node.js body stream to a WHATWG ReadableStream so the route's
    // readChunkWithTimeout() receives real back-pressure from the client.
    const bodyStream = incomingMessageToWebStream(req);

    const request = new Request(
      `http://127.0.0.1:${serverPort}${req.url ?? "/"}`,
      {
        method: req.method ?? "POST",
        headers,
        body: bodyStream,
        // @ts-expect-error -- duplex is required for streaming bodies in Node
        duplex: "half",
      },
    );

    try {
      const result = await POST(request as any);
      const body = await result.text();
      // Only write the response if the socket is still writable — the stalling
      // client may have disconnected before the server finishes.
      if (!res.headersSent) {
        res.writeHead(result.status, {
          "Content-Type":
            result.headers.get("content-type") ?? "application/json",
        });
        res.end(body);
      }
    } catch (_err) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const addr = server.address() as { port: number };
  serverPort = addr.port;
}

async function stopServer(): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

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

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(async () => {
  mockSession.value = { userId: "integration-test-user" };
  mockPutObject.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  await startServer();
});

afterEach(async () => {
  await stopServer();
  restoreEnv();
  vi.restoreAllMocks();
});

// ── Utilities ─────────────────────────────────────────────────────────────────

/**
 * Read the full HTTP response from a raw socket.
 *
 * Returns { statusCode, headers, body } after the server closes the connection
 * or the socket emits its "end" event.  We look for the blank line separating
 * headers from body (\r\n\r\n) and then read everything that follows.
 *
 * This is intentionally simple — we only need the status code for these tests.
 */
function readHttpResponse(
  socket: net.Socket,
  timeoutMs: number,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    let raw = "";

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out waiting for HTTP response after ${timeoutMs} ms`));
    }, timeoutMs);

    socket.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
      // Once we have the full response headers, we can read the status.
      // We wait for the body too but stop early once the connection closes.
    });

    socket.on("end", () => {
      clearTimeout(timer);
      // Parse the status line: "HTTP/1.1 408 Request Timeout"
      const statusMatch = /^HTTP\/1\.\d (\d{3})/.exec(raw);
      if (!statusMatch) {
        reject(new Error(`Could not parse HTTP status from response:\n${raw}`));
        return;
      }
      const statusCode = Number(statusMatch[1]);
      const headerBodySplit = raw.indexOf("\r\n\r\n");
      const body = headerBodySplit >= 0 ? raw.slice(headerBodySplit + 4) : "";
      resolve({ statusCode, body });
    });

    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Open a raw TCP connection to the test server, send HTTP headers + an initial
 * body chunk (4 bytes), and then deliberately stop — simulating a slow-loris
 * / stalling client.
 *
 * The function does NOT send the chunked terminator ("0\r\n\r\n"), so the
 * server's reader.read() hangs after the first chunk until the route's
 * per-chunk read deadline fires.
 *
 * Returns a Promise that resolves to { statusCode, body } when the server
 * writes its response.
 */
async function sendStallingUpload(opts: {
  port: number;
  timeoutMs: number;
  readTimeoutMs: number;
}): Promise<{ statusCode: number; body: string }> {
  const socket = net.createConnection(opts.port, "127.0.0.1");

  // Give the socket a moment to connect before sending.
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  // Send a chunked HTTP/1.1 POST request.
  // We send exactly one chunk (4 bytes) and then stop — no terminating "0" chunk.
  const requestLines = [
    `POST /api/storage/upload HTTP/1.1`,
    `Host: 127.0.0.1:${opts.port}`,
    `Content-Type: image/jpeg`,
    `Transfer-Encoding: chunked`,
    `Connection: close`,
    ``,
    ``,
  ].join("\r\n");

  // HTTP/1.1 chunked encoding: "4\r\nXXXX\r\n" = 4 bytes of body data.
  const firstChunk = "4\r\nXXXX\r\n";

  socket.write(requestLines);
  socket.write(firstChunk);
  // Do NOT send more data — this is the stall.
  // The server must time out and respond with 408.

  // Wait for the server to respond (generous headroom = readTimeoutMs × 3).
  const responseTimeoutMs = opts.readTimeoutMs * 3 + 500;
  const result = await readHttpResponse(socket, responseTimeoutMs);

  socket.destroy();
  return result;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe(
  "upload stall timeout — HTTP layer confirms 408 reaches a real fetch() client",
  () => {
    it(
      "stalling client receives HTTP 408 on the wire within the configured deadline",
      async () => {
        // Use a short read timeout so the test completes quickly.
        // The route reads UPLOAD_READ_TIMEOUT_MS on each readChunkWithTimeout()
        // call, so setting it here before the request arrives is sufficient.
        const READ_TIMEOUT_MS = 300;
        saveAndSet({ UPLOAD_READ_TIMEOUT_MS: String(READ_TIMEOUT_MS) });

        const { statusCode, body } = await sendStallingUpload({
          port: serverPort,
          timeoutMs: READ_TIMEOUT_MS,
          readTimeoutMs: READ_TIMEOUT_MS,
        });

        // The HTTP status on the wire must be 408, not 200 / 500 / a hang.
        expect(statusCode).toBe(408);

        // The body must mention the stall.  We check the raw body string rather
        // than calling JSON.parse() because Node.js HTTP may use chunked transfer
        // encoding, which embeds chunk-size hex lines before the JSON payload.
        expect(body).toMatch(/timed out|stalled/i);

        // putObject must never have been called — the upload never completed.
        expect(mockPutObject).not.toHaveBeenCalled();
      },
      // Timeout: READ_TIMEOUT_MS (300) + 3× headroom (900) + socket overhead.
      // Kept well below the 30 s production default to catch accidental hangs.
      3_000,
    );

    it(
      "non-stalling client completes the upload and receives HTTP 200 within the deadline",
      async () => {
        // Sanity check: a fast client that sends a complete body must still
        // succeed.  Without this the 408 test above could be vacuously passing
        // because the server is broken in a way that always returns 408.
        const READ_TIMEOUT_MS = 300;
        saveAndSet({ UPLOAD_READ_TIMEOUT_MS: String(READ_TIMEOUT_MS) });

        mockPutObject.mockResolvedValue(undefined);

        // Use a standard fetch() — no stall — to prove the happy path works.
        const oneByte = new Uint8Array([0x42]);
        const res = await fetch(`http://127.0.0.1:${serverPort}/api/storage/upload`, {
          method: "POST",
          headers: {
            "Content-Type": "image/jpeg",
            "Content-Length": "1",
          },
          body: oneByte,
          // @ts-expect-error -- duplex needed for body in some Node versions
          duplex: "half",
        });

        expect(res.status).toBe(200);
        const body = (await res.json()) as { objectPath?: string };
        expect(body.objectPath).toMatch(/^\/objects\/uploads\//);
        expect(mockPutObject).toHaveBeenCalledTimes(1);
      },
      3_000,
    );

    it(
      "unauthenticated stalling client receives HTTP 401 — auth gate fires before the body is read",
      async () => {
        // When no session exists, the route returns 401 without touching the body.
        // This confirms the auth gate still fires over a real TCP socket, and
        // that the server does not hang waiting for the stalled body before
        // rejecting unauthenticated requests.
        const READ_TIMEOUT_MS = 300;
        saveAndSet({ UPLOAD_READ_TIMEOUT_MS: String(READ_TIMEOUT_MS) });

        // Override the session mock to simulate an unauthenticated request.
        mockSession.value = { userId: null };

        const { statusCode } = await sendStallingUpload({
          port: serverPort,
          timeoutMs: READ_TIMEOUT_MS,
          readTimeoutMs: READ_TIMEOUT_MS,
        });

        // The route must reject with 401 quickly — before the read timeout fires.
        expect(statusCode).toBe(401);
        expect(mockPutObject).not.toHaveBeenCalled();
      },
      3_000,
    );
  },
);
