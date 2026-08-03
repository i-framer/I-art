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
import { describeIntegration } from "./helpers/skip-if-no-db";

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
  vi.fn().mockResolvedValue({ scanned: 0, sent: 0, failed: 0, skipped: 0 }),
);
const sweepUnsentGalleryAlerts = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ scanned: 0, sent: 0, failed: 0, skipped: 0 }),
);
const sweepUnsentStatusEmails = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ scanned: 0, sent: 0, failed: 0, skipped: 0 }),
);

vi.mock("@/lib/email-sweep", () => ({
  sweepUnsentConfirmationEmails,
  sweepUnsentGalleryAlerts,
  sweepUnsentStatusEmails,
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

describeIntegration("email-sweep route integration — auth guard with real Request objects", () => {
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

  describe("development with a secret configured — token is still required", () => {
    // secrets.length > 0 triggers auth regardless of NODE_ENV, so even in
    // development the endpoint must reject requests that omit the Bearer token.

    it("GET returns 401 when no Authorization header is sent in development", async () => {
      setEnv({
        NODE_ENV: "development",
        EMAIL_SWEEP_SECRET: "dev-secret-xyz",
        CRON_SECRET: undefined,
      });

      const res = await GET(realRequest("GET"));

      expect(res.status).toBe(401);
      expect((res.body as any).error).toMatch(/Unauthorized/i);
      expect(sweepUnsentConfirmationEmails).not.toHaveBeenCalled();
    });

    it("POST returns 401 when no Authorization header is sent in development", async () => {
      setEnv({
        NODE_ENV: "development",
        EMAIL_SWEEP_SECRET: "dev-secret-xyz",
        CRON_SECRET: undefined,
      });

      const res = await POST(realRequest("POST"));

      expect(res.status).toBe(401);
      expect((res.body as any).error).toMatch(/Unauthorized/i);
      expect(sweepUnsentConfirmationEmails).not.toHaveBeenCalled();
    });

    it("GET with correct Bearer token runs the sweep and returns 200 in development", async () => {
      setEnv({
        NODE_ENV: "development",
        EMAIL_SWEEP_SECRET: "dev-secret-xyz",
        CRON_SECRET: undefined,
      });

      const res = await GET(realRequest("GET", "Bearer dev-secret-xyz"));

      expect(res.status).toBe(200);
      expect(sweepUnsentConfirmationEmails).toHaveBeenCalledOnce();
    });

    it("POST with correct Bearer token runs the sweep and returns 200 in development", async () => {
      setEnv({
        NODE_ENV: "development",
        EMAIL_SWEEP_SECRET: "dev-secret-xyz",
        CRON_SECRET: undefined,
      });

      const res = await POST(realRequest("POST", "Bearer dev-secret-xyz"));

      expect(res.status).toBe(200);
      expect(sweepUnsentConfirmationEmails).toHaveBeenCalledOnce();
    });
  });

  describe("development with only CRON_SECRET configured — token is still required", () => {
    // The symmetric case to the EMAIL_SWEEP_SECRET dev tests above: CRON_SECRET
    // alone (no EMAIL_SWEEP_SECRET) must also enforce auth in development.

    it("GET returns 401 when no Authorization header is sent in development", async () => {
      setEnv({
        NODE_ENV: "development",
        EMAIL_SWEEP_SECRET: undefined,
        CRON_SECRET: "cron-only-dev-secret",
      });

      const res = await GET(realRequest("GET"));

      expect(res.status).toBe(401);
      expect((res.body as any).error).toMatch(/Unauthorized/i);
      expect(sweepUnsentConfirmationEmails).not.toHaveBeenCalled();
    });

    it("POST returns 401 when no Authorization header is sent in development", async () => {
      setEnv({
        NODE_ENV: "development",
        EMAIL_SWEEP_SECRET: undefined,
        CRON_SECRET: "cron-only-dev-secret",
      });

      const res = await POST(realRequest("POST"));

      expect(res.status).toBe(401);
      expect((res.body as any).error).toMatch(/Unauthorized/i);
      expect(sweepUnsentConfirmationEmails).not.toHaveBeenCalled();
    });

    it("GET with correct Bearer CRON_SECRET runs the sweep and returns 200 in development", async () => {
      setEnv({
        NODE_ENV: "development",
        EMAIL_SWEEP_SECRET: undefined,
        CRON_SECRET: "cron-only-dev-secret",
      });

      const res = await GET(realRequest("GET", "Bearer cron-only-dev-secret"));

      expect(res.status).toBe(200);
      expect(sweepUnsentConfirmationEmails).toHaveBeenCalledOnce();
    });

    it("POST with correct Bearer CRON_SECRET runs the sweep and returns 200 in development", async () => {
      setEnv({
        NODE_ENV: "development",
        EMAIL_SWEEP_SECRET: undefined,
        CRON_SECRET: "cron-only-dev-secret",
      });

      const res = await POST(realRequest("POST", "Bearer cron-only-dev-secret"));

      expect(res.status).toBe(200);
      expect(sweepUnsentConfirmationEmails).toHaveBeenCalledOnce();
    });
  });

  describe("per-row error surfacing", () => {
    it("GET returns 207 and includes the error count when sweep reports errors > 0", async () => {
      setEnv({
        NODE_ENV: "test",
        EMAIL_SWEEP_SECRET: undefined,
        CRON_SECRET: undefined,
      });
      sweepUnsentConfirmationEmails.mockResolvedValueOnce({
        scanned: 3,
        sent: 2,
        failed: 1,
        skipped: 0,
      });

      const res = await GET(realRequest("GET"));

      expect(res.status).toBe(207);
      expect((res.body as any).failed).toBe(1);
      expect((res.body as any).sent).toBe(2);
      expect((res.body as any).scanned).toBe(3);
    });

    it("POST returns 207 when sweep reports errors > 0", async () => {
      setEnv({
        NODE_ENV: "test",
        EMAIL_SWEEP_SECRET: undefined,
        CRON_SECRET: undefined,
      });
      sweepUnsentConfirmationEmails.mockResolvedValueOnce({
        scanned: 5,
        sent: 3,
        failed: 2,
        skipped: 0,
      });

      const res = await POST(realRequest("POST"));

      expect(res.status).toBe(207);
      expect((res.body as any).failed).toBe(2);
    });

    it("GET returns 200 when sweep reports zero errors", async () => {
      setEnv({
        NODE_ENV: "test",
        EMAIL_SWEEP_SECRET: undefined,
        CRON_SECRET: undefined,
      });
      sweepUnsentConfirmationEmails.mockResolvedValueOnce({
        scanned: 4,
        sent: 4,
        failed: 0,
        skipped: 0,
      });

      const res = await GET(realRequest("GET"));

      expect(res.status).toBe(200);
    });

    it("returns 207 even when authorized via Bearer token", async () => {
      setEnv({
        NODE_ENV: "production",
        EMAIL_SWEEP_SECRET: "my-secret",
        CRON_SECRET: undefined,
      });
      sweepUnsentConfirmationEmails.mockResolvedValueOnce({
        scanned: 10,
        sent: 7,
        failed: 3,
        skipped: 0,
      });

      const res = await GET(realRequest("GET", "Bearer my-secret"));

      expect(res.status).toBe(207);
      expect((res.body as any).failed).toBe(3);
    });
  });

  describe("both EMAIL_SWEEP_SECRET and CRON_SECRET set — each independently admits the right caller", () => {
    it("GET with EMAIL_SWEEP_SECRET token returns 200 when both secrets are configured", async () => {
      setEnv({
        NODE_ENV: "production",
        EMAIL_SWEEP_SECRET: "email-secret-aaa",
        CRON_SECRET: "cron-secret-bbb",
      });

      const res = await GET(realRequest("GET", "Bearer email-secret-aaa"));

      expect(res.status).toBe(200);
      expect(sweepUnsentConfirmationEmails).toHaveBeenCalledOnce();
    });

    it("GET with CRON_SECRET token returns 200 when both secrets are configured", async () => {
      setEnv({
        NODE_ENV: "production",
        EMAIL_SWEEP_SECRET: "email-secret-aaa",
        CRON_SECRET: "cron-secret-bbb",
      });

      const res = await GET(realRequest("GET", "Bearer cron-secret-bbb"));

      expect(res.status).toBe(200);
      expect(sweepUnsentConfirmationEmails).toHaveBeenCalledOnce();
    });

    it("GET with neither token returns 401 when both secrets are configured", async () => {
      setEnv({
        NODE_ENV: "production",
        EMAIL_SWEEP_SECRET: "email-secret-aaa",
        CRON_SECRET: "cron-secret-bbb",
      });

      const res = await GET(realRequest("GET", "Bearer wrong-secret-zzz"));

      expect(res.status).toBe(401);
      expect((res.body as any).error).toMatch(/Unauthorized/i);
      expect(sweepUnsentConfirmationEmails).not.toHaveBeenCalled();
    });

    it("POST with EMAIL_SWEEP_SECRET token returns 200 when both secrets are configured", async () => {
      setEnv({
        NODE_ENV: "production",
        EMAIL_SWEEP_SECRET: "email-secret-aaa",
        CRON_SECRET: "cron-secret-bbb",
      });

      const res = await POST(realRequest("POST", "Bearer email-secret-aaa"));

      expect(res.status).toBe(200);
      expect(sweepUnsentConfirmationEmails).toHaveBeenCalledOnce();
    });

    it("POST with CRON_SECRET token returns 200 when both secrets are configured", async () => {
      setEnv({
        NODE_ENV: "production",
        EMAIL_SWEEP_SECRET: "email-secret-aaa",
        CRON_SECRET: "cron-secret-bbb",
      });

      const res = await POST(realRequest("POST", "Bearer cron-secret-bbb"));

      expect(res.status).toBe(200);
      expect(sweepUnsentConfirmationEmails).toHaveBeenCalledOnce();
    });

    it("POST with neither token returns 401 when both secrets are configured", async () => {
      setEnv({
        NODE_ENV: "production",
        EMAIL_SWEEP_SECRET: "email-secret-aaa",
        CRON_SECRET: "cron-secret-bbb",
      });

      const res = await POST(realRequest("POST", "Bearer wrong-secret-zzz"));

      expect(res.status).toBe(401);
      expect(sweepUnsentConfirmationEmails).not.toHaveBeenCalled();
    });

    it("GET with no Authorization header returns 401 when both secrets are configured", async () => {
      setEnv({
        NODE_ENV: "production",
        EMAIL_SWEEP_SECRET: "email-secret-aaa",
        CRON_SECRET: "cron-secret-bbb",
      });

      // No Authorization header at all — not even a wrong token
      const res = await GET(realRequest("GET"));

      expect(res.status).toBe(401);
      expect((res.body as any).error).toMatch(/Unauthorized/i);
      expect(sweepUnsentConfirmationEmails).not.toHaveBeenCalled();
    });

    it("POST with no Authorization header returns 401 when both secrets are configured", async () => {
      setEnv({
        NODE_ENV: "production",
        EMAIL_SWEEP_SECRET: "email-secret-aaa",
        CRON_SECRET: "cron-secret-bbb",
      });

      // No Authorization header at all — not even a wrong token
      const res = await POST(realRequest("POST"));

      expect(res.status).toBe(401);
      expect((res.body as any).error).toMatch(/Unauthorized/i);
      expect(sweepUnsentConfirmationEmails).not.toHaveBeenCalled();
    });
  });
});
