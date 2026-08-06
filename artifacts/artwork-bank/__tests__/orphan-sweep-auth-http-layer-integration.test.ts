/**
 * Confirm the orphan-sweep 403 and 401 auth gates reach a real fetch() client.
 *
 * The route has two auth-rejection branches:
 *
 *   403 Forbidden — NODE_ENV === "production" with no ORPHAN_SWEEP_SECRET /
 *                   CRON_SECRET configured.  The operator must set at least one
 *                   secret before the endpoint is usable in production.
 *
 *   401 Unauthorized — At least one secret is configured but the request
 *                      omits or supplies the wrong Bearer token.
 *
 * These branches are currently only exercised via direct handler calls.
 * A middleware silently remapping the status codes would be invisible to those
 * tests.  This file issues a genuine fetch() over a real TCP socket so any
 * status transformation between NextResponse.json() and the wire is exposed.
 *
 * sweepOrphanedImageFiles is vi.mocked so no real database or storage access
 * is needed.  next/server is intentionally NOT mocked — the real
 * NextResponse.json() must produce the response whose .status property the
 * server reads and writes into writeHead().
 *
 * Auth note: both branches are driven by env-var overrides inside each test;
 * the afterEach restores the original values.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "node:http";

// next/server is intentionally NOT mocked.

// ── Mock sweepOrphanedImageFiles so no real DB/storage access is needed ────────
// The sweep function must not be called on auth-rejected paths, but we still
// mock it so the module can be imported without live infrastructure.

const sweepOrphanedImageFiles = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ deleted: 0, errors: 0, failedPaths: [] }),
);

vi.mock("@/lib/orphan-image-sweep", () => ({
  sweepOrphanedImageFiles: (...a: unknown[]) =>
    sweepOrphanedImageFiles(...a),
}));

// ── Stub object-storage so the module resolves without live env vars ──────────

vi.mock("@/lib/object-storage", () => ({
  deleteObject: vi.fn().mockResolvedValue(undefined),
  StorageNotConfiguredError: class StorageNotConfiguredError extends Error {
    constructor(message?: string) {
      super(message ?? "Storage not configured");
      this.name = "StorageNotConfiguredError";
    }
  },
}));

// ── Notification mocks — must not be called on auth-rejected paths ────────────

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

// ── In-process HTTP server ─────────────────────────────────────────────────────
// Calls the real route handler, reads .status from the NextResponse, and
// forwards it byte-for-byte via writeHead() so fetch() sees the true HTTP
// status on the wire.  Authorization headers from the fetch() call are
// forwarded to the handler so the auth logic runs exactly as it would in
// production.

let server: http.Server;
let baseUrl: string;

async function startServer(): Promise<void> {
  server = http.createServer(async (req, res) => {
    // Forward the Authorization header so the route's isAuthorized() sees it.
    const headers: Record<string, string> = {};
    const authHeader = req.headers["authorization"];
    if (authHeader) headers["authorization"] = authHeader;

    const request = new Request(`http://localhost${req.url ?? "/"}`, {
      method: req.method ?? "GET",
      headers,
    });
    try {
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
  // Clear savedEnv for the next test.
  for (const key of Object.keys(savedEnv)) {
    delete savedEnv[key];
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(async () => {
  sweepOrphanedImageFiles.mockClear();
  sendOrphanSweepSlackNotification.mockClear();
  sendOrphanSweepErrorNotification.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  await startServer();
});

afterEach(async () => {
  await stopServer();
  restoreEnv();
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe(
  "orphan-sweep — HTTP layer confirms auth gates reach a real fetch() client",
  () => {
    // ── 403 branch ────────────────────────────────────────────────────────────
    //
    // Condition: NODE_ENV === "production" AND no ORPHAN_SWEEP_SECRET / CRON_SECRET.
    // The operator has not configured any secret, so the route refuses to run.

    it("returns HTTP 403 to a real fetch() client when NODE_ENV is production and no secrets are configured", async () => {
      // Arrange: simulate a production deployment with no sweep secret.
      saveAndSet({
        NODE_ENV: "production",
        ORPHAN_SWEEP_SECRET: undefined,
        CRON_SECRET: undefined,
      });

      // Act: unauthenticated GET — no Authorization header.
      const response = await fetch(`${baseUrl}/api/storage/orphan-sweep`);

      // The raw HTTP status on the wire must be 403.
      expect(response.status).toBe(403);

      const body = (await response.json()) as { error: string };
      // The route returns a "Forbidden" message explaining that a secret must be set.
      expect(body.error).toMatch(/forbidden/i);

      // The sweep must not have been invoked on an auth-rejected path.
      expect(sweepOrphanedImageFiles).not.toHaveBeenCalled();
      // Notifications must not fire before the sweep runs.
      expect(sendOrphanSweepSlackNotification).not.toHaveBeenCalled();
      expect(sendOrphanSweepErrorNotification).not.toHaveBeenCalled();
    });

    it("returns HTTP 403 body mentioning the missing secret when NODE_ENV is production and no secrets are configured", async () => {
      saveAndSet({
        NODE_ENV: "production",
        ORPHAN_SWEEP_SECRET: undefined,
        CRON_SECRET: undefined,
      });

      const response = await fetch(`${baseUrl}/api/storage/orphan-sweep`);

      expect(response.status).toBe(403);

      const body = (await response.json()) as { error: string };
      // The message should mention ORPHAN_SWEEP_SECRET or CRON_SECRET so the
      // operator understands what to configure.
      expect(body.error).toMatch(/ORPHAN_SWEEP_SECRET|CRON_SECRET/);
    });

    // ── 401 branch ────────────────────────────────────────────────────────────
    //
    // Condition: at least one secret is configured but the Authorization header
    // is missing or carries the wrong token.

    it("returns HTTP 401 to a real fetch() client when a secret is configured but Authorization header is absent", async () => {
      // Arrange: configure a sweep secret — now every request must present it.
      saveAndSet({
        NODE_ENV: "test",
        ORPHAN_SWEEP_SECRET: "super-secret-token",
        CRON_SECRET: undefined,
      });

      // Act: no Authorization header at all.
      const response = await fetch(`${baseUrl}/api/storage/orphan-sweep`);

      expect(response.status).toBe(401);

      const body = (await response.json()) as { error: string };
      expect(body.error).toMatch(/unauthorized/i);

      expect(sweepOrphanedImageFiles).not.toHaveBeenCalled();
      expect(sendOrphanSweepSlackNotification).not.toHaveBeenCalled();
      expect(sendOrphanSweepErrorNotification).not.toHaveBeenCalled();
    });

    it("returns HTTP 401 to a real fetch() client when a wrong Bearer token is supplied", async () => {
      saveAndSet({
        NODE_ENV: "test",
        ORPHAN_SWEEP_SECRET: "super-secret-token",
        CRON_SECRET: undefined,
      });

      // Act: correct header format but wrong secret value.
      const response = await fetch(`${baseUrl}/api/storage/orphan-sweep`, {
        headers: { Authorization: "Bearer wrong-token" },
      });

      expect(response.status).toBe(401);

      const body = (await response.json()) as { error: string };
      expect(body.error).toMatch(/unauthorized/i);

      expect(sweepOrphanedImageFiles).not.toHaveBeenCalled();
    });

    it("returns HTTP 401 to a real fetch() client when only CRON_SECRET is configured but a wrong token is presented", async () => {
      saveAndSet({
        NODE_ENV: "test",
        ORPHAN_SWEEP_SECRET: undefined,
        CRON_SECRET: "vercel-cron-secret",
      });

      const response = await fetch(`${baseUrl}/api/storage/orphan-sweep`, {
        headers: { Authorization: "Bearer not-the-cron-secret" },
      });

      expect(response.status).toBe(401);

      const body = (await response.json()) as { error: string };
      expect(body.error).toMatch(/unauthorized/i);

      expect(sweepOrphanedImageFiles).not.toHaveBeenCalled();
    });

    // ── Sanity: correct token admits the request ──────────────────────────────
    // Confirm the 200 path is reachable after auth passes, so the 401 tests
    // above are not vacuously passing due to a broken server setup.

    it("admits the request and returns HTTP 200 when the correct ORPHAN_SWEEP_SECRET Bearer token is supplied", async () => {
      saveAndSet({
        NODE_ENV: "test",
        ORPHAN_SWEEP_SECRET: "super-secret-token",
        CRON_SECRET: undefined,
      });

      // sweepOrphanedImageFiles already defaults to a clean result (0 errors).
      const response = await fetch(`${baseUrl}/api/storage/orphan-sweep`, {
        headers: { Authorization: "Bearer super-secret-token" },
      });

      expect(response.status).toBe(200);

      // The sweep must have been called once — auth passed.
      expect(sweepOrphanedImageFiles).toHaveBeenCalledOnce();
    });

    it("admits the request and returns HTTP 200 when the correct CRON_SECRET Bearer token is supplied", async () => {
      saveAndSet({
        NODE_ENV: "test",
        ORPHAN_SWEEP_SECRET: undefined,
        CRON_SECRET: "vercel-cron-secret",
      });

      const response = await fetch(`${baseUrl}/api/storage/orphan-sweep`, {
        headers: { Authorization: "Bearer vercel-cron-secret" },
      });

      expect(response.status).toBe(200);
      expect(sweepOrphanedImageFiles).toHaveBeenCalledOnce();
    });
  },
);
