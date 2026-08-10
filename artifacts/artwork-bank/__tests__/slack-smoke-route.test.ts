/**
 * Tests for the /api/slack-smoke route's authentication guard.
 *
 * Verifies that:
 *  1. In production with no secret configured, the endpoint returns 403
 *     (prevents openly triggering synthetic Slack messages in production).
 *  2. An authorised request (valid Bearer token) passes through and returns 200.
 *  3. An unauthorised request (wrong token) returns 401.
 *  4. In development with no secret, the endpoint is open (returns 200).
 *
 * No real Slack calls are made — sendBillingAlertSlackNotification and
 * sendIframerAccountSlackNotification are mocked to return { ok: true }.
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

// ── Mock Slack functions — no real network calls ───────────────────────────────

vi.mock("@/lib/slack", () => ({
  sendBillingAlertSlackNotification: vi.fn().mockResolvedValue({ ok: true }),
  sendIframerAccountSlackNotification: vi.fn().mockResolvedValue({ ok: true }),
  sendWebhookRedirectAlertSmoke: vi.fn().mockResolvedValue({ ok: true }),
}));

// ── Import the route handlers after mocks are in place ────────────────────────

import { GET, POST } from "@/app/api/slack-smoke/route";

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
  for (const key of Object.keys(originalEnv)) {
    delete originalEnv[key];
  }
}

afterEach(() => {
  restoreEnv();
  vi.clearAllMocks();
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("slack-smoke route — authentication guard", () => {
  describe("production with no secret configured", () => {
    beforeEach(() => {
      setEnv({
        NODE_ENV: "production",
        SLACK_SMOKE_SECRET: undefined,
        CRON_SECRET: undefined,
        SLACK_BILLING_ALERTS_CHANNEL: "ops-alerts",
      });
    });

    it("POST returns 403 and does not call Slack functions", async () => {
      const { sendBillingAlertSlackNotification } = await import("@/lib/slack");

      const res = await POST(makeRequest());

      expect(res.status).toBe(403);
      expect((res.body as any).error).toMatch(/Forbidden/i);
      expect(sendBillingAlertSlackNotification).not.toHaveBeenCalled();
    });

    it("GET returns 403 and does not call Slack functions", async () => {
      const { sendBillingAlertSlackNotification } = await import("@/lib/slack");

      const res = await GET(makeRequest());

      expect(res.status).toBe(403);
      expect(sendBillingAlertSlackNotification).not.toHaveBeenCalled();
    });
  });

  describe("production with a secret configured — valid token", () => {
    beforeEach(() => {
      setEnv({
        NODE_ENV: "production",
        SLACK_SMOKE_SECRET: "correct-secret",
        CRON_SECRET: undefined,
        SLACK_BILLING_ALERTS_CHANNEL: "ops-alerts",
      });
    });

    it("POST with correct Bearer token runs both probes and returns 200", async () => {
      const {
        sendBillingAlertSlackNotification,
        sendIframerAccountSlackNotification,
      } = await import("@/lib/slack");

      const res = await POST(makeRequest("Bearer correct-secret"));

      expect(res.status).toBe(200);
      expect((res.body as any).ok).toBe(true);
      expect(sendBillingAlertSlackNotification).toHaveBeenCalledOnce();
      expect(sendIframerAccountSlackNotification).toHaveBeenCalledOnce();
    });

    it("GET with correct Bearer token runs both probes and returns 200", async () => {
      const {
        sendBillingAlertSlackNotification,
        sendIframerAccountSlackNotification,
      } = await import("@/lib/slack");

      const res = await GET(makeRequest("Bearer correct-secret"));

      expect(res.status).toBe(200);
      expect((res.body as any).ok).toBe(true);
      expect(sendBillingAlertSlackNotification).toHaveBeenCalledOnce();
      expect(sendIframerAccountSlackNotification).toHaveBeenCalledOnce();
    });

    it("accepts CRON_SECRET as an alternative to SLACK_SMOKE_SECRET", async () => {
      setEnv({
        NODE_ENV: "production",
        SLACK_SMOKE_SECRET: undefined,
        CRON_SECRET: "cron-token-xyz",
        SLACK_BILLING_ALERTS_CHANNEL: "ops-alerts",
      });

      const { sendBillingAlertSlackNotification } = await import("@/lib/slack");

      const res = await POST(makeRequest("Bearer cron-token-xyz"));

      expect(res.status).toBe(200);
      expect(sendBillingAlertSlackNotification).toHaveBeenCalledOnce();
    });
  });

  describe("production with a secret configured — wrong or missing token", () => {
    beforeEach(() => {
      setEnv({
        NODE_ENV: "production",
        SLACK_SMOKE_SECRET: "correct-secret",
        CRON_SECRET: undefined,
        SLACK_BILLING_ALERTS_CHANNEL: "ops-alerts",
      });
    });

    it("POST returns 401 when the Bearer token does not match", async () => {
      const { sendBillingAlertSlackNotification } = await import("@/lib/slack");

      const res = await POST(makeRequest("Bearer wrong-secret"));

      expect(res.status).toBe(401);
      expect((res.body as any).error).toMatch(/Unauthorized/i);
      expect(sendBillingAlertSlackNotification).not.toHaveBeenCalled();
    });

    it("GET returns 401 when the Bearer token does not match", async () => {
      const { sendBillingAlertSlackNotification } = await import("@/lib/slack");

      const res = await GET(makeRequest("Bearer wrong-secret"));

      expect(res.status).toBe(401);
      expect(sendBillingAlertSlackNotification).not.toHaveBeenCalled();
    });

    it("returns 401 when Authorization header is absent but a secret is configured", async () => {
      const { sendBillingAlertSlackNotification } = await import("@/lib/slack");

      const res = await POST(makeRequest()); // no Authorization header

      expect(res.status).toBe(401);
      expect(sendBillingAlertSlackNotification).not.toHaveBeenCalled();
    });
  });

  describe("development / test — open access when no secret is set", () => {
    beforeEach(() => {
      setEnv({
        NODE_ENV: "test",
        SLACK_SMOKE_SECRET: undefined,
        CRON_SECRET: undefined,
        SLACK_BILLING_ALERTS_CHANNEL: "ops-alerts",
      });
    });

    it("POST runs both probes without any token in non-production", async () => {
      const {
        sendBillingAlertSlackNotification,
        sendIframerAccountSlackNotification,
      } = await import("@/lib/slack");

      const res = await POST(makeRequest());

      expect(res.status).toBe(200);
      expect((res.body as any).ok).toBe(true);
      expect(sendBillingAlertSlackNotification).toHaveBeenCalledOnce();
      expect(sendIframerAccountSlackNotification).toHaveBeenCalledOnce();
    });
  });

  describe("channel not configured", () => {
    it("returns 503 when SLACK_BILLING_ALERTS_CHANNEL is missing (open dev)", async () => {
      setEnv({
        NODE_ENV: "test",
        SLACK_SMOKE_SECRET: undefined,
        CRON_SECRET: undefined,
        SLACK_BILLING_ALERTS_CHANNEL: undefined,
      });

      const res = await POST(makeRequest());

      expect(res.status).toBe(503);
      expect((res.body as any).ok).toBe(false);
      expect((res.body as any).error).toMatch(/channel not configured/i);
    });
  });

  describe("probe failure propagation", () => {
    it("returns ok:false when a Slack function returns ok:false", async () => {
      setEnv({
        NODE_ENV: "test",
        SLACK_SMOKE_SECRET: undefined,
        CRON_SECRET: undefined,
        SLACK_BILLING_ALERTS_CHANNEL: "ops-alerts",
      });

      const { sendBillingAlertSlackNotification } = await import("@/lib/slack");
      vi.mocked(sendBillingAlertSlackNotification).mockResolvedValueOnce({
        ok: false,
        error: "invalid_auth",
      });

      const res = await POST(makeRequest());

      expect(res.status).toBe(200); // HTTP 200 — the endpoint ran successfully
      expect((res.body as any).ok).toBe(false);
      const results: Array<{ test: string; ok: boolean; error?: string }> =
        (res.body as any).results;
      const billingResult = results.find((r) => r.test === "billing-alert");
      expect(billingResult?.ok).toBe(false);
      expect(billingResult?.error).toBe("invalid_auth");
    });
  });
});
