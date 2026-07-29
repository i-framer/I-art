/**
 * Integration tests for the email-sweep API route's authentication guard.
 *
 * These tests differ from the unit tests in email-sweep-route.test.ts in one
 * important way: they use real Web API Request objects (new Request(...)) so
 * the route handler runs against the same request-parsing pipeline it would
 * encounter in a real Next.js environment.  The sweep implementation is still
 * mocked so no database or email side-effects occur.
 *
 * Verifies that:
 *  1. In production with no secret configured, GET/POST returns 403.
 *  2. A valid Bearer token passes through and the sweep runs (200).
 *  3. A wrong Bearer token returns 401 without running the sweep.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Mock next/server so the route can run in a plain Node environment ─────────

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) => ({
      status: init?.status ?? 200,
      body,
    }),
  },
}));

// ── Mock the sweep so no DB or email is touched ───────────────────────────────

const sweepUnsentConfirmationEmails = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ processed: 0, sent: 0, errors: 0 }),
);

vi.mock("@/lib/email-sweep", () => ({
  sweepUnsentConfirmationEmails,
}));

// ── Import route handlers after mocks are in place ───────────────────────────

import { GET, POST } from "@/app/api/email-sweep/route";

// ── Env management ────────────────────────────────────────────────────────────

const savedEnv: Record<string, string | undefined> = {};

function setEnv(overrides: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(overrides)) {
    savedEnv[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function restoreEnv() {
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

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a real Web-API Request object — no hand-crafted header mocks. */
function realRequest(
  method: "GET" | "POST",
  authHeader?: string,
): Request {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) {
    headers["authorization"] = authHeader;
  }
  return new Request("http://localhost/api/email-sweep", {
    method,
    headers,
  });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  sweepUnsentConfirmationEmails.mockClear();
});

afterEach(() => {
  restoreEnv();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("email-sweep route integration — auth guard with real Request objects", () => {
  describe("production with no secret configured → 403", () => {
    it("GET returns 403 and does not run the sweep", async () => {
      setEnv({
        NODE_ENV: "production",
        EMAIL_SWEEP_SECRET: undefined,
        CRON_SECRET: undefined,
      });

      const res = await GET(realRequest("GET"));

      expect(res.status).toBe(403);
      expect((res.body as any).error).toMatch(/Forbidden/i);
      expect(sweepUnsentConfirmationEmails).not.toHaveBeenCalled();
    });

    it("POST returns 403 and does not run the sweep", async () => {
      setEnv({
        NODE_ENV: "production",
        EMAIL_SWEEP_SECRET: undefined,
        CRON_SECRET: undefined,
      });

      const res = await POST(realRequest("POST"));

      expect(res.status).toBe(403);
      expect(sweepUnsentConfirmationEmails).not.toHaveBeenCalled();
    });
  });

  describe("production with a valid Bearer token → 200", () => {
    it("GET with correct EMAIL_SWEEP_SECRET runs the sweep and returns 200", async () => {
      setEnv({
        NODE_ENV: "production",
        EMAIL_SWEEP_SECRET: "integration-secret-abc",
        CRON_SECRET: undefined,
      });

      const res = await GET(realRequest("GET", "Bearer integration-secret-abc"));

      expect(res.status).toBe(200);
      expect(sweepUnsentConfirmationEmails).toHaveBeenCalledOnce();
    });

    it("POST with correct EMAIL_SWEEP_SECRET runs the sweep and returns 200", async () => {
      setEnv({
        NODE_ENV: "production",
        EMAIL_SWEEP_SECRET: "integration-secret-abc",
        CRON_SECRET: undefined,
      });

      const res = await POST(realRequest("POST", "Bearer integration-secret-abc"));

      expect(res.status).toBe(200);
      expect(sweepUnsentConfirmationEmails).toHaveBeenCalledOnce();
    });

    it("GET accepts CRON_SECRET as an alternative token", async () => {
      setEnv({
        NODE_ENV: "production",
        EMAIL_SWEEP_SECRET: undefined,
        CRON_SECRET: "cron-integration-xyz",
      });

      const res = await GET(realRequest("GET", "Bearer cron-integration-xyz"));

      expect(res.status).toBe(200);
      expect(sweepUnsentConfirmationEmails).toHaveBeenCalledOnce();
    });
  });

  describe("production with a wrong Bearer token → 401", () => {
    it("GET returns 401 when the token does not match", async () => {
      setEnv({
        NODE_ENV: "production",
        EMAIL_SWEEP_SECRET: "correct-secret",
        CRON_SECRET: undefined,
      });

      const res = await GET(realRequest("GET", "Bearer wrong-secret"));

      expect(res.status).toBe(401);
      expect((res.body as any).error).toMatch(/Unauthorized/i);
      expect(sweepUnsentConfirmationEmails).not.toHaveBeenCalled();
    });

    it("POST returns 401 when the token does not match", async () => {
      setEnv({
        NODE_ENV: "production",
        EMAIL_SWEEP_SECRET: "correct-secret",
        CRON_SECRET: undefined,
      });

      const res = await POST(realRequest("POST", "Bearer wrong-secret"));

      expect(res.status).toBe(401);
      expect(sweepUnsentConfirmationEmails).not.toHaveBeenCalled();
    });

    it("GET returns 401 when no Authorization header is sent but a secret is configured", async () => {
      setEnv({
        NODE_ENV: "production",
        EMAIL_SWEEP_SECRET: "correct-secret",
        CRON_SECRET: undefined,
      });

      // No auth header — omit the argument entirely
      const res = await GET(realRequest("GET"));

      expect(res.status).toBe(401);
      expect(sweepUnsentConfirmationEmails).not.toHaveBeenCalled();
    });
  });

  describe("development / test — open access when no secret is configured", () => {
    it("GET runs the sweep without a token in non-production", async () => {
      setEnv({
        NODE_ENV: "test",
        EMAIL_SWEEP_SECRET: undefined,
        CRON_SECRET: undefined,
      });

      const res = await GET(realRequest("GET"));

      expect(res.status).toBe(200);
      expect(sweepUnsentConfirmationEmails).toHaveBeenCalledOnce();
    });
  });
});
