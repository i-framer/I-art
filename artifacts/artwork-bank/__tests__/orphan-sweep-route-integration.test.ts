/**
 * Integration tests for the orphan-sweep API route's authentication guard.
 *
 * These tests differ from the unit tests in orphan-sweep-route.test.ts in one
 * important way: they use real Web API Request objects (new Request(...)) so
 * the route handler runs against the same request-parsing pipeline it would
 * encounter in a real Next.js environment.  The sweep implementation is still
 * mocked so no database or storage side-effects occur.
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

// ── Mock the sweep so no DB or storage is touched ────────────────────────────

const sweepOrphanedImageFiles = vi.hoisted(() =>
  vi
    .fn()
    .mockResolvedValue({ orphaned: 0, deleted: 0, errors: 0, failedPaths: [] }),
);

vi.mock("@/lib/orphan-image-sweep", () => ({
  sweepOrphanedImageFiles,
}));

// ── Import route handlers after mocks are in place ───────────────────────────

import { GET, POST } from "@/app/api/storage/orphan-sweep/route";
import { GET as healthGET } from "@/app/api/storage/orphan-sweep/health/route";

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
function realRequest(method: "GET" | "POST", authHeader?: string): Request {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) {
    headers["authorization"] = authHeader;
  }
  return new Request("http://localhost/api/storage/orphan-sweep", {
    method,
    headers,
  });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  sweepOrphanedImageFiles.mockClear();
});

afterEach(() => {
  restoreEnv();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describeIntegration("orphan-sweep route integration — auth guard with real Request objects", () => {
  describe("production with no secret configured → 403", () => {
    it("GET returns 403 and does not run the sweep", async () => {
      setEnv({
        NODE_ENV: "production",
        ORPHAN_SWEEP_SECRET: undefined,
        CRON_SECRET: undefined,
      });

      const res = await GET(realRequest("GET"));

      expect(res.status).toBe(403);
      expect((res.body as any).error).toMatch(/Forbidden/i);
      expect(sweepOrphanedImageFiles).not.toHaveBeenCalled();
    });

    it("POST returns 403 and does not run the sweep", async () => {
      setEnv({
        NODE_ENV: "production",
        ORPHAN_SWEEP_SECRET: undefined,
        CRON_SECRET: undefined,
      });

      const res = await POST(realRequest("POST"));

      expect(res.status).toBe(403);
      expect(sweepOrphanedImageFiles).not.toHaveBeenCalled();
    });
  });

  describe("production with a valid Bearer token → 200", () => {
    it("GET with correct ORPHAN_SWEEP_SECRET runs the sweep and returns 200", async () => {
      setEnv({
        NODE_ENV: "production",
        ORPHAN_SWEEP_SECRET: "integration-secret-abc",
        CRON_SECRET: undefined,
      });

      const res = await GET(realRequest("GET", "Bearer integration-secret-abc"));

      expect(res.status).toBe(200);
      expect(sweepOrphanedImageFiles).toHaveBeenCalledOnce();
    });

    it("POST with correct ORPHAN_SWEEP_SECRET runs the sweep and returns 200", async () => {
      setEnv({
        NODE_ENV: "production",
        ORPHAN_SWEEP_SECRET: "integration-secret-abc",
        CRON_SECRET: undefined,
      });

      const res = await POST(
        realRequest("POST", "Bearer integration-secret-abc"),
      );

      expect(res.status).toBe(200);
      expect(sweepOrphanedImageFiles).toHaveBeenCalledOnce();
    });

    it("GET accepts CRON_SECRET as an alternative token", async () => {
      setEnv({
        NODE_ENV: "production",
        ORPHAN_SWEEP_SECRET: undefined,
        CRON_SECRET: "cron-integration-xyz",
      });

      const res = await GET(realRequest("GET", "Bearer cron-integration-xyz"));

      expect(res.status).toBe(200);
      expect(sweepOrphanedImageFiles).toHaveBeenCalledOnce();
    });

    it("POST accepts CRON_SECRET as the only configured secret", async () => {
      setEnv({
        NODE_ENV: "production",
        ORPHAN_SWEEP_SECRET: undefined,
        CRON_SECRET: "cron-integration-xyz",
      });

      const res = await POST(
        realRequest("POST", "Bearer cron-integration-xyz"),
      );

      expect(res.status).toBe(200);
      expect(sweepOrphanedImageFiles).toHaveBeenCalledOnce();
    });
  });

  describe("production with a wrong Bearer token → 401", () => {
    it("GET returns 401 when the token does not match", async () => {
      setEnv({
        NODE_ENV: "production",
        ORPHAN_SWEEP_SECRET: "correct-secret",
        CRON_SECRET: undefined,
      });

      const res = await GET(realRequest("GET", "Bearer wrong-secret"));

      expect(res.status).toBe(401);
      expect((res.body as any).error).toMatch(/Unauthorized/i);
      expect(sweepOrphanedImageFiles).not.toHaveBeenCalled();
    });

    it("POST returns 401 when the token does not match", async () => {
      setEnv({
        NODE_ENV: "production",
        ORPHAN_SWEEP_SECRET: "correct-secret",
        CRON_SECRET: undefined,
      });

      const res = await POST(realRequest("POST", "Bearer wrong-secret"));

      expect(res.status).toBe(401);
      expect(sweepOrphanedImageFiles).not.toHaveBeenCalled();
    });

    it("GET returns 401 when no Authorization header is sent but a secret is configured", async () => {
      setEnv({
        NODE_ENV: "production",
        ORPHAN_SWEEP_SECRET: "correct-secret",
        CRON_SECRET: undefined,
      });

      // No auth header — omit the argument entirely
      const res = await GET(realRequest("GET"));

      expect(res.status).toBe(401);
      expect(sweepOrphanedImageFiles).not.toHaveBeenCalled();
    });
  });

  describe("development / test — open access when no secret is configured", () => {
    it("GET runs the sweep without a token in non-production", async () => {
      setEnv({
        NODE_ENV: "test",
        ORPHAN_SWEEP_SECRET: undefined,
        CRON_SECRET: undefined,
      });

      const res = await GET(realRequest("GET"));

      expect(res.status).toBe(200);
      expect(sweepOrphanedImageFiles).toHaveBeenCalledOnce();
    });
  });

  describe("both ORPHAN_SWEEP_SECRET and CRON_SECRET set — each independently admits the right caller", () => {
    it("GET with ORPHAN_SWEEP_SECRET token returns 200 when both secrets are configured", async () => {
      setEnv({
        NODE_ENV: "production",
        ORPHAN_SWEEP_SECRET: "sweep-secret-aaa",
        CRON_SECRET: "cron-secret-bbb",
      });

      const res = await GET(realRequest("GET", "Bearer sweep-secret-aaa"));

      expect(res.status).toBe(200);
      expect(sweepOrphanedImageFiles).toHaveBeenCalledOnce();
    });

    it("GET with CRON_SECRET token returns 200 when both secrets are configured", async () => {
      setEnv({
        NODE_ENV: "production",
        ORPHAN_SWEEP_SECRET: "sweep-secret-aaa",
        CRON_SECRET: "cron-secret-bbb",
      });

      const res = await GET(realRequest("GET", "Bearer cron-secret-bbb"));

      expect(res.status).toBe(200);
      expect(sweepOrphanedImageFiles).toHaveBeenCalledOnce();
    });

    it("GET with neither token returns 401 when both secrets are configured", async () => {
      setEnv({
        NODE_ENV: "production",
        ORPHAN_SWEEP_SECRET: "sweep-secret-aaa",
        CRON_SECRET: "cron-secret-bbb",
      });

      const res = await GET(realRequest("GET", "Bearer wrong-secret-zzz"));

      expect(res.status).toBe(401);
      expect((res.body as any).error).toMatch(/Unauthorized/i);
      expect(sweepOrphanedImageFiles).not.toHaveBeenCalled();
    });

    it("POST with ORPHAN_SWEEP_SECRET token returns 200 when both secrets are configured", async () => {
      setEnv({
        NODE_ENV: "production",
        ORPHAN_SWEEP_SECRET: "sweep-secret-aaa",
        CRON_SECRET: "cron-secret-bbb",
      });

      const res = await POST(realRequest("POST", "Bearer sweep-secret-aaa"));

      expect(res.status).toBe(200);
      expect(sweepOrphanedImageFiles).toHaveBeenCalledOnce();
    });

    it("POST with CRON_SECRET token returns 200 when both secrets are configured", async () => {
      setEnv({
        NODE_ENV: "production",
        ORPHAN_SWEEP_SECRET: "sweep-secret-aaa",
        CRON_SECRET: "cron-secret-bbb",
      });

      const res = await POST(realRequest("POST", "Bearer cron-secret-bbb"));

      expect(res.status).toBe(200);
      expect(sweepOrphanedImageFiles).toHaveBeenCalledOnce();
    });

    it("POST with neither token returns 401 when both secrets are configured", async () => {
      setEnv({
        NODE_ENV: "production",
        ORPHAN_SWEEP_SECRET: "sweep-secret-aaa",
        CRON_SECRET: "cron-secret-bbb",
      });

      const res = await POST(realRequest("POST", "Bearer wrong-secret-zzz"));

      expect(res.status).toBe(401);
      expect(sweepOrphanedImageFiles).not.toHaveBeenCalled();
    });

    it("GET with no Authorization header returns 401 when both secrets are configured", async () => {
      setEnv({
        NODE_ENV: "production",
        ORPHAN_SWEEP_SECRET: "sweep-secret-aaa",
        CRON_SECRET: "cron-secret-bbb",
      });

      // No auth header at all — omit the argument entirely
      const res = await GET(realRequest("GET"));

      expect(res.status).toBe(401);
      expect((res.body as any).error).toMatch(/Unauthorized/i);
      expect(sweepOrphanedImageFiles).not.toHaveBeenCalled();
    });

    it("POST with no Authorization header returns 401 when both secrets are configured", async () => {
      setEnv({
        NODE_ENV: "production",
        ORPHAN_SWEEP_SECRET: "sweep-secret-aaa",
        CRON_SECRET: "cron-secret-bbb",
      });

      // No auth header at all — omit the argument entirely
      const res = await POST(realRequest("POST"));

      expect(res.status).toBe(401);
      expect((res.body as any).error).toMatch(/Unauthorized/i);
      expect(sweepOrphanedImageFiles).not.toHaveBeenCalled();
    });
  });
});

// ── Health endpoint tests ─────────────────────────────────────────────────────

describeIntegration("orphan-sweep health endpoint — auth configuration reporting", () => {
  describe("only CRON_SECRET configured", () => {
    it("reports cronSecret:true, orphanSweepSecret:false, anySecretConfigured:true", async () => {
      setEnv({
        ORPHAN_SWEEP_SECRET: undefined,
        CRON_SECRET: "cron-only-secret",
        SLACK_BILLING_ALERTS_CHANNEL: undefined,
        SMTP_HOST: undefined,
        RESEND_API_KEY: undefined,
        PLATFORM_ADMIN_EMAIL: undefined,
      });

      const res = await healthGET();

      expect(res.status).toBe(200);
      const body = res.body as any;
      expect(body.auth.cronSecret).toBe(true);
      expect(body.auth.orphanSweepSecret).toBe(false);
      expect(body.auth.anySecretConfigured).toBe(true);
    });

    it("reports anyConfigured:false when no notification channels are set", async () => {
      setEnv({
        ORPHAN_SWEEP_SECRET: undefined,
        CRON_SECRET: "cron-only-secret",
        SLACK_BILLING_ALERTS_CHANNEL: undefined,
        SMTP_HOST: undefined,
        RESEND_API_KEY: undefined,
        PLATFORM_ADMIN_EMAIL: undefined,
      });

      const res = await healthGET();

      expect(res.status).toBe(200);
      const body = res.body as any;
      expect(body.anyConfigured).toBe(false);
      expect(body.notificationChannels.slack).toBe(false);
      expect(body.notificationChannels.email).toBe(false);
    });
  });

  describe("only ORPHAN_SWEEP_SECRET configured", () => {
    it("reports orphanSweepSecret:true, cronSecret:false, anySecretConfigured:true", async () => {
      setEnv({
        ORPHAN_SWEEP_SECRET: "sweep-only-secret",
        CRON_SECRET: undefined,
        SLACK_BILLING_ALERTS_CHANNEL: undefined,
        SMTP_HOST: undefined,
        RESEND_API_KEY: undefined,
        PLATFORM_ADMIN_EMAIL: undefined,
      });

      const res = await healthGET();

      expect(res.status).toBe(200);
      const body = res.body as any;
      expect(body.auth.orphanSweepSecret).toBe(true);
      expect(body.auth.cronSecret).toBe(false);
      expect(body.auth.anySecretConfigured).toBe(true);
    });
  });

  describe("no secrets configured", () => {
    it("reports anySecretConfigured:false when neither secret is set", async () => {
      setEnv({
        ORPHAN_SWEEP_SECRET: undefined,
        CRON_SECRET: undefined,
        SLACK_BILLING_ALERTS_CHANNEL: undefined,
        SMTP_HOST: undefined,
        RESEND_API_KEY: undefined,
        PLATFORM_ADMIN_EMAIL: undefined,
      });

      const res = await healthGET();

      expect(res.status).toBe(200);
      const body = res.body as any;
      expect(body.auth.orphanSweepSecret).toBe(false);
      expect(body.auth.cronSecret).toBe(false);
      expect(body.auth.anySecretConfigured).toBe(false);
    });
  });

  describe("both secrets configured", () => {
    it("reports both orphanSweepSecret:true and cronSecret:true", async () => {
      setEnv({
        ORPHAN_SWEEP_SECRET: "sweep-secret",
        CRON_SECRET: "cron-secret",
        SLACK_BILLING_ALERTS_CHANNEL: undefined,
        SMTP_HOST: undefined,
        RESEND_API_KEY: undefined,
        PLATFORM_ADMIN_EMAIL: undefined,
      });

      const res = await healthGET();

      expect(res.status).toBe(200);
      const body = res.body as any;
      expect(body.auth.orphanSweepSecret).toBe(true);
      expect(body.auth.cronSecret).toBe(true);
      expect(body.auth.anySecretConfigured).toBe(true);
    });
  });

  describe("notification channel reporting", () => {
    it("reports slack:true when SLACK_BILLING_ALERTS_CHANNEL is set", async () => {
      setEnv({
        ORPHAN_SWEEP_SECRET: undefined,
        CRON_SECRET: "cron-only-secret",
        SLACK_BILLING_ALERTS_CHANNEL: "C12345678",
        SMTP_HOST: undefined,
        RESEND_API_KEY: undefined,
        PLATFORM_ADMIN_EMAIL: undefined,
      });

      const res = await healthGET();

      expect(res.status).toBe(200);
      const body = res.body as any;
      expect(body.notificationChannels.slack).toBe(true);
      expect(body.anyConfigured).toBe(true);
    });
  });
});
