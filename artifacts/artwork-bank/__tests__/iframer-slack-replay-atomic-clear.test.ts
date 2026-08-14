/**
 * Atomic-clear unit test: verifies that the success path in
 * replayFailedIframerSlackAlerts issues exactly ONE db.update() call and that
 * the single .set() includes BOTH iframerSlackPostFailed: null AND
 * iframerSlackFailedPayload: null together.
 *
 * A regression that split the clear into two sequential updates — clearing
 * the timestamp first and the payload second — would fail the
 * "updateCallCount === 1" assertion, exposing a window where stale payload
 * data would be visible in the DB between the two writes.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Fake DB ───────────────────────────────────────────────────────────────────
// Captures every .set() argument issued through db.update().
const state = vi.hoisted(() => ({
  selectResult: [] as any[],
  updateSetValues: [] as any[],
  updateCallCount: 0,
}));

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({
        where: () => Promise.resolve(state.selectResult),
      }),
    })),
    update: vi.fn(() => {
      state.updateCallCount++;
      return {
        set: (vals: any) => {
          state.updateSetValues.push({ ...vals });
          return { where: () => Promise.resolve() };
        },
      };
    }),
  },
  tenantsTable: {
    id: "tenants.id",
    iframerSlackPostFailed: "tenants.iframerSlackPostFailed",
  },
}));

// Stub drizzle operators so where-clauses don't need real column refs.
vi.mock("drizzle-orm", () => ({
  isNotNull: (col: any) => ({ op: "isNotNull", col }),
  isNull: (col: any) => ({ op: "isNull", col }),
  eq: (a: any, b: any) => ({ op: "eq", a, b }),
  and: (...args: any[]) => ({ op: "and", args }),
  inArray: (a: any, b: any) => ({ op: "inArray", a, b }),
}));

// ── Platform admin / auth ─────────────────────────────────────────────────────
vi.mock("@/lib/platform-admin", () => ({
  requirePlatformAdmin: vi.fn(async () => {}),
}));

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({
    userId: "platform-admin",
    email: "admin@platform.test",
  })),
}));

// ── Slack ─────────────────────────────────────────────────────────────────────
vi.mock("@/lib/slack", () => ({
  resolveSlackChannel: vi.fn(() => "#billing-alerts"),
  sendIframerAccountSlackNotification: vi.fn(async () => ({ ok: true as const })),
  sendBillingAlertSlackNotification: vi.fn(async () => ({ ok: true as const })),
  sendRefundDbFailureSlackNotification: vi.fn(async () => {}),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

process.env.SLACK_BILLING_ALERTS_CHANNEL = "#billing-alerts";

import { replayFailedIframerSlackAlerts } from "@/app/platform/actions";

const VALID_PAYLOAD = JSON.stringify({
  action: "linked",
  accountId: "acct_test",
  adminEmail: "admin@test.example",
});

describe("replayFailedIframerSlackAlerts — atomic-clear unit", () => {
  beforeEach(() => {
    state.selectResult = [];
    state.updateSetValues = [];
    state.updateCallCount = 0;
    vi.clearAllMocks();
  });

  it("issues exactly one db.update containing both null columns on success", async () => {
    state.selectResult = [
      {
        id: "tenant-abc",
        slug: "tenant-abc",
        businessName: "Test Gallery",
        iframerSlackPostFailed: new Date(Date.now() - 60_000),
        iframerSlackFailedPayload: VALID_PAYLOAD,
      },
    ];

    const result = await replayFailedIframerSlackAlerts();

    expect(result.replayed).toBe(1);
    expect(result.failed).toBe(0);

    // One and only one db.update call — a split would produce two.
    expect(state.updateCallCount).toBe(1);

    // The single .set() must clear BOTH columns together, not one at a time.
    expect(state.updateSetValues).toHaveLength(1);
    expect(state.updateSetValues[0]).toEqual({
      iframerSlackPostFailed: null,
      iframerSlackFailedPayload: null,
    });
  });

  it("does not include iframerSlackFailedPayload in the ok:false update (payload preserved for retry)", async () => {
    // Slack returns ok:false — only the timestamp is refreshed, not the payload.
    const { sendIframerAccountSlackNotification } = await import("@/lib/slack");
    vi.mocked(sendIframerAccountSlackNotification).mockResolvedValueOnce({
      ok: false as const,
      error: "Slack API returned non-ok",
    });

    state.selectResult = [
      {
        id: "tenant-xyz",
        slug: "tenant-xyz",
        businessName: "Test Gallery",
        iframerSlackPostFailed: new Date(Date.now() - 60_000),
        iframerSlackFailedPayload: VALID_PAYLOAD,
      },
    ];

    const result = await replayFailedIframerSlackAlerts();

    expect(result.failed).toBe(1);
    expect(result.replayed).toBe(0);

    // One update (refreshing the timestamp only).
    expect(state.updateCallCount).toBe(1);
    expect(state.updateSetValues).toHaveLength(1);

    // The payload column must NOT appear in the set — it should stay untouched.
    expect(state.updateSetValues[0]).not.toHaveProperty(
      "iframerSlackFailedPayload",
    );
    // The timestamp must be a fresh Date, not null.
    expect(state.updateSetValues[0].iframerSlackPostFailed).toBeInstanceOf(Date);
  });

  it("issues zero db.update calls when Slack throws (exception path — no write)", async () => {
    const { sendIframerAccountSlackNotification } = await import("@/lib/slack");
    vi.mocked(sendIframerAccountSlackNotification).mockRejectedValueOnce(
      new Error("ETIMEDOUT"),
    );

    state.selectResult = [
      {
        id: "tenant-throw",
        slug: "tenant-throw",
        businessName: "Test Gallery",
        iframerSlackPostFailed: new Date(Date.now() - 60_000),
        iframerSlackFailedPayload: VALID_PAYLOAD,
      },
    ];

    const result = await replayFailedIframerSlackAlerts();

    expect(result.failed).toBe(1);

    // No DB write at all — the exception path must not touch the row.
    expect(state.updateCallCount).toBe(0);
    expect(state.updateSetValues).toHaveLength(0);
  });
});
