/**
 * Tests for the email-sweep API route's authentication guard.
 *
 * Verifies that:
 *  1. In production with no secret configured, the endpoint returns 403.
 *  2. An authorised request (valid Bearer token) passes through and returns 200.
 *  3. An unauthorised request (wrong token) returns 401.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Mock next/server so the route can be imported in a plain Node environment ──

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) => ({
      status: init?.status ?? 200,
      body,
    }),
  },
}));

// ── Mock the sweep implementation so no DB or email is touched ─────────────────

const sweepUnsentConfirmationEmails = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ scanned: 0, sent: 0, failed: 0, skipped: 0 })
);
const sweepUnsentGalleryAlerts = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ scanned: 0, sent: 0, failed: 0, skipped: 0 })
);
const sweepUnsentStatusEmails = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ scanned: 0, sent: 0, failed: 0, skipped: 0 })
);
const sweepUnsentInquiryEmails = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ scanned: 0, sent: 0, failed: 0, skipped: 0 })
);

vi.mock("@/lib/email-sweep", () => ({
  sweepUnsentConfirmationEmails,
  sweepUnsentGalleryAlerts,
  sweepUnsentStatusEmails,
  sweepUnsentInquiryEmails,
}));

// ── Import the route handlers after mocks are in place ────────────────────────

import { GET, POST } from "@/app/api/email-sweep/route";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(authHeader?: string): Request {
  return {
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "authorization" ? (authHeader ?? null) : null,
    },
  } as unknown as Request;
}

// ── Env management ─────────────────────────────────────────────────────────────

const originalEnv: Record<string, string | undefined> = {};

function setEnv(overrides: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(overrides)) {
    originalEnv[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  // Clear tracked keys
  for (const key of Object.keys(originalEnv)) {
    delete originalEnv[key];
  }
}

beforeEach(() => {
  sweepUnsentConfirmationEmails.mockClear();
});

afterEach(() => {
  restoreEnv();
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("email-sweep route — authentication guard", () => {
  describe("production with no secret configured", () => {
    it("GET returns 403 and does not run the sweep", async () => {
      setEnv({
        NODE_ENV: "production",
        EMAIL_SWEEP_SECRET: undefined,
        CRON_SECRET: undefined,
      });

      const res = await GET(makeRequest());

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

      const res = await POST(makeRequest());

      expect(res.status).toBe(403);
      expect(sweepUnsentConfirmationEmails).not.toHaveBeenCalled();
    });
  });

  describe("production with a secret configured — valid token", () => {
    it("GET with correct Bearer token runs the sweep and returns 200", async () => {
      setEnv({
        NODE_ENV: "production",
        EMAIL_SWEEP_SECRET: "super-secret-abc",
        CRON_SECRET: undefined,
      });

      const res = await GET(makeRequest("Bearer super-secret-abc"));

      expect(res.status).toBe(200);
      expect(sweepUnsentConfirmationEmails).toHaveBeenCalledOnce();
    });

    it("POST with correct Bearer token runs the sweep and returns 200", async () => {
      setEnv({
        NODE_ENV: "production",
        EMAIL_SWEEP_SECRET: "super-secret-abc",
        CRON_SECRET: undefined,
      });

      const res = await POST(makeRequest("Bearer super-secret-abc"));

      expect(res.status).toBe(200);
      expect(sweepUnsentConfirmationEmails).toHaveBeenCalledOnce();
    });

    it("accepts CRON_SECRET as an alternative to EMAIL_SWEEP_SECRET", async () => {
      setEnv({
        NODE_ENV: "production",
        EMAIL_SWEEP_SECRET: undefined,
        CRON_SECRET: "cron-token-xyz",
      });

      const res = await GET(makeRequest("Bearer cron-token-xyz"));

      expect(res.status).toBe(200);
      expect(sweepUnsentConfirmationEmails).toHaveBeenCalledOnce();
    });
  });

  describe("production with a secret configured — wrong token", () => {
    it("GET returns 401 when the Bearer token does not match", async () => {
      setEnv({
        NODE_ENV: "production",
        EMAIL_SWEEP_SECRET: "correct-secret",
        CRON_SECRET: undefined,
      });

      const res = await GET(makeRequest("Bearer wrong-secret"));

      expect(res.status).toBe(401);
      expect((res.body as any).error).toMatch(/Unauthorized/i);
      expect(sweepUnsentConfirmationEmails).not.toHaveBeenCalled();
    });

    it("POST returns 401 when the Bearer token does not match", async () => {
      setEnv({
        NODE_ENV: "production",
        EMAIL_SWEEP_SECRET: "correct-secret",
        CRON_SECRET: undefined,
      });

      const res = await POST(makeRequest("Bearer wrong-secret"));

      expect(res.status).toBe(401);
      expect(sweepUnsentConfirmationEmails).not.toHaveBeenCalled();
    });

    it("returns 401 when Authorization header is absent but a secret is configured", async () => {
      setEnv({
        NODE_ENV: "production",
        EMAIL_SWEEP_SECRET: "correct-secret",
        CRON_SECRET: undefined,
      });

      const res = await GET(makeRequest()); // no Authorization header

      expect(res.status).toBe(401);
      expect(sweepUnsentConfirmationEmails).not.toHaveBeenCalled();
    });
  });

  describe("development / test — open access when no secret is set", () => {
    it("GET runs the sweep without any token in non-production", async () => {
      setEnv({
        NODE_ENV: "test",
        EMAIL_SWEEP_SECRET: undefined,
        CRON_SECRET: undefined,
      });

      const res = await GET(makeRequest());

      expect(res.status).toBe(200);
      expect(sweepUnsentConfirmationEmails).toHaveBeenCalledOnce();
    });
  });

  describe("per-row error surfacing", () => {
    it("returns 207 and includes error count when sweep reports errors > 0", async () => {
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

      const res = await GET(makeRequest());

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

      const res = await POST(makeRequest());

      expect(res.status).toBe(207);
      expect((res.body as any).failed).toBe(2);
    });

    it("returns 200 when sweep reports zero errors", async () => {
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

      const res = await GET(makeRequest());

      expect(res.status).toBe(200);
    });
  });
});
