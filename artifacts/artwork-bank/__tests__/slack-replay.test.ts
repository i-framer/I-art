/**
 * Tests for the replayFailedSlackAlerts server action.
 *
 * Verifies:
 * 1. Only platform admins can trigger a replay.
 * 2. Only alerts with slackPostFailed IS NOT NULL and dismissedAt IS NULL are
 *    targeted.
 * 3. Successful re-posts clear the slackPostFailed flag.
 * 4. Still-failing posts leave the flag set and are counted as failed.
 * 5. When Slack is not configured the rows are skipped without an error.
 * 6. DB errors during the flag-clear are tolerated (the message was delivered).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── DB mock ───────────────────────────────────────────────────────────────────
const mockSelect = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());
const mockWhere = vi.hoisted(() => vi.fn());
const mockSet = vi.hoisted(() => vi.fn());
const mockFrom = vi.hoisted(() => vi.fn());

vi.mock("@workspace/db", () => {
  const stripeAlertsTable = {
    slackPostFailed: "slack_post_failed",
    dismissedAt: "dismissed_at",
    id: "id",
  };

  // select().from().where() chain
  mockFrom.mockReturnValue({ where: mockWhere });
  mockSelect.mockReturnValue({ from: mockFrom });

  // update().set().where()
  mockWhere.mockResolvedValue([]);
  mockSet.mockReturnValue({ where: mockWhere });
  mockUpdate.mockReturnValue({ set: mockSet });

  return {
    db: {
      select: mockSelect,
      update: mockUpdate,
    },
    stripeAlertsTable,
  };
});

// ── Drizzle operator mocks ────────────────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ _and: args }),
  eq: (col: unknown, val: unknown) => ({ _eq: [col, val] }),
  isNotNull: (col: unknown) => ({ _isNotNull: col }),
  isNull: (col: unknown) => ({ _isNull: col }),
}));

// ── Slack mock ────────────────────────────────────────────────────────────────
const mockSendBillingAlertSlackNotification = vi.hoisted(() => vi.fn());
const mockResolveSlackChannel = vi.hoisted(() => vi.fn());

vi.mock("@/lib/slack", () => ({
  resolveSlackChannel: mockResolveSlackChannel,
  sendBillingAlertSlackNotification: mockSendBillingAlertSlackNotification,
}));

// ── Auth mock ─────────────────────────────────────────────────────────────────
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// ── Imports ───────────────────────────────────────────────────────────────────
import { getSession } from "@/lib/auth";
import { replayFailedSlackAlerts } from "@/app/platform/actions";

// ── Helpers ───────────────────────────────────────────────────────────────────
const PLATFORM_EMAIL = "platform@example.com";

function setPlatformAdmin() {
  process.env.PLATFORM_ADMIN_EMAILS = PLATFORM_EMAIL;
  vi.mocked(getSession).mockResolvedValue({
    userId: "u1",
    email: PLATFORM_EMAIL,
  } as never);
}

function makeAlert(overrides: Record<string, unknown> = {}) {
  return {
    id: "alert-1",
    stripeEventId: "evt_1",
    eventType: "customer.subscription.updated",
    customerId: "cus_1",
    subscriptionId: "sub_1",
    reason: "No matching tenant",
    slackPostFailed: new Date(),
    dismissedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

const ORIGINAL_ENV = process.env.PLATFORM_ADMIN_EMAILS;

beforeEach(() => {
  vi.clearAllMocks();
  // Reset the select/from/where chain defaults
  mockFrom.mockReturnValue({ where: mockWhere });
  mockSelect.mockReturnValue({ from: mockFrom });
  mockSet.mockReturnValue({ where: mockWhere });
  mockUpdate.mockReturnValue({ set: mockSet });
  mockWhere.mockResolvedValue([]);
  // Default: channel is configured for every event type
  mockResolveSlackChannel.mockReturnValue("#billing-alerts");
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.PLATFORM_ADMIN_EMAILS;
  else process.env.PLATFORM_ADMIN_EMAILS = ORIGINAL_ENV;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("replayFailedSlackAlerts — access control", () => {
  it("rejects unauthenticated callers without touching Slack or DB", async () => {
    vi.mocked(getSession).mockResolvedValue({} as never);
    await expect(replayFailedSlackAlerts()).rejects.toThrow(/platform admin/i);
    expect(mockSendBillingAlertSlackNotification).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("rejects tenant admins who are not platform admins", async () => {
    process.env.PLATFORM_ADMIN_EMAILS = PLATFORM_EMAIL;
    vi.mocked(getSession).mockResolvedValue({
      userId: "u1",
      email: "gallery@example.com",
    } as never);
    await expect(replayFailedSlackAlerts()).rejects.toThrow(/platform admin/i);
    expect(mockSendBillingAlertSlackNotification).not.toHaveBeenCalled();
  });
});

describe("replayFailedSlackAlerts — no pending failures", () => {
  it("returns zero counts when there are no failed Slack alerts", async () => {
    setPlatformAdmin();
    // select query returns empty list (default from beforeEach)
    const result = await replayFailedSlackAlerts();
    expect(result).toEqual({ replayed: 0, failed: 0, skipped: 0 });
    expect(mockSendBillingAlertSlackNotification).not.toHaveBeenCalled();
  });
});

describe("replayFailedSlackAlerts — successful replay", () => {
  it("calls sendBillingAlertSlackNotification for each pending alert", async () => {
    setPlatformAdmin();
    const alerts = [makeAlert({ id: "a1", stripeEventId: "evt_a1" }), makeAlert({ id: "a2", stripeEventId: "evt_a2" })];
    mockWhere
      .mockResolvedValueOnce(alerts) // SELECT query
      .mockResolvedValue([]); // UPDATE queries

    mockSendBillingAlertSlackNotification.mockResolvedValue({ ok: true });

    const result = await replayFailedSlackAlerts();
    expect(result).toEqual({ replayed: 2, failed: 0, skipped: 0 });
    expect(mockSendBillingAlertSlackNotification).toHaveBeenCalledTimes(2);
  });

  it("passes the correct fields to sendBillingAlertSlackNotification", async () => {
    setPlatformAdmin();
    const alert = makeAlert({
      stripeEventId: "evt_correct_fields",
      eventType: "invoice.payment_failed",
      customerId: "cus_abc",
      subscriptionId: null,
      reason: "Customer not found",
    });
    mockWhere
      .mockResolvedValueOnce([alert])
      .mockResolvedValue([]);
    mockSendBillingAlertSlackNotification.mockResolvedValue({ ok: true });

    await replayFailedSlackAlerts();

    expect(mockSendBillingAlertSlackNotification).toHaveBeenCalledWith({
      stripeEventId: "evt_correct_fields",
      eventType: "invoice.payment_failed",
      customerId: "cus_abc",
      subscriptionId: null,
      reason: "Customer not found",
    });
  });

  it("clears slackPostFailed on successful replay", async () => {
    setPlatformAdmin();
    const alert = makeAlert({ id: "a1" });
    mockWhere
      .mockResolvedValueOnce([alert])
      .mockResolvedValue([]);
    mockSendBillingAlertSlackNotification.mockResolvedValue({ ok: true });

    await replayFailedSlackAlerts();

    // The update chain should have been called to clear the flag
    expect(mockUpdate).toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalledWith({ slackPostFailed: null });
  });
});

describe("replayFailedSlackAlerts — partial failure", () => {
  it("counts still-failing posts as failed and does not clear their flag", async () => {
    setPlatformAdmin();
    const alerts = [
      makeAlert({ id: "ok-1", stripeEventId: "evt_ok" }),
      makeAlert({ id: "fail-1", stripeEventId: "evt_fail" }),
    ];
    mockWhere
      .mockResolvedValueOnce(alerts)
      .mockResolvedValue([]);
    mockSendBillingAlertSlackNotification
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: "channel_not_found" });

    const result = await replayFailedSlackAlerts();
    expect(result).toEqual({ replayed: 1, failed: 1, skipped: 0 });
    // update called twice: once to clear the flag on success, once to refresh
    // the failure timestamp on the still-failing alert.
    expect(mockUpdate).toHaveBeenCalledTimes(2);
    // The successful path clears the flag to null.
    expect(mockSet).toHaveBeenCalledWith({ slackPostFailed: null });
    // The failure path writes a fresh Date (not null) so the operator can see
    // when the most recent retry occurred.
    const failureSetCall = vi.mocked(mockSet).mock.calls.find(
      ([arg]) => arg && (arg as Record<string, unknown>).slackPostFailed instanceof Date,
    );
    expect(failureSetCall).toBeDefined();
  });

  it("tolerates SDK errors during replay without throwing", async () => {
    setPlatformAdmin();
    const alert = makeAlert();
    mockWhere.mockResolvedValueOnce([alert]);
    mockSendBillingAlertSlackNotification.mockRejectedValueOnce(
      new Error("connector not configured"),
    );

    const result = await replayFailedSlackAlerts();
    expect(result).toEqual({ replayed: 0, failed: 1, skipped: 0 });
  });
});

describe("replayFailedSlackAlerts — Slack not configured", () => {
  it("counts all alerts as skipped when no Slack channel is configured", async () => {
    setPlatformAdmin();
    const alerts = [
      makeAlert({ id: "a1" }),
      makeAlert({ id: "a2" }),
      makeAlert({ id: "a3" }),
    ];
    mockWhere.mockResolvedValueOnce(alerts);
    // No channel configured for any event type
    mockResolveSlackChannel.mockReturnValue(undefined);

    const result = await replayFailedSlackAlerts();

    expect(result).toEqual({ replayed: 0, failed: 0, skipped: 3 });
    // Slack must never be called — no channel to post to
    expect(mockSendBillingAlertSlackNotification).not.toHaveBeenCalled();
    // DB flag must not be cleared — alert is preserved for when a channel is set
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("skips alerts for unconfigured event types but still replays alerts with a configured channel", async () => {
    setPlatformAdmin();
    const alerts = [
      makeAlert({ id: "no-ch", eventType: "invoice.payment_failed" }),
      makeAlert({ id: "has-ch", eventType: "customer.subscription.updated" }),
    ];
    mockWhere
      .mockResolvedValueOnce(alerts) // SELECT
      .mockResolvedValue([]); // UPDATE
    // Only the subscription event type has a channel
    mockResolveSlackChannel.mockImplementation((eventType: string) =>
      eventType === "customer.subscription.updated" ? "#billing-alerts" : undefined,
    );
    mockSendBillingAlertSlackNotification.mockResolvedValue({ ok: true });

    const result = await replayFailedSlackAlerts();

    expect(result).toEqual({ replayed: 1, failed: 0, skipped: 1 });
    expect(mockSendBillingAlertSlackNotification).toHaveBeenCalledTimes(1);
    expect(mockSendBillingAlertSlackNotification).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "customer.subscription.updated" }),
    );
  });
});

describe("replayFailedSlackAlerts — DB flag-clear failure tolerated", () => {
  it("still counts as replayed when the DB update throws after a successful Slack post", async () => {
    setPlatformAdmin();
    const alert = makeAlert();
    mockWhere
      .mockResolvedValueOnce([alert]) // SELECT
      .mockRejectedValueOnce(new Error("DB connection lost")); // UPDATE

    mockSendBillingAlertSlackNotification.mockResolvedValue({ ok: true });

    // Should not throw
    const result = await replayFailedSlackAlerts();
    // The message was delivered; we still count it as replayed
    expect(result.replayed).toBe(1);
    expect(result.failed).toBe(0);
  });
});
