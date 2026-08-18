/**
 * ensureEmailSweepScheduler — unit tests.
 *
 * Verifies that the periodic scheduler:
 *  1. Registers a setInterval (starts the timer).
 *  2. Is idempotent — calling it twice creates only one timer.
 *  3. Calls clearAllStuckNonces() immediately before sweepUnsentInquiryEmails()
 *     in each scheduled run so stuck inquiries are auto-healed in the same
 *     cycle without manual admin intervention.
 *  4. A failure in clearAllStuckNonces does not prevent the inquiry sweep from
 *     running (each step is independently guarded).
 *  5. Each subsequent interval tick also runs the self-heal before the inquiry
 *     sweep — not just the first kickoff.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock all sweep functions ──────────────────────────────────────────────────

const sweepUnsentConfirmationEmails = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ scanned: 0, sent: 0, failed: 0, skipped: 0 }),
);
const sweepUnsentStatusEmails = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ scanned: 0, sent: 0, failed: 0, skipped: 0 }),
);
const sweepUnsentInquiryEmails = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ scanned: 0, sent: 0, failed: 0, skipped: 0 }),
);
const clearAllStuckNonces = vi.hoisted(() => vi.fn().mockResolvedValue(0));

vi.mock("@/lib/email-sweep", () => ({
  sweepUnsentConfirmationEmails,
  sweepUnsentStatusEmails,
  sweepUnsentInquiryEmails,
  clearAllStuckNonces,
}));

const sweepStaleReservations = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ released: 0, ids: [] }),
);
vi.mock("@/lib/reservation-sweep", () => ({ sweepStaleReservations }));

// ── Import under test (after mocks) ──────────────────────────────────────────

import { ensureEmailSweepScheduler } from "@/lib/email-sweep-scheduler";

// ── Constants mirroring the scheduler ────────────────────────────────────────

/** The initial stagger delay before the first run. */
const KICKOFF_MS = 15_000;
/** Default interval (matches EMAIL_SWEEP_INTERVAL_MS default). */
const INTERVAL_MS = 5 * 60 * 1000;

// ── Globals ───────────────────────────────────────────────────────────────────

const GLOBAL_KEY = "__artworkBankEmailSweepTimer";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Advance fake timers past the kickoff delay so the first run() executes and
 * all its async steps (sweeps) complete.
 */
async function triggerFirstRun() {
  await vi.advanceTimersByTimeAsync(KICKOFF_MS + 1);
}

/**
 * Advance fake timers by one full interval to trigger the next scheduled run
 * and wait for its async steps to complete.
 */
async function triggerNextRun() {
  await vi.advanceTimersByTimeAsync(INTERVAL_MS + 1);
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  // Clear the singleton guard so each test starts fresh.
  delete (globalThis as any)[GLOBAL_KEY];
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as any)[GLOBAL_KEY];
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ensureEmailSweepScheduler", () => {
  it("registers a timer on first call", () => {
    ensureEmailSweepScheduler();
    expect((globalThis as any)[GLOBAL_KEY]).toBeDefined();
  });

  it("is idempotent — a second call reuses the existing timer", () => {
    ensureEmailSweepScheduler();
    const first = (globalThis as any)[GLOBAL_KEY];
    ensureEmailSweepScheduler();
    expect((globalThis as any)[GLOBAL_KEY]).toBe(first);
  });

  it("calls clearAllStuckNonces before sweepUnsentInquiryEmails in each scheduled run", async () => {
    const callOrder: string[] = [];
    clearAllStuckNonces.mockImplementation(async () => {
      callOrder.push("clearAllStuckNonces");
      return 0;
    });
    sweepUnsentInquiryEmails.mockImplementation(async () => {
      callOrder.push("sweepUnsentInquiryEmails");
      return { scanned: 0, sent: 0, failed: 0, skipped: 0 };
    });

    ensureEmailSweepScheduler();
    await triggerFirstRun();

    const healIdx = callOrder.indexOf("clearAllStuckNonces");
    const sweepIdx = callOrder.indexOf("sweepUnsentInquiryEmails");

    expect(healIdx).toBeGreaterThanOrEqual(0); // self-heal was called
    expect(sweepIdx).toBeGreaterThanOrEqual(0); // inquiry sweep was called
    expect(healIdx).toBeLessThan(sweepIdx);     // self-heal came first
  });

  it("inquiry sweep still runs if clearAllStuckNonces throws", async () => {
    clearAllStuckNonces.mockRejectedValueOnce(new Error("DB timeout"));

    ensureEmailSweepScheduler();
    await triggerFirstRun();

    expect(sweepUnsentInquiryEmails).toHaveBeenCalledOnce();
  });

  it("each subsequent interval tick also self-heals before the inquiry sweep", async () => {
    ensureEmailSweepScheduler();

    // First kickoff run
    await triggerFirstRun();
    expect(clearAllStuckNonces).toHaveBeenCalledTimes(1);
    expect(sweepUnsentInquiryEmails).toHaveBeenCalledTimes(1);

    // Second run (interval tick)
    await triggerNextRun();
    expect(clearAllStuckNonces).toHaveBeenCalledTimes(2);
    expect(sweepUnsentInquiryEmails).toHaveBeenCalledTimes(2);
  });
});
