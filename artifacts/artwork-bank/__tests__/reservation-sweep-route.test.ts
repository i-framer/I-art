/**
 * Reservation sweep route — authorization and failure handling.
 *
 * The route is open in dev (no secret configured) and requires a Bearer token
 * in production (RESERVATION_SWEEP_SECRET or CRON_SECRET). It exposes both
 * GET (for Vercel cron) and POST.
 *
 * Covers:
 *  - No secret configured → request without token is allowed (dev/open mode)
 *  - RESERVATION_SWEEP_SECRET set → request without token returns 401
 *  - RESERVATION_SWEEP_SECRET set → correct token returns sweep result (200)
 *  - CRON_SECRET set → Vercel-style cron request is authorized
 *  - Sweep throws → route returns 500 without propagating the error
 *  - GET and POST both work
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Reservation sweep mock ────────────────────────────────────────────────────
const sweepStaleReservations = vi.hoisted(() => vi.fn());
vi.mock("@/lib/reservation-sweep", () => ({ sweepStaleReservations }));

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

import { GET, POST } from "@/app/api/reservation-sweep/route";

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
  return new Request("http://localhost/api/reservation-sweep", { method, headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  sweepStaleReservations.mockResolvedValue({ swept: 0, released: 0 });
  setEnv({ RESERVATION_SWEEP_SECRET: undefined, CRON_SECRET: undefined });
});

afterEach(() => {
  restoreEnv();
});

describe("reservation sweep route — authorization", () => {
  it("allows a request without a token when no secret is configured (dev/open)", async () => {
    const res = await POST(makeRequest()); // no auth header, no secret configured
    expect(res.status).toBe(200);
    expect(sweepStaleReservations).toHaveBeenCalledOnce();
  });

  it("returns 401 when RESERVATION_SWEEP_SECRET is set and no auth header", async () => {
    setEnv({ RESERVATION_SWEEP_SECRET: "secret-token-123" });
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
    expect(sweepStaleReservations).not.toHaveBeenCalled();
  });

  it("returns 401 when RESERVATION_SWEEP_SECRET is set and wrong token", async () => {
    setEnv({ RESERVATION_SWEEP_SECRET: "correct-token" });
    const res = await POST(makeRequest("Bearer wrong-token"));
    expect(res.status).toBe(401);
    expect(sweepStaleReservations).not.toHaveBeenCalled();
  });

  it("returns 200 with sweep result when correct RESERVATION_SWEEP_SECRET is provided", async () => {
    setEnv({ RESERVATION_SWEEP_SECRET: "correct-token" });
    sweepStaleReservations.mockResolvedValue({ swept: 3, released: 1 });

    const res = await POST(makeRequest("Bearer correct-token"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ swept: 3, released: 1 });
  });

  it("authorizes via CRON_SECRET (Vercel cron pattern)", async () => {
    setEnv({ CRON_SECRET: "vercel-cron-secret" });

    const res = await GET(makeRequest("Bearer vercel-cron-secret", "GET"));

    expect(res.status).toBe(200);
    expect(sweepStaleReservations).toHaveBeenCalledOnce();
  });

  it("accepts either secret when both are configured", async () => {
    setEnv({ RESERVATION_SWEEP_SECRET: "sweep-secret", CRON_SECRET: "cron-secret" });

    const res1 = await POST(makeRequest("Bearer sweep-secret"));
    const res2 = await GET(makeRequest("Bearer cron-secret", "GET"));

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
  });
});

describe("reservation sweep route — error handling", () => {
  it("returns 500 when sweep throws without propagating the error", async () => {
    sweepStaleReservations.mockRejectedValueOnce(new Error("DB timeout"));

    const res = await POST(makeRequest());

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });

  it("GET works identically to POST", async () => {
    sweepStaleReservations.mockResolvedValue({ swept: 1, released: 0 });

    const res = await GET(makeRequest(undefined, "GET"));

    expect(res.status).toBe(200);
    expect(sweepStaleReservations).toHaveBeenCalledOnce();
  });
});
