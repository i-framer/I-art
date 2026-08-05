/**
 * Task #397 — Confirm the orphan sweep 500 path reaches a real fetch() client
 * when storage is misconfigured.
 *
 * The route handler has three HTTP outcomes: 200 (clean sweep), 207 (per-row
 * storage errors), and 500 (sweepOrphanedImageFiles itself throws
 * StorageNotConfiguredError or an unexpected error).  The 200 and 207 paths
 * already have HTTP-layer coverage.  This file exercises the 500 branch.
 *
 * sweepOrphanedImageFiles is vi.mocked to throw StorageNotConfiguredError so
 * no real database or blob store is needed — the suite uses plain describe()
 * and always runs regardless of DATABASE_URL.
 *
 * A real in-process HTTP server issues a genuine fetch() call over a TCP
 * socket.  The server calls the route handler, reads the real NextResponse
 * .status produced by NextResponse.json(), and forwards it byte-for-byte in
 * writeHead() so fetch() sees the true HTTP status on the wire.  Any
 * transformation of the 500 status inside NextResponse.json() itself would
 * surface here but would be invisible to a direct handler call.
 *
 * next/server is intentionally NOT mocked — the real NextResponse.json() from
 * Next.js must produce the response so the .status we read is what the
 * framework actually sets.
 *
 * Auth note: the route allows open access when NODE_ENV !== "production" and
 * no ORPHAN_SWEEP_SECRET / CRON_SECRET is configured.  The test environment
 * satisfies this condition, so no bearer token is required.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "node:http";

// next/server is intentionally NOT mocked.

// ── Mock sweepOrphanedImageFiles so no real DB/storage access is needed ────────

const sweepOrphanedImageFiles = vi.hoisted(() =>
  vi.fn().mockRejectedValue(new Error("will be overridden in each test")),
);

vi.mock("@/lib/orphan-image-sweep", () => ({
  sweepOrphanedImageFiles: (...a: unknown[]) =>
    sweepOrphanedImageFiles(...a),
}));

// ── Mock object-storage so the same StorageNotConfiguredError class is used ─────
// The route catches `err instanceof StorageNotConfiguredError`.  Providing the
// class in the mock ensures the route's import and the test's import both
// reference the same constructor, so the instanceof check succeeds and the
// correct "Storage misconfigured" 500 branch fires.

vi.mock("@/lib/object-storage", () => ({
  deleteObject: vi.fn().mockResolvedValue(undefined),
  StorageNotConfiguredError: class StorageNotConfiguredError extends Error {
    constructor(message?: string) {
      super(message ?? "Storage not configured");
      this.name = "StorageNotConfiguredError";
    }
  },
}));

// ── Notification mocks — must not be called on the 500 path ──────────────────

const sendOrphanSweepSlackNotification = vi.hoisted(() => vi.fn());
const sendOrphanSweepErrorNotification = vi.hoisted(() => vi.fn());

vi.mock("@/lib/slack", () => ({
  sendOrphanSweepSlackNotification: (...a: unknown[]) =>
    sendOrphanSweepSlackNotification(...a),
}));

vi.mock("@/lib/email", () => ({
  sendOrphanSweepErrorNotification: (...a: unknown[]) =>
    sendOrphanSweepErrorNotification(...a),
}));

// ── Route import (after mocks are in place) ───────────────────────────────────

import { GET } from "@/app/api/storage/orphan-sweep/route";
import { StorageNotConfiguredError } from "@/lib/object-storage";

// ── In-process HTTP server ─────────────────────────────────────────────────────
// The server calls the route handler and receives a real NextResponse (a Web
// API Response produced by the actual Next.js NextResponse.json()).  It reads
// .status from that Response object and writes it into writeHead() so the
// status travels byte-for-byte over a real TCP socket to fetch().
//
// This approach matches the pattern established in
// orphan-sweep-207-http-layer-integration.test.ts and is sufficient to detect
// any status transformation inside NextResponse.json() itself — the central
// claim of the HTTP-layer tests.

let server: http.Server;
let baseUrl: string;

async function startServer(): Promise<void> {
  server = http.createServer(async (req, res) => {
    const request = new Request(`http://localhost${req.url ?? "/"}`, {
      method: req.method ?? "GET",
    });
    try {
      // GET returns a real NextResponse (extends Web API Response).
      const result = await GET(request);
      const body = await result.text();
      res.writeHead(result.status, {
        "Content-Type":
          result.headers.get("content-type") ?? "application/json",
      });
      res.end(body);
    } catch (_err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

async function stopServer(): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

// ── Env helpers — ensure auth is open (dev mode, no secret) ──────────────────

const savedEnv: Record<string, string | undefined> = {};

function clearAuthEnv(): void {
  for (const key of ["ORPHAN_SWEEP_SECRET", "CRON_SECRET"]) {
    savedEnv[key] = process.env[key];
  }
  delete process.env.ORPHAN_SWEEP_SECRET;
  delete process.env.CRON_SECRET;
  // NODE_ENV is already "test" in the Vitest environment, which satisfies the
  // open-access condition (only "production" with no secrets configured blocks).
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(async () => {
  sweepOrphanedImageFiles.mockClear();
  sendOrphanSweepSlackNotification.mockClear();
  sendOrphanSweepErrorNotification.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  clearAuthEnv();
  await startServer();
});

afterEach(async () => {
  await stopServer();
  restoreEnv();
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe(
  "orphan-sweep — HTTP layer confirms 500 reaches a real fetch() client when storage is misconfigured (Task #397)",
  () => {
    it("returns HTTP 500 to a real fetch() client when sweepOrphanedImageFiles throws StorageNotConfiguredError", async () => {
      // Arrange: make the sweep function itself throw StorageNotConfiguredError,
      // simulating a completely misconfigured storage backend.
      sweepOrphanedImageFiles.mockRejectedValueOnce(
        new StorageNotConfiguredError(
          "PRIVATE_OBJECT_DIR is not set",
        ),
      );

      // Act: issue a genuine HTTP request via fetch() — not a direct handler call.
      // The request traverses a real TCP socket; the status in the response is
      // whatever the real NextResponse.json() set on the .status property.
      const response = await fetch(`${baseUrl}/api/storage/orphan-sweep`);

      // The raw HTTP status on the wire must be 500.  Any transformation of the
      // 500 inside NextResponse.json() itself would surface here but not in a
      // direct handler call.
      expect(response.status).toBe(500);

      const body = (await response.json()) as { error: string };
      // The route returns the "Storage misconfigured" message for this branch.
      expect(body.error).toMatch(/storage misconfigured/i);

      // Notification functions must NOT have been called — the sweep threw
      // before producing a result, so there is nothing to notify about.
      expect(sendOrphanSweepSlackNotification).not.toHaveBeenCalled();
      expect(sendOrphanSweepErrorNotification).not.toHaveBeenCalled();
    });

    it("returns HTTP 500 to a real fetch() client when sweepOrphanedImageFiles throws an unexpected error", async () => {
      // Arrange: an unexpected (non-storage) error escaping from the sweep
      // function — e.g. a database connection failure mid-sweep.
      sweepOrphanedImageFiles.mockRejectedValueOnce(
        new Error("ECONNREFUSED: database unreachable"),
      );

      // Act: genuine HTTP request.
      const response = await fetch(`${baseUrl}/api/storage/orphan-sweep`);

      // Generic unexpected error → 500 with generic "Sweep failed" body.
      expect(response.status).toBe(500);

      const body = (await response.json()) as { error: string };
      expect(body.error).toBeTruthy();

      // Notifications must not fire for an unexpected-throw path.
      expect(sendOrphanSweepSlackNotification).not.toHaveBeenCalled();
      expect(sendOrphanSweepErrorNotification).not.toHaveBeenCalled();
    });
  },
);
