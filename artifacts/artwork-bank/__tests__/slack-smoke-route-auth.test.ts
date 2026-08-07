/**
 * Slack smoke route — auth guard unit tests.
 *
 * Verifies that /api/slack-smoke enforces its Bearer-token guard correctly
 * without making any real network calls to the Slack connector.
 *
 * Covers:
 *  - No secret configured + production  → 403 (fail-closed)
 *  - No secret configured + development → 200 (open for convenience)
 *  - Secret configured + no auth header → 401
 *  - Secret configured + wrong token    → 401
 *  - Correct SLACK_SMOKE_SECRET         → 200 (probes mocked to succeed)
 *  - Correct CRON_SECRET                → 200
 *  - Both secrets set, either accepted  → 200
 *  - Malformed auth scheme (Basic)      → 401
 *  - Token without "Bearer " prefix     → 401
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Slack notification mocks (no live connector calls) ────────────────────────
const mockSendBillingAlert = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ ok: true }),
);
const mockSendIframerAlert = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ ok: true }),
);

vi.mock("@/lib/slack", () => ({
  sendBillingAlertSlackNotification: mockSendBillingAlert,
  sendIframerAccountSlackNotification: mockSendIframerAlert,
}));

// ── next/server mock ──────────────────────────────────────────────────────────
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
  },
}));

import { POST, GET } from "@/app/api/slack-smoke/route";

// ── Env helpers ───────────────────────────────────────────────────────────────
const savedEnv: Record<string, string | undefined> = {};
function setEnv(o: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(o)) {
    savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
function restoreEnv() {
  for (const [k, v] of Object.entries(savedEnv))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  for (const k of Object.keys(savedEnv)) delete savedEnv[k];
}

function makeRequest(auth?: string, method = "POST"): Request {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  return new Request("http://localhost/api/slack-smoke", { method, headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  setEnv({
    SLACK_SMOKE_SECRET: undefined,
    CRON_SECRET: undefined,
    SLACK_BILLING_ALERTS_CHANNEL: "test-channel",
  });
});

afterEach(() => {
  restoreEnv();
});

// ── Production fail-closed ────────────────────────────────────────────────────
describe("slack smoke route — production fail-closed (no secret)", () => {
  it("returns 403 in production when no secret is configured", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const res = await POST(makeRequest());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Forbidden");
    expect(mockSendBillingAlert).not.toHaveBeenCalled();
    expect(mockSendIframerAlert).not.toHaveBeenCalled();
  });

  it("returns 200 in development when no secret is configured", async () => {
    vi.stubEnv("NODE_ENV", "development");

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(mockSendBillingAlert).toHaveBeenCalledOnce();
  });
});

// ── Token validation ──────────────────────────────────────────────────────────
describe("slack smoke route — token validation", () => {
  it("returns 401 when no Authorization header is provided and a secret is set", async () => {
    setEnv({ SLACK_SMOKE_SECRET: "my-secret" });

    const res = await POST(makeRequest()); // no auth header
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
    expect(mockSendBillingAlert).not.toHaveBeenCalled();
    expect(mockSendIframerAlert).not.toHaveBeenCalled();
  });

  it("returns 401 when the Bearer token is wrong", async () => {
    setEnv({ SLACK_SMOKE_SECRET: "correct-secret" });

    const res = await POST(makeRequest("Bearer wrong-secret"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
    expect(mockSendBillingAlert).not.toHaveBeenCalled();
  });

  it("returns 200 and runs probes when the correct SLACK_SMOKE_SECRET is supplied", async () => {
    setEnv({ SLACK_SMOKE_SECRET: "correct-secret" });

    const res = await POST(makeRequest("Bearer correct-secret"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(mockSendBillingAlert).toHaveBeenCalledOnce();
    expect(mockSendIframerAlert).toHaveBeenCalledOnce();
  });

  it("returns 200 when the correct CRON_SECRET is supplied (Vercel cron pattern)", async () => {
    setEnv({ CRON_SECRET: "vercel-cron-secret" });

    const res = await POST(makeRequest("Bearer vercel-cron-secret"));
    expect(res.status).toBe(200);
    expect(mockSendBillingAlert).toHaveBeenCalledOnce();
  });

  it("accepts either secret when both SLACK_SMOKE_SECRET and CRON_SECRET are set", async () => {
    setEnv({ SLACK_SMOKE_SECRET: "smoke-secret", CRON_SECRET: "cron-secret" });

    const r1 = await POST(makeRequest("Bearer smoke-secret"));
    const r2 = await POST(makeRequest("Bearer cron-secret"));

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });

  it("returns 401 for a malformed Basic scheme auth header", async () => {
    setEnv({ SLACK_SMOKE_SECRET: "my-secret" });

    // base64("my-secret") — wrong scheme
    const res = await POST(makeRequest("Basic bXktc2VjcmV0"));
    expect(res.status).toBe(401);
    expect(mockSendBillingAlert).not.toHaveBeenCalled();
  });

  it("returns 401 when the token is correct but the 'Bearer ' prefix is missing", async () => {
    setEnv({ SLACK_SMOKE_SECRET: "my-secret" });

    const res = await POST(makeRequest("my-secret")); // no Bearer prefix
    expect(res.status).toBe(401);
    expect(mockSendBillingAlert).not.toHaveBeenCalled();
  });
});

// ── GET alias ─────────────────────────────────────────────────────────────────
describe("slack smoke route — GET alias", () => {
  it("GET with wrong token also returns 401", async () => {
    setEnv({ SLACK_SMOKE_SECRET: "my-secret" });

    const res = await GET(makeRequest("Bearer bad-token", "GET"));
    expect(res.status).toBe(401);
  });

  it("GET with correct token returns 200", async () => {
    setEnv({ SLACK_SMOKE_SECRET: "my-secret" });

    const res = await GET(makeRequest("Bearer my-secret", "GET"));
    expect(res.status).toBe(200);
  });
});
