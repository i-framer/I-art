/**
 * Smoke tests: check-drift.ts connectionTimeoutMillis fires within 5 s.
 *
 * Two complementary tests share a single local TCP fixture:
 *
 *  1. Direct pg-client test  — instantiates a Client with the same
 *     CONNECT_TIMEOUT_MS value used by check-drift.ts and connects to the
 *     local stalling server.  Asserts the Promise rejects within
 *     CONNECT_TIMEOUT_MS + a small overhead AND that the rejection message
 *     contains "timeout" (ruling out a fast ECONNREFUSED false positive).
 *
 *  2. Script subprocess test — runs the full check-drift.ts script via tsx
 *     against the same stalling server.  This is the regression test: it
 *     will fail if someone removes or substantially increases
 *     connectionTimeoutMillis in check-drift.ts.  Asserts exit 1, a
 *     "timeout" error message, and timing within CONNECT_TIMEOUT_MS + tsx
 *     startup overhead.
 *
 * The TCP fixture is a local server that completes the TCP three-way
 * handshake (so connectionTimeoutMillis, not the OS TCP timeout, is what
 * fires) but never writes the PostgreSQL startup response.  This:
 *   - is deterministic — no dependence on external routing or firewall rules
 *   - rules out ECONNREFUSED (the pg client successfully connects)
 *   - forces the pg client to wait for the PostgreSQL handshake until its
 *     connectionTimeoutMillis expires
 *
 * Neither test requires a real DATABASE_URL.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Constants ─────────────────────────────────────────────────────────────

/**
 * Must match CONNECT_TIMEOUT_MS in check-drift.ts.
 * If that constant changes, this file must be updated in lockstep —
 * the subprocess test will also fail (timing assertion), catching the drift.
 */
const CONNECT_TIMEOUT_MS = 5_000;

/**
 * Extra budget on top of the connect timeout for the *direct* pg-client test.
 * Covers TCP stack overhead for a loopback connection — typically < 10 ms.
 */
const DIRECT_OVERHEAD_MS = 500;

/**
 * Extra budget on top of the connect timeout for the *subprocess* test.
 * Covers tsx + Node.js module-load startup time — typically 300–500 ms in
 * this workspace; 3 000 ms gives breathing room on a loaded CI runner.
 */
const SUBPROCESS_OVERHEAD_MS = 3_000;

const DIRECT_CEILING_MS = CONNECT_TIMEOUT_MS + DIRECT_OVERHEAD_MS; // 5 500 ms
const SUBPROCESS_CEILING_MS = CONNECT_TIMEOUT_MS + SUBPROCESS_OVERHEAD_MS; // 8 000 ms

// ── TCP stalling fixture ──────────────────────────────────────────────────

/**
 * A TCP server that completes the OS-level handshake but never writes the
 * PostgreSQL startup response.  The pg client's connectionTimeoutMillis is
 * therefore the only thing that terminates the wait.
 */
let stallingServer: Server;
let stallingPort: number;

beforeAll(async () => {
  stallingServer = createServer((socket: Socket) => {
    // Accept the connection but intentionally send nothing back.
    // Drain any bytes the client sends so the kernel buffer doesn't fill.
    socket.resume();
    // Silently absorb socket errors that occur when the client disconnects
    // after its timeout fires or when the server is closed.
    socket.on("error", () => {});
  });

  await new Promise<void>((resolve, reject) => {
    stallingServer.on("error", reject);
    // Bind to a random free port on loopback.
    stallingServer.listen(0, "127.0.0.1", resolve);
  });

  stallingPort = (stallingServer.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => stallingServer.close(() => resolve()));
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe("check-drift.ts connect-timeout smoke tests (no real DB)", () => {
  /**
   * Test 1 — mechanism: the pg library honours connectionTimeoutMillis.
   *
   * Instantiates a Client directly (no subprocess overhead) against the
   * local stalling server.  Because the TCP connect succeeds, a fast
   * ECONNREFUSED cannot produce a false pass — only connectionTimeoutMillis
   * can terminate the wait.
   */
  it(
    `pg Client rejects with a timeout within ${DIRECT_CEILING_MS} ms against the stalling server`,
    async () => {
      const url = `postgresql://user:password@127.0.0.1:${stallingPort}/testdb`;
      const client = new Client({
        connectionString: url,
        connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      });

      const startMs = Date.now();
      let connectError: Error | undefined;

      await client.connect().catch((err: unknown) => {
        connectError = err instanceof Error ? err : new Error(String(err));
      });

      const elapsedMs = Date.now() - startMs;

      // Must have thrown — a connection to the stalling server never succeeds.
      expect(
        connectError,
        "Expected connect() to reject but it resolved — stalling server bug?",
      ).toBeDefined();

      // Must be a timeout, not some other error (proves the TCP connect succeeded
      // and the pg library's internal timer is what terminated the wait).
      expect(
        connectError!.message.toLowerCase(),
        `Error was "${connectError!.message}" — expected a timeout, not a fast ECONNREFUSED or other error`,
      ).toContain("timeout");

      // Must have fired within the configured budget + a small loopback overhead.
      expect(
        elapsedMs,
        `connect() took ${elapsedMs} ms — connectionTimeoutMillis (${CONNECT_TIMEOUT_MS} ms) is not being honoured.\n` +
          `Without the timeout the pg client would wait indefinitely.`,
      ).toBeLessThanOrEqual(DIRECT_CEILING_MS);

      await client.end().catch(() => {});
    },
    // Vitest test-level ceiling: if connectionTimeoutMillis is broken, connect()
    // could hang indefinitely.  This ensures a broken timeout surfaces as a clear
    // vitest failure rather than a runaway test.
    DIRECT_CEILING_MS + 5_000,
  );

  /**
   * Test 2 — regression: check-drift.ts is configured to time out correctly.
   *
   * Runs the full script as a subprocess against the stalling server.
   * If CONNECT_TIMEOUT_MS is removed or raised in check-drift.ts, the
   * elapsed time will exceed SUBPROCESS_CEILING_MS and this test will fail.
   * Asserting "timeout" in the output also rules out an immediate ECONNREFUSED
   * false pass.
   */
  it(
    `full script exits 1 within ${SUBPROCESS_CEILING_MS} ms with a timeout error against the stalling server`,
    () => {
      const scriptPath = resolve(__dirname, "../scripts/check-drift.ts");
      const tsxBin = resolve(__dirname, "../node_modules/.bin/tsx");
      const url = `postgresql://user:password@127.0.0.1:${stallingPort}/testdb`;

      const startMs = Date.now();

      const result = spawnSync(tsxBin, [scriptPath], {
        env: { ...process.env, DATABASE_URL: url },
        encoding: "utf-8",
        // Hard ceiling well above SUBPROCESS_CEILING_MS so the elapsed-time
        // assertion — not a SIGKILL — is always what reports a hung script.
        timeout: SUBPROCESS_CEILING_MS + 10_000,
      });

      const elapsedMs = Date.now() - startMs;
      const combined = (result.stderr ?? "") + (result.stdout ?? "");

      // ── Exit code ──────────────────────────────────────────────────────
      expect(
        result.status,
        `Expected exit code 1 (connection failure) but got ${result.status}.\nOutput: ${combined}`,
      ).toBe(1);

      // ── Error must be a timeout, not ECONNREFUSED ─────────────────────
      // The stalling server accepts the TCP connection, so the only way the
      // script can exit early is via connectionTimeoutMillis.  If the output
      // does not mention "timeout", connectionTimeoutMillis is not firing and
      // some other fast-fail path is masking a broken timeout.
      expect(
        combined.toLowerCase(),
        `Expected "timeout" in output — stalling server was reachable so only connectionTimeoutMillis should cause exit.\nOutput: ${combined}`,
      ).toContain("timeout");

      // ── Timing ────────────────────────────────────────────────────────
      // If CONNECT_TIMEOUT_MS is removed or raised in check-drift.ts, this
      // assertion catches the regression.
      expect(
        elapsedMs,
        `check-drift took ${elapsedMs} ms — connectionTimeoutMillis is not configured correctly in check-drift.ts.\n` +
          `Expected exit within ${SUBPROCESS_CEILING_MS} ms (${CONNECT_TIMEOUT_MS} ms timeout + ${SUBPROCESS_OVERHEAD_MS} ms overhead).`,
      ).toBeLessThanOrEqual(SUBPROCESS_CEILING_MS);
    },
    // Vitest test-level ceiling.
    SUBPROCESS_CEILING_MS + 10_000,
  );
});
