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
 *  - Inquiry sweep (sweepUnsentInquiryEmails) is blocked / allowed in
 *    lock-step with the same EMAIL_SWEEP_SECRET Bearer-token gate
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Email sweep mock ──────────────────────────────────────────────────────────
vi.mock("@/lib/email-sweep", () => ({
  sweepUnsentConfirmationEmails: vi.fn().mockResolvedValue({ scanned: 0, sent: 0, failed: 0, skipped: 0 }),
  sweepUnsentGalleryAlerts: vi.fn().mockResolvedValue({ scanned: 0, sent: 0, failed: 0, skipped: 0 }),
  sweepUnsentStatusEmails: vi.fn().mockResolvedValue({ scanned: 0, sent: 0, failed: 0, skipped: 0 }),
  sweepUnsentInquiryEmails: vi.fn().mockResolvedValue({ scanned: 0, sent: 0, failed: 0, skipped: 0 }),
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
import {
  sweepUnsentConfirmationEmails,
  sweepUnsentInquiryEmails,
} from "@/lib/email-sweep";

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

  it("returns 401 on GET with a wrong Bearer token when EMAIL_SWEEP_SECRET is set", async () => {
    setEnv({ EMAIL_SWEEP_SECRET: "correct-secret" });

    const res = await GET(makeRequest("Bearer wrong-secret", "GET"));
    expect(res.status).toBe(401);
    expect(sweepUnsentConfirmationEmails).not.toHaveBeenCalled();
  });

  it("returns 401 on GET with a wrong Bearer token when CRON_SECRET is set", async () => {
    setEnv({ CRON_SECRET: "cron-secret" });

    const res = await GET(makeRequest("Bearer wrong-cron-secret", "GET"));
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

/**
 * Inquiry-sweep auth gate
 *
 * sweepUnsentInquiryEmails is called by the same combined route
 * (app/api/email-sweep/route.ts) and is gated by the same
 * EMAIL_SWEEP_SECRET / CRON_SECRET Bearer-token check.
 *
 * These tests assert that the inquiry sweep is explicitly blocked
 * or allowed in lock-step with that gate.
 */
describe("email sweep route — inquiry sweep auth gate (EMAIL_SWEEP_SECRET)", () => {
  it("does not call sweepUnsentInquiryEmails and returns 401 when no Authorization header is sent and EMAIL_SWEEP_SECRET is configured", async () => {
    setEnv({ EMAIL_SWEEP_SECRET: "inquiry-secret" });

    const res = await POST(makeRequest()); // no auth header
    expect(res.status).toBe(401);
    expect(sweepUnsentInquiryEmails).not.toHaveBeenCalled();
  });

  it("does not call sweepUnsentInquiryEmails and returns 401 when a wrong Bearer token is sent and EMAIL_SWEEP_SECRET is configured", async () => {
    setEnv({ EMAIL_SWEEP_SECRET: "inquiry-secret" });

    const res = await POST(makeRequest("Bearer wrong-secret"));
    expect(res.status).toBe(401);
    expect(sweepUnsentInquiryEmails).not.toHaveBeenCalled();
  });

  it("calls sweepUnsentInquiryEmails and returns 200 when the correct EMAIL_SWEEP_SECRET Bearer token is sent", async () => {
    setEnv({ EMAIL_SWEEP_SECRET: "inquiry-secret" });

    const res = await POST(makeRequest("Bearer inquiry-secret"));
    expect(res.status).toBe(200);
    expect(sweepUnsentInquiryEmails).toHaveBeenCalledOnce();
  });
});

/**
 * inquiryResult shape and top-level totals
 *
 * The combined sweep response body must include an `inquiryResult` object with
 * the four standard numeric fields, and the top-level totals must incorporate
 * the inquiry sweep's contribution.
 */
describe("email sweep route — inquiryResult in response body", () => {
  it("response body contains inquiryResult with scanned/sent/failed/skipped fields when request is authorized", async () => {
    setEnv({ EMAIL_SWEEP_SECRET: "test-secret" });
    vi.mocked(sweepUnsentInquiryEmails).mockResolvedValueOnce({
      scanned: 5,
      sent: 3,
      failed: 1,
      skipped: 1,
    });

    const res = await POST(makeRequest("Bearer test-secret"));
    expect(res.status).toBe(207); // failed > 0 → 207

    const body = await res.json();
    expect(body).toHaveProperty("inquiryResult");
    const { inquiryResult } = body;
    expect(typeof inquiryResult.scanned).toBe("number");
    expect(typeof inquiryResult.sent).toBe("number");
    expect(typeof inquiryResult.failed).toBe("number");
    expect(typeof inquiryResult.skipped).toBe("number");
    expect(inquiryResult).toEqual({ scanned: 5, sent: 3, failed: 1, skipped: 1 });
  });

  it("top-level totals include the inquiry sweep contribution", async () => {
    setEnv({ EMAIL_SWEEP_SECRET: "test-secret" });

    // All other sweeps return zeros; only inquiry returns non-zero values
    vi.mocked(sweepUnsentInquiryEmails).mockResolvedValueOnce({
      scanned: 10,
      sent: 4,
      failed: 2,
      skipped: 3,
    });

    const res = await POST(makeRequest("Bearer test-secret"));
    const body = await res.json();

    // Top-level totals must at least include the inquiry contribution.
    // Other sweeps are mocked to return zeros (see top-level vi.mock).
    expect(body.scanned).toBe(10);
    expect(body.sent).toBe(4);
    expect(body.failed).toBe(2);
    expect(body.skipped).toBe(3);
  });

  it("inquiryResult fields are all zero when sweepUnsentInquiryEmails returns zeros", async () => {
    setEnv({ EMAIL_SWEEP_SECRET: "test-secret" });
    // Default mock returns all zeros — no override needed

    const res = await POST(makeRequest("Bearer test-secret"));
    expect(res.status).toBe(200); // no failures → 200

    const body = await res.json();
    expect(body.inquiryResult).toEqual({ scanned: 0, sent: 0, failed: 0, skipped: 0 });
  });
});
