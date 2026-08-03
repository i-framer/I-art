/**
 * Email sweep route — production fail-closed and auth edge cases.
 *
 * The email sweep route is the only sweep with explicit production/no-secret
 * fail-closed behavior: when NODE_ENV=production and no secret is configured,
 * the route returns 403 (not 200) to prevent strangers from triggering sweeps.
 *
 * The reservation sweep is open (no production fail-closed) — that is tested
 * separately in reservation-sweep-route.test.ts.
 *
 * Covers:
 *  - Production + no secret → 403 (fail-closed)
 *  - Development + no secret → 200 (open for convenience)
 *  - Wrong Bearer token → 403
 *  - Correct EMAIL_SWEEP_SECRET → 200
 *  - Correct CRON_SECRET → 200
 *  - Malformed auth header (Basic scheme) → 403
 *  - Sweep errors return 500 not 403
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Email sweep mock ──────────────────────────────────────────────────────────
vi.mock("@/lib/email-sweep", () => ({
  sweepUnsentConfirmationEmails: vi.fn().mockResolvedValue({ scanned: 0, sent: 0, failed: 0, skipped: 0 }),
  sweepUnsentGalleryAlerts: vi.fn().mockResolvedValue({ scanned: 0, sent: 0, failed: 0, skipped: 0 }),
  sweepUnsentStatusEmails: vi.fn().mockResolvedValue({ scanned: 0, sent: 0, failed: 0, skipped: 0 }),
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

import { GET, POST } from "@/app/api/email-sweep/route";
import { sweepUnsentConfirmationEmails } from "@/lib/email-sweep";

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
  return new Request("http://localhost/api/email-sweep", { method, headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  setEnv({ EMAIL_SWEEP_SECRET: undefined, CRON_SECRET: undefined });
});

afterEach(() => {
  restoreEnv();
});

describe("email sweep route — production fail-closed", () => {
  it("returns 403 in production when no secret is configured", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const res = await POST(makeRequest()); // no auth header
    expect(res.status).toBe(403);
    expect(sweepUnsentConfirmationEmails).not.toHaveBeenCalled();
  });

  it("returns 200 in development when no secret is configured", async () => {
    vi.stubEnv("NODE_ENV", "development");

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(sweepUnsentConfirmationEmails).toHaveBeenCalledOnce();
  });
});

describe("email sweep route — token validation", () => {
  it("returns 401 for a wrong token when EMAIL_SWEEP_SECRET is set", async () => {
    setEnv({ EMAIL_SWEEP_SECRET: "correct-secret" });

    const res = await POST(makeRequest("Bearer wrong-secret"));
    expect(res.status).toBe(401);
    expect(sweepUnsentConfirmationEmails).not.toHaveBeenCalled();
  });

  it("returns 200 for the correct EMAIL_SWEEP_SECRET", async () => {
    setEnv({ EMAIL_SWEEP_SECRET: "correct-secret" });

    const res = await POST(makeRequest("Bearer correct-secret"));
    expect(res.status).toBe(200);
    expect(sweepUnsentConfirmationEmails).toHaveBeenCalledOnce();
  });

  it("returns 200 for the correct CRON_SECRET (Vercel cron pattern)", async () => {
    setEnv({ CRON_SECRET: "vercel-cron-secret" });

    const res = await GET(makeRequest("Bearer vercel-cron-secret", "GET"));
    expect(res.status).toBe(200);
  });

  it("returns 401 for a malformed Basic scheme auth header", async () => {
    setEnv({ EMAIL_SWEEP_SECRET: "my-secret" });

    const res = await POST(makeRequest("Basic bXktc2VjcmV0")); // base64(my-secret)
    expect(res.status).toBe(401);
    expect(sweepUnsentConfirmationEmails).not.toHaveBeenCalled();
  });

  it("returns 401 when token is correct but missing 'Bearer ' prefix", async () => {
    setEnv({ EMAIL_SWEEP_SECRET: "my-secret" });

    const res = await POST(makeRequest("my-secret")); // no Bearer prefix
    expect(res.status).toBe(401);
    expect(sweepUnsentConfirmationEmails).not.toHaveBeenCalled();
  });

  it("accepts either secret when both are configured", async () => {
    setEnv({ EMAIL_SWEEP_SECRET: "sweep-secret", CRON_SECRET: "cron-secret" });

    const r1 = await POST(makeRequest("Bearer sweep-secret"));
    const r2 = await GET(makeRequest("Bearer cron-secret", "GET"));

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });
});

describe("email sweep route — error handling", () => {
  it("returns 500 when the sweep throws", async () => {
    vi.mocked(sweepUnsentConfirmationEmails).mockRejectedValueOnce(new Error("DB timeout"));

    const res = await POST(makeRequest());
    expect(res.status).toBe(500);
  });
});
