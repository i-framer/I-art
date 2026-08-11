/**
 * Slow test: verify that stalling uploads receive the correct HTTP status codes
 * through real spawned server processes.
 *
 * Why this file exists
 * ────────────────────
 * The in-process tests (upload-stall-timeout-buffered-body.test.ts and
 * upload-stall-timeout-http-layer-integration.test.ts) exercise the route
 * handler directly, bypassing the Next.js request-parsing pipeline and any
 * edge-runtime buffering behaviour introduced by Next.js version bumps.
 *
 * This test goes further by spawning real child processes and sending genuine
 * HTTP requests over live TCP connections.
 *
 * Why two servers are used
 * ─────────────────────────
 * Next.js 15 (both `next dev` and `next start`) fully buffers the HTTP request
 * body via its multi-process worker IPC before invoking the App Router route
 * handler.  This means there is no external HTTP/1.x transport that can present
 * a stalling body to the route handler through the Next.js pipeline:
 *
 *   • HTTP/1.1 Transfer-Encoding: chunked without the terminator — Next.js
 *     waits for "0\r\n\r\n" before dispatching.  Timeout.
 *   • HTTP/1.1 Content-Length: N with fewer than N bytes sent — Next.js waits
 *     for the remaining bytes.  Timeout.
 *   • HTTP/1.1 Expect: 100-continue — Next.js does not respond with 100
 *     Continue, causing a client/server deadlock.  Timeout.
 *   • HTTP/1.0 (any form) — Next.js's HTTP layer returns 400 before the
 *     request reaches the route handler.
 *
 * As a result, the two scenarios require different servers:
 *
 *   Scenario 1 — unauthenticated, 401 (via `next dev`):
 *     A complete, non-stalling POST is sent to a real `next dev` child process.
 *     The request body is one byte, so Next.js dispatches the handler
 *     immediately.  The auth check fires (no cookie → 401) well before the
 *     read-stall deadline.  This scenario runs through the full Next.js
 *     request-parsing pipeline and catches auth-gate regressions introduced
 *     by Next.js version bumps.
 *
 *   Scenario 2 — authenticated stall, 408 (via helper server):
 *     A stalling POST is sent to a minimal plain Node.js HTTP server spawned
 *     from helpers/upload-stall-server.ts.  Plain Node.js `createServer` does
 *     NOT buffer the request body: the 'request' event fires when headers
 *     arrive and body data is delivered via 'data' events as TCP delivers it.
 *     The helper server reimplements the auth check and per-chunk read-deadline
 *     logic using the same iron-session package and UPLOAD_READ_TIMEOUT_MS
 *     constant, so the 408 path is exercised on a real stalling TCP connection.
 *
 * Scenarios
 * ─────────
 *   1. Unauthenticated upload (next dev) → HTTP 401 quickly (auth gate fires
 *      before body is read; elapsed < UPLOAD_READ_TIMEOUT_MS).
 *   2. Authenticated stalling upload (helper server) → HTTP 408 within the
 *      timeout (client goes silent after 4 bytes; readChunkWithTimeout fires).
 *
 * Route warm-up (next dev)
 * ─────────────────────────
 * `next dev` compiles App Router route segments lazily on first access.  We
 * send a non-stalling warm-up fetch() before the timing-sensitive scenario 1
 * so compilation completes before the clock starts.
 *
 * Timing budget
 * ─────────────
 *   • next dev startup:          up to 90 s.
 *   • Route warm-up:             up to 60 s.
 *   • UPLOAD_READ_TIMEOUT_MS:    1 500 ms.
 *   • Per-test response window:  UPLOAD_READ_TIMEOUT_MS × 5 + 2 000 ms = 9 500 ms.
 *   • Total beforeAll timeout:   180 000 ms.
 *
 * The test is excluded from the default `pnpm test` run via the exclude glob
 * in vitest.config.ts and only runs via `pnpm test:slow`.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";
import * as http from "node:http";
import * as path from "node:path";
import * as fs from "node:fs";
import { sealData } from "iron-session";

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Assertion baseline for elapsed-time checks in this test file.  Kept
 * hardcoded so that the meta-test (scripts/meta-test-stall-guard.sh) can
 * inject a server-side regression without inadvertently relaxing the
 * assertions: the meta-test sets UPLOAD_READ_TIMEOUT_MS=1 in the environment
 * to make the helper server fire its timeout in ~1 ms, but the assertions
 * below still compare against 1 500 ms, so the suite exits non-zero and the
 * meta-test can confirm the guard is effective.
 */
const UPLOAD_READ_TIMEOUT_MS = 1_500;

/**
 * Timeout injected into the spawned child processes (next dev + helper
 * server).  Normally identical to UPLOAD_READ_TIMEOUT_MS, but can be
 * overridden via the UPLOAD_READ_TIMEOUT_MS environment variable to simulate
 * a regression.  The meta-test (scripts/meta-test-stall-guard.sh) sets
 * UPLOAD_READ_TIMEOUT_MS=1 so the helper server fires its timeout in ~1 ms,
 * causing `expect(elapsed).toBeGreaterThanOrEqual(UPLOAD_READ_TIMEOUT_MS)` to
 * fail and proving the guard is still sensitive after a Next.js version bump.
 */
const SERVER_TIMEOUT_MS: number = process.env.UPLOAD_READ_TIMEOUT_MS
  ? Number(process.env.UPLOAD_READ_TIMEOUT_MS)
  : UPLOAD_READ_TIMEOUT_MS;
/** Dev fallback secret — used by the helper server when SESSION_SECRET is unset. */
const DEV_SESSION_SECRET = "dev-fallback-secret-must-be-32-chars!";

/** Cookie name from lib/session.ts */
const COOKIE_NAME = "artwork_bank_session";

// ── Port helper ───────────────────────────────────────────────────────────────

/** Bind briefly to :0 to get an OS-assigned free port, then release it. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

// ── Session cookie helper ────────────────────────────────────────────────────

/**
 * Mint a valid iron-session cookie.
 *
 * The helper server (scenario 2) uses DEV_SESSION_SECRET when SESSION_SECRET
 * is unset.  We seal with the same password so the server unseals correctly.
 */
async function makeSessionCookie(): Promise<string> {
  const payload = {
    userId: "slow-test-user",
    tenantId: "slow-test-tenant",
    role: "owner" as const,
    email: "slow-test@example.com",
  };
  const sealed = await sealData(payload, {
    password: DEV_SESSION_SECRET,
    ttl: 60 * 60 * 24,
  });
  return `${COOKIE_NAME}=${sealed}`;
}

// ── next dev lifecycle (scenario 1) ──────────────────────────────────────────

let devServer: ChildProcess;
let devPort: number;

/**
 * Isolated Next.js build-output directory used by the test-spawned `next dev`.
 *
 * next.config.ts reads process.env.BUILD_DIR for distDir, defaulting to ".next".
 * Setting a dedicated directory prevents the slow-test process from sharing
 * (or corrupting) the main workspace .next cache and avoids the
 * `__webpack_require__.C is not a function` instrumentation error that occurs
 * when a stale .next cache from a previous `build:no-db` run is in use.
 */
const DEV_BUILD_DIR = ".next-slow-test";

async function startDevServer(
  port: number,
  startupTimeoutMs: number,
): Promise<void> {
  const artworkBankDir = path.resolve(__dirname, "../../..");
  const workspaceRoot = path.resolve(artworkBankDir, "../..");

  // Clean the isolated build directory so next dev always starts fresh.
  // This prevents webpack cache from a previous run (or from build:no-db)
  // from causing instrumentation-hook errors on startup.
  const buildOutputPath = path.join(artworkBankDir, DEV_BUILD_DIR);
  try {
    fs.rmSync(buildOutputPath, { recursive: true, force: true });
  } catch {
    // Directory may not exist yet — that is fine.
  }

  devServer = spawn(
    "pnpm",
    ["--filter", "@workspace/artwork-bank", "dev"],
    {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        PORT: String(port),
        BUILD_DIR: DEV_BUILD_DIR,
        UPLOAD_READ_TIMEOUT_MS: String(SERVER_TIMEOUT_MS),
        // Unset SESSION_SECRET so the dev server uses the same fallback as
        // the helper server — consistent password across both processes.
        SESSION_SECRET: undefined,
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const stderrChunks: Buffer[] = [];
  devServer.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  const deadline = Date.now() + startupTimeoutMs;
  let lastError: Error | null = null;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));

    if (devServer.exitCode !== null) {
      const stderr = Buffer.concat(stderrChunks).toString("utf8").slice(-2000);
      throw new Error(
        `next dev exited with code ${devServer.exitCode} before becoming ready.\n${stderr}`,
      );
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get(
          `http://127.0.0.1:${port}/`,
          { timeout: 1_000 },
          (res) => {
            res.resume();
            resolve();
          },
        );
        req.on("error", reject);
        req.on("timeout", () => {
          req.destroy();
          reject(new Error("probe timeout"));
        });
      });
      return;
    } catch (err) {
      lastError = err as Error;
    }
  }

  devServer.kill("SIGTERM");
  const stderr = Buffer.concat(stderrChunks).toString("utf8").slice(-2000);
  throw new Error(
    `next dev did not become ready within ${startupTimeoutMs} ms.\n` +
      `Last probe error: ${lastError?.message ?? "unknown"}\n` +
      `Server stderr (last 2000 chars):\n${stderr}`,
  );
}

/** Warm up the upload route so JIT compilation finishes before tests. */
async function warmupRoute(port: number, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/storage/upload`, {
      method: "POST",
      headers: { "Content-Type": "image/jpeg", "Content-Length": "1" },
      body: new Uint8Array([0x42]),
      // @ts-expect-error — duplex needed for body in some Node versions
      duplex: "half",
      signal: controller.signal,
    });
    await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function stopDevServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!devServer || devServer.exitCode !== null) {
      resolve();
      return;
    }
    devServer.once("exit", () => {
      // Remove the isolated build directory so subsequent runs start clean.
      const buildOutputPath = path.join(
        path.resolve(__dirname, "../../.."),
        DEV_BUILD_DIR,
      );
      try {
        fs.rmSync(buildOutputPath, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; ignore errors.
      }
      resolve();
    });
    devServer.kill("SIGTERM");
    setTimeout(() => {
      try { devServer.kill("SIGKILL"); } catch { /* already dead */ }
    }, 5_000).unref();
  });
}

// ── Helper server lifecycle (scenario 2) ──────────────────────────────────────

let helperServer: ChildProcess;
let helperPort: number;

/**
 * Spawn the minimal Node.js stall-server (helpers/upload-stall-server.ts) via
 * tsx.  The server writes "READY:<port>\n" to stdout when listening.
 *
 * This server uses a plain Node.js createServer that does NOT buffer the
 * request body, so stalling requests genuinely block in the read loop and
 * trigger the per-chunk timeout.
 */
async function startHelperServer(
  port: number,
  timeoutMs: number,
): Promise<void> {
  const helperScript = path.resolve(
    __dirname,
    "helpers/upload-stall-server.ts",
  );

  helperServer = spawn("pnpm", ["exec", "tsx", helperScript], {
    cwd: path.resolve(__dirname, "../../.."),
    env: {
      ...process.env,
      UPLOAD_SERVER_PORT: String(port),
      UPLOAD_READ_TIMEOUT_MS: String(SERVER_TIMEOUT_MS),
      // Unset SESSION_SECRET so the helper server uses DEV_SESSION_SECRET —
      // the same password used by makeSessionCookie().
      SESSION_SECRET: undefined,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stderrChunks: Buffer[] = [];
  helperServer.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      helperServer.kill("SIGTERM");
      reject(
        new Error(
          `Helper server did not start within ${timeoutMs} ms.\n` +
            Buffer.concat(stderrChunks).toString("utf8").slice(-1000),
        ),
      );
    }, timeoutMs);

    let stdoutBuf = "";
    helperServer.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      const match = stdoutBuf.match(/READY:(\d+)/);
      if (match) {
        clearTimeout(timer);
        helperPort = parseInt(match[1], 10);
        resolve();
      }
    });

    helperServer.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `Helper server exited with code ${code}.\n` +
              Buffer.concat(stderrChunks).toString("utf8").slice(-1000),
          ),
        );
      }
    });
  });
}

function stopHelperServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!helperServer || helperServer.exitCode !== null) {
      resolve();
      return;
    }
    helperServer.once("exit", () => resolve());
    helperServer.kill("SIGTERM");
    setTimeout(() => {
      try { helperServer.kill("SIGKILL"); } catch { /* already dead */ }
    }, 3_000).unref();
  });
}

// ── Stalling-upload helper (scenario 2) ───────────────────────────────────────

/**
 * Send a stalling POST to the helper server using Node.js `http.request`.
 *
 * The helper server uses a plain Node.js createServer that streams the request
 * body directly from the TCP layer (no buffering).  After writing a few bytes
 * via req.write() and deliberately NOT calling req.end(), the client goes
 * silent.  The server's read loop blocks in reader.read() until the per-chunk
 * timer fires, then returns 408.
 *
 * http.request's response callback fires as soon as the 408 response HEADERS
 * arrive — independently of the request-body state — so the Promise resolves
 * without needing the client to close its half of the connection.
 *
 * @param opts.contentType  - The Content-Type header value to send.
 *   Defaults to "image/jpeg" (raw path).  Pass a multipart/form-data value
 *   to exercise the multipart stall path.
 * @param opts.initialBytes - Initial bytes to write before going silent.
 *   Defaults to [0x58, 0x58, 0x58, 0x58] ("XXXX") — enough to get past the
 *   auth gate without completing the body.
 */
function sendStallingUploadToHelper(opts: {
  cookie?: string;
  responseTimeoutMs: number;
  contentType?: string;
  initialBytes?: Buffer;
}): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const extraHeaders: Record<string, string> = {};
    if (opts.cookie) extraHeaders["Cookie"] = opts.cookie;

    const contentType = opts.contentType ?? "image/jpeg";
    const initialBytes = opts.initialBytes ?? Buffer.from([0x58, 0x58, 0x58, 0x58]);

    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: helperPort,
        method: "POST",
        path: "/api/storage/upload",
        headers: {
          "Content-Type": contentType,
          // No Content-Length → Node.js uses Transfer-Encoding: chunked.
          // Each req.write() sends one chunk; NOT calling req.end() means
          // the terminator is never sent — the server's read loop blocks.
          "Connection": "close",
          ...extraHeaders,
        },
      },
      (res) => {
        // Response callback fires when the server sends response HEADERS —
        // independently of the request body state.
        let body = "";
        res.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
        res.on("end", () => {
          req.destroy();
          settle(() => resolve({ statusCode: res.statusCode ?? 0, body }));
        });
        res.on("error", (err) => { settle(() => reject(err)); });
      },
    );

    req.on("error", (err: NodeJS.ErrnoException) => {
      settle(() => reject(err));
    });

    const timer = setTimeout(() => {
      req.destroy();
      settle(() =>
        reject(
          new Error(
            `Helper server did not respond within ${opts.responseTimeoutMs} ms`,
          ),
        ),
      );
    }, opts.responseTimeoutMs);

    // Write the initial bytes and then go silent — stall.
    req.write(initialBytes);
  });
}

// ── Timing helpers ────────────────────────────────────────────────────────────

import { checkTimingBudget } from "./helpers/timing";

// ── Suite lifecycle ───────────────────────────────────────────────────────────

beforeAll(async () => {
  // Start both servers concurrently and record wall-clock startup time so
  // CI logs surface regressions in next-dev startup latency.
  devPort = await findFreePort();
  const helperPortRequest = await findFreePort();

  const startupStart = Date.now();
  await Promise.all([
    startDevServer(devPort, 90_000).then(() => warmupRoute(devPort, 60_000)),
    startHelperServer(helperPortRequest, 20_000),
  ]);

  // beforeAll budget: 180 s.  Log startup cost so cold-runner regressions are
  // visible in the CI log before they cause a beforeAll timeout.
  checkTimingBudget(Date.now() - startupStart, 180_000, "beforeAll startup + warmup");
}, 180_000);

afterAll(async () => {
  await Promise.all([stopDevServer(), stopHelperServer()]);
}, 15_000);

// ── Tests ─────────────────────────────────────────────────────────────────────

const RESPONSE_WINDOW_MS = UPLOAD_READ_TIMEOUT_MS * 5 + 2_000;

describe(
  "upload stall timeout — real spawned servers",
  () => {
    it(
      "unauthenticated upload (next dev): auth gate fires quickly and returns 401",
      async () => {
        /**
         * Send a complete, non-stalling POST with no session cookie to the real
         * `next dev` server.  The auth check fires before attempting to read the
         * request body; the response must arrive well before the stall deadline.
         *
         * Note: Next.js 15 buffers the request body before dispatching the App
         * Router route handler.  A complete 1-byte body is the transport that
         * reliably causes dispatch.  The auth check fires before body reading
         * regardless — confirmed by elapsed < UPLOAD_READ_TIMEOUT_MS.
         */
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(),
          RESPONSE_WINDOW_MS,
        );

        const start = Date.now();
        let statusCode: number;
        try {
          const res = await fetch(
            `http://127.0.0.1:${devPort}/api/storage/upload`,
            {
              method: "POST",
              headers: {
                "Content-Type": "image/jpeg",
                "Content-Length": "1",
              },
              body: new Uint8Array([0x42]),
              // @ts-expect-error — duplex needed for body in some Node versions
              duplex: "half",
              signal: controller.signal,
            },
          );
          statusCode = res.status;
          await res.text();
        } finally {
          clearTimeout(timer);
        }
        const elapsed = Date.now() - start;

        expect(statusCode!).toBe(401);
        // Auth gate must fire well before the read deadline — confirming the
        // server does not block on the body before checking auth.
        expect(elapsed).toBeLessThan(UPLOAD_READ_TIMEOUT_MS);

        // Log elapsed time so cold-runner regressions are visible in CI
        // before they cause an outright assertion failure.
        checkTimingBudget(elapsed, UPLOAD_READ_TIMEOUT_MS, "auth gate (next dev)");
      },
      RESPONSE_WINDOW_MS + 3_000,
    );

    it(
      "authenticated stalling upload (helper server): route reads partial body, times out, returns 408",
      async () => {
        /**
         * Send a stalling POST to the helper server (plain Node.js createServer,
         * not Next.js).  The helper server streams the body directly from TCP —
         * no pre-buffering — so when the client sends 4 bytes and then goes
         * silent, the read loop genuinely blocks in reader.read().  After
         * UPLOAD_READ_TIMEOUT_MS the per-chunk timer fires and the server returns
         * HTTP 408.
         *
         * The helper server uses the same iron-session auth check and the same
         * per-chunk timeout constant as the real upload route, so this scenario
         * verifies that the stall-detection logic works on a live TCP connection
         * with a real authenticated request.
         *
         * http.request's response callback fires on response HEADERS arrival —
         * independent of the stalling request body — so the Promise resolves as
         * soon as 408 is sent, without needing req.end() or the connection to
         * close.
         */
        const cookie = await makeSessionCookie();

        const start = Date.now();
        const { statusCode, body } = await sendStallingUploadToHelper({
          cookie,
          responseTimeoutMs: RESPONSE_WINDOW_MS,
        });
        const elapsed = Date.now() - start;

        expect(statusCode).toBe(408);
        expect(body).toMatch(/timed out|stalled/i);
        expect(elapsed).toBeGreaterThanOrEqual(UPLOAD_READ_TIMEOUT_MS);
        expect(elapsed).toBeLessThan(RESPONSE_WINDOW_MS);

        // Log elapsed time so cold-runner regressions are visible in CI
        // before they cause an outright assertion failure.
        checkTimingBudget(elapsed, RESPONSE_WINDOW_MS, "stall → 408 (helper server)");
      },
      RESPONSE_WINDOW_MS + 3_000,
    );

    it(
      "authenticated stalling multipart upload (helper server): multipart path also times out and returns 408",
      async () => {
        /**
         * Scenario 3 — multipart/form-data stall via helper server.
         *
         * The upload route has two body-reading paths: one for raw image/* bodies
         * and one for multipart/form-data bodies.  Both call readStreamWithDeadlines
         * before any parsing, so a client that stalls mid-body on the multipart
         * path must also receive HTTP 408 after UPLOAD_READ_TIMEOUT_MS.
         *
         * WHY THE HELPER SERVER (not next dev)
         * ─────────────────────────────────────
         * Next.js 15 fully buffers the request body before invoking the App Router
         * route handler — regardless of Content-Type.  A multipart request that
         * stalls mid-body causes Next.js to wait at the transport layer, never
         * reaching the route.  The helper server (plain Node.js createServer) does
         * NOT buffer: body data is delivered to the route handler chunk-by-chunk as
         * TCP delivers it.  This is the only reliable way to present a stalling
         * body to readStreamWithDeadlines on a real TCP connection.
         *
         * WHAT IS SENT
         * ─────────────
         * A multipart/form-data request with a valid boundary is opened.  We write
         * only the opening boundary line and part headers, then go silent without
         * sending the file data or the closing boundary.  The helper server's read
         * loop blocks in reader.read() waiting for the next chunk; after
         * UPLOAD_READ_TIMEOUT_MS the per-chunk timer fires and returns 408.
         *
         * The response arrives via the http.request response-headers callback —
         * independently of the stalling request body — so the Promise resolves
         * as soon as the server sends 408.
         */
        const cookie = await makeSessionCookie();
        const boundary = "----SlowTestBoundaryXYZ";
        // Partial multipart body: opening boundary + part headers, no file data.
        // The client goes silent here — the server never sees the file bytes or
        // the closing boundary, causing the read loop to block.
        const partialBody = Buffer.from(
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="test.jpg"\r\n` +
          `Content-Type: image/jpeg\r\n` +
          `\r\n`,
          "utf8",
        );

        const start = Date.now();
        const { statusCode, body } = await sendStallingUploadToHelper({
          cookie,
          responseTimeoutMs: RESPONSE_WINDOW_MS,
          contentType: `multipart/form-data; boundary=${boundary}`,
          initialBytes: partialBody,
        });
        const elapsed = Date.now() - start;

        expect(statusCode).toBe(408);
        expect(body).toMatch(/timed out|stalled/i);
        expect(elapsed).toBeGreaterThanOrEqual(UPLOAD_READ_TIMEOUT_MS);
        expect(elapsed).toBeLessThan(RESPONSE_WINDOW_MS);
      },
      RESPONSE_WINDOW_MS + 3_000,
    );
  },
);
