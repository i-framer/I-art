/**
 * Integration test — confirm the orphan-sweep route honours the CRON_SECRET
 * auth path (used by Vercel's scheduled cron runner) and that the email
 * failure is still recorded when the sweep is triggered that way.
 *
 * The sweep itself is mocked so these tests do not compete with other
 * orphan-sweep integration tests that insert and consume real orphan rows.
 * What is under test here is:
 *
 *  1. A request carrying `Authorization: Bearer $CRON_SECRET` is admitted and
 *     the sweep runs — it is NOT rejected as unauthorised.
 *
 *  2. When the sweep reports errors (mocked) and email re-throws, the route
 *     still returns 207 with the sweep counts and logs the email failure.
 *     A misconfigured CRON_SECRET must not silently suppress the sweep result.
 *
 *  3. A request carrying a wrong bearer token is rejected with 401, and no
 *     notification functions are called.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

// ── Mock next/server ──────────────────────────────────────────────────────────

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) => ({
      status: init?.status ?? 200,
      body,
    }),
  },
}));

// ── Mock object-storage (not used by the mocked sweep, but imported by route) ─

vi.mock("@/lib/object-storage", () => ({
  deleteObject: vi.fn().mockResolvedValue(undefined),
  StorageNotConfiguredError: class StorageNotConfiguredError extends Error {},
}));

// ── Mock the sweep so it returns a deterministic result with errors > 0.
//    This prevents these tests from competing with other integration tests
//    that insert and consume real orphan rows concurrently.

const sweepOrphanedImageFiles = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    orphaned: 2,
    deleted: 1,
    errors: 1,
    failedPaths: ["/objects/uploads/cron-test-orphan"],
  }),
);

vi.mock("@/lib/orphan-image-sweep", () => ({
  sweepOrphanedImageFiles: (...a: unknown[]) =>
    sweepOrphanedImageFiles(...a),
}));

// ── Notification mocks ────────────────────────────────────────────────────────

/** Slack resolves successfully by default. */
const sendOrphanSweepSlackNotification = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ ok: true }),
);

/**
 * Email always re-throws — simulating a transport failure.
 * This is the behaviour under test: even when triggered via CRON_SECRET,
 * the email failure must be caught and logged, not suppress the sweep result.
 */
const sendOrphanSweepErrorNotification = vi.hoisted(() =>
  vi.fn().mockRejectedValue(new Error("SMTP connection refused")),
);

vi.mock("@/lib/slack", () => ({
  sendOrphanSweepSlackNotification: (...a: unknown[]) =>
    sendOrphanSweepSlackNotification(...a),
}));

vi.mock("@/lib/email", () => ({
  sendOrphanSweepErrorNotification: (...a: unknown[]) =>
    sendOrphanSweepErrorNotification(...a),
}));

// ── Route import (after mocks) ────────────────────────────────────────────────

import { GET } from "@/app/api/storage/orphan-sweep/route";

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid() {
  return randomUUID();
}

/**
 * Build a request authenticated exactly as Vercel's cron runner does:
 *   Authorization: Bearer $CRON_SECRET
 */
function makeCronRequest(cronSecret: string): Request {
  return new Request("http://localhost/api/storage/orphan-sweep", {
    method: "GET",
    headers: { Authorization: `Bearer ${cronSecret}` },
  });
}

// ── Env-var helpers ───────────────────────────────────────────────────────────

function withCronSecretOnly(
  cronSecret: string,
  fn: () => Promise<void>,
): () => Promise<void> {
  return async () => {
    const origCron = process.env.CRON_SECRET;
    const origSweep = process.env.ORPHAN_SWEEP_SECRET;
    process.env.CRON_SECRET = cronSecret;
    delete process.env.ORPHAN_SWEEP_SECRET;
    try {
      await fn();
    } finally {
      if (origCron === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = origCron;
      if (origSweep === undefined) delete process.env.ORPHAN_SWEEP_SECRET;
      else process.env.ORPHAN_SWEEP_SECRET = origSweep;
    }
  };
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  sweepOrphanedImageFiles.mockClear();
  sweepOrphanedImageFiles.mockResolvedValue({
    orphaned: 2,
    deleted: 1,
    errors: 1,
    failedPaths: ["/objects/uploads/cron-test-orphan"],
  });

  sendOrphanSweepSlackNotification.mockClear();
  sendOrphanSweepSlackNotification.mockResolvedValue({ ok: true });

  sendOrphanSweepErrorNotification.mockClear();
  sendOrphanSweepErrorNotification.mockRejectedValue(
    new Error("SMTP connection refused"),
  );

  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe(
  "orphan-sweep route — CRON_SECRET auth path and email failure propagation",
  () => {
    it(
      "returns 207 with sweep counts and logs the email failure when triggered via CRON_SECRET",
      withCronSecretOnly(`test-cron-${uid()}`, async () => {
        const cronSecret = process.env.CRON_SECRET!;

        // Act: send the request exactly as Vercel's cron runner would.
        const res = await GET(makeCronRequest(cronSecret));

        // Assert: the route admitted the CRON_SECRET bearer token and ran the sweep.
        expect(res.status).toBe(207);

        const body = res.body as unknown as {
          orphaned: number;
          deleted: number;
          errors: number;
          failedPaths: string[];
          notificationFailure?: { slack?: string; email?: string };
        };

        // Sweep counts come from the mocked sweep result.
        expect(body.orphaned).toBe(2);
        expect(body.errors).toBe(1);
        expect(body.failedPaths).toContain("/objects/uploads/cron-test-orphan");

        // The sweep was invoked (auth succeeded, not short-circuited to 401).
        expect(sweepOrphanedImageFiles).toHaveBeenCalledOnce();

        // Both notification functions were called.
        expect(sendOrphanSweepSlackNotification).toHaveBeenCalledOnce();
        expect(sendOrphanSweepErrorNotification).toHaveBeenCalledOnce();

        // The email re-throw was caught and logged — not silently swallowed.
        // This is the key guarantee: the CRON_SECRET auth path must not change
        // how the route handles a notification failure.
        const consoleErrorCalls = vi
          .mocked(console.error)
          .mock.calls.map((args) => args.join(" "));
        expect(
          consoleErrorCalls.some((msg) =>
            msg.includes("Email notification failed"),
          ),
        ).toBe(true);

        // Only email failed (Slack succeeded) — notificationFailure not surfaced.
        expect(body.notificationFailure).toBeUndefined();
      }),
    );

    it(
      "returns 401 and skips the sweep when the bearer token does not match CRON_SECRET",
      withCronSecretOnly(`test-cron-${uid()}`, async () => {
        // Act: send a request with the wrong bearer token.
        const res = await GET(
          new Request("http://localhost/api/storage/orphan-sweep", {
            method: "GET",
            headers: { Authorization: "Bearer wrong-token" },
          }),
        );

        // Assert: 401 — the sweep must not have run.
        expect(res.status).toBe(401);
        expect(sweepOrphanedImageFiles).not.toHaveBeenCalled();
        expect(sendOrphanSweepSlackNotification).not.toHaveBeenCalled();
        expect(sendOrphanSweepErrorNotification).not.toHaveBeenCalled();
      }),
    );

    it(
      "returns 401 when no Authorization header is sent and CRON_SECRET is set",
      withCronSecretOnly(`test-cron-${uid()}`, async () => {
        // Act: send a request with no Authorization header.
        const res = await GET(
          new Request("http://localhost/api/storage/orphan-sweep", {
            method: "GET",
          }),
        );

        // Assert: 401 — missing header is treated as unauthorized.
        expect(res.status).toBe(401);
        expect(sweepOrphanedImageFiles).not.toHaveBeenCalled();
      }),
    );
  },
);
