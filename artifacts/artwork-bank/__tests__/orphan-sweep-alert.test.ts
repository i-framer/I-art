/**
 * Task #205 — Confirm the orphan sweep alert reaches the operator when the
 * sweep reports storage errors.
 *
 * When sweepOrphanedImageFiles() returns errors > 0, the route must call
 * sendOrphanSweepSlackNotification (Slack) AND sendOrphanSweepErrorNotification
 * (email) so the operator is notified via both channels.  If neither is called,
 * the operator would have to notice the 207 response or check logs manually.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── mock next/server ──────────────────────────────────────────────────────────
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) => ({
      status: init?.status ?? 200,
      body,
    }),
  },
}));

// ── sweep mock ────────────────────────────────────────────────────────────────
const sweepOrphanedImageFiles = vi.hoisted(() => vi.fn());

vi.mock("@/lib/orphan-image-sweep", () => ({
  sweepOrphanedImageFiles,
}));

// ── notification mocks ────────────────────────────────────────────────────────
const sendOrphanSweepSlackNotification = vi.hoisted(() => vi.fn());
const sendOrphanSweepErrorNotification = vi.hoisted(() => vi.fn());

vi.mock("@/lib/slack", () => ({
  sendOrphanSweepSlackNotification: (...a: any[]) =>
    sendOrphanSweepSlackNotification(...a),
}));

vi.mock("@/lib/email", () => ({
  sendOrphanSweepErrorNotification: (...a: any[]) =>
    sendOrphanSweepErrorNotification(...a),
}));

import { GET, POST } from "@/app/api/storage/orphan-sweep/route";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(authHeader?: string): Request {
  return {
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "authorization" ? (authHeader ?? null) : null,
    },
  } as unknown as Request;
}

const originalEnv: Record<string, string | undefined> = {};
function setEnv(overrides: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(overrides)) {
    originalEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  for (const key of Object.keys(originalEnv)) delete originalEnv[key];
}

beforeEach(() => {
  vi.clearAllMocks();
  setEnv({ NODE_ENV: "test" });
  sendOrphanSweepSlackNotification.mockResolvedValue({ ok: true });
  sendOrphanSweepErrorNotification.mockResolvedValue(undefined);
});

afterEach(() => {
  restoreEnv();
});

// ─────────────────────────────────────────────────────────────────────────────

describe("orphan-sweep route — operator alert on errors (Task #205)", () => {
  it("sends the Slack alert when sweep reports errors > 0", async () => {
    sweepOrphanedImageFiles.mockResolvedValue({
      orphaned: 5,
      deleted: 3,
      errors: 2,
      failedPaths: ["/objects/uploads/abc.jpg", "/objects/uploads/def.jpg"],
    });

    await GET(makeRequest());

    expect(sendOrphanSweepSlackNotification).toHaveBeenCalledOnce();
    expect(sendOrphanSweepSlackNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        errors: 2,
        failedPaths: expect.arrayContaining(["/objects/uploads/abc.jpg"]),
      }),
    );
  });

  it("sends the email alert when sweep reports errors > 0", async () => {
    sweepOrphanedImageFiles.mockResolvedValue({
      orphaned: 4,
      deleted: 2,
      errors: 2,
      failedPaths: ["/objects/uploads/err1.jpg"],
    });

    await GET(makeRequest());

    expect(sendOrphanSweepErrorNotification).toHaveBeenCalledOnce();
    expect(sendOrphanSweepErrorNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        errors: 2,
        failedPaths: expect.arrayContaining(["/objects/uploads/err1.jpg"]),
      }),
    );
  });

  it("returns 207 Multi-Status when errors > 0 so monitoring notices", async () => {
    sweepOrphanedImageFiles.mockResolvedValue({
      orphaned: 3,
      deleted: 1,
      errors: 2,
      failedPaths: ["/objects/uploads/bad.jpg"],
    });

    const res = await GET(makeRequest());

    expect(res.status).toBe(207);
  });

  it("does NOT send any alert when sweep completes with zero errors", async () => {
    sweepOrphanedImageFiles.mockResolvedValue({
      orphaned: 10,
      deleted: 10,
      errors: 0,
      failedPaths: [],
    });

    await GET(makeRequest());

    expect(sendOrphanSweepSlackNotification).not.toHaveBeenCalled();
    expect(sendOrphanSweepErrorNotification).not.toHaveBeenCalled();
  });

  it("returns 200 when sweep completes with zero errors", async () => {
    sweepOrphanedImageFiles.mockResolvedValue({
      orphaned: 10,
      deleted: 10,
      errors: 0,
      failedPaths: [],
    });

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
  });

  it("still sends the email alert even when the Slack call fails", async () => {
    sweepOrphanedImageFiles.mockResolvedValue({
      orphaned: 2,
      deleted: 0,
      errors: 2,
      failedPaths: ["/objects/uploads/x.jpg"],
    });
    sendOrphanSweepSlackNotification.mockResolvedValue({
      ok: false,
      error: "channel_not_found",
    });

    await GET(makeRequest());

    // Email should still be sent, and slackFailure should be included
    expect(sendOrphanSweepErrorNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        slackFailure: "channel_not_found",
      }),
    );
  });

  it("POST also triggers the alerts", async () => {
    sweepOrphanedImageFiles.mockResolvedValue({
      orphaned: 1,
      deleted: 0,
      errors: 1,
      failedPaths: ["/objects/uploads/broken.jpg"],
    });

    await POST(makeRequest());

    expect(sendOrphanSweepSlackNotification).toHaveBeenCalledOnce();
    expect(sendOrphanSweepErrorNotification).toHaveBeenCalledOnce();
  });

  it("returns 207 with the sweep counts even when sendOrphanSweepErrorNotification throws", async () => {
    const sweepResult = {
      orphaned: 4,
      deleted: 2,
      errors: 2,
      failedPaths: ["/objects/uploads/fail1.jpg", "/objects/uploads/fail2.jpg"],
    };
    sweepOrphanedImageFiles.mockResolvedValue(sweepResult);
    sendOrphanSweepErrorNotification.mockRejectedValue(
      new Error("SMTP connection refused"),
    );

    const res = await GET(makeRequest());

    // HTTP status must be 207, not 500
    expect(res.status).toBe(207);
    // The response body must carry the original sweep counts
    expect(res.body).toEqual(sweepResult);
  });

  it("still returns 207 with correct sweep body when both Slack returns { ok: false } AND email throws", async () => {
    const sweepResult = {
      orphaned: 3,
      deleted: 1,
      errors: 2,
      failedPaths: ["/objects/uploads/a.jpg", "/objects/uploads/b.jpg"],
    };
    sweepOrphanedImageFiles.mockResolvedValue(sweepResult);
    sendOrphanSweepSlackNotification.mockResolvedValue({
      ok: false,
      error: "slack_not_configured",
    });
    sendOrphanSweepErrorNotification.mockRejectedValue(
      new Error("SMTP connection refused"),
    );

    const res = await GET(makeRequest());

    // HTTP status must be 207, not 500 — dual notification failure must not
    // change the response code or mask the sweep result.
    expect(res.status).toBe(207);
    // The body must carry the original sweep counts unchanged.
    expect(res.body).toEqual(sweepResult);
  });
});
