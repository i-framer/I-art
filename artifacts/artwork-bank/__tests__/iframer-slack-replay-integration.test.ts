/**
 * replayFailedIframerSlackAlerts — real-DB integration.
 *
 * Unit tests (slack-replay.test.ts) mock the DB.  This integration suite
 * verifies the DB persistence invariants against real PostgreSQL:
 *
 *  1. Success path: clears BOTH iframerSlackPostFailed and
 *     iframerSlackFailedPayload; returns replayed >= 1.
 *  2. Failure path (Slack returns ok:false): both fields remain non-null;
 *     returns failed >= 1.
 *  3. Tenant with no payload (null iframerSlackFailedPayload) is skipped —
 *     DB is unchanged and skipped is incremented.
 *  4. Tenant whose iframerSlackPostFailed is null is ignored entirely.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Platform admin guard — bypass ─────────────────────────────────────────────
vi.mock("@/lib/platform-admin", () => ({
  requirePlatformAdmin: vi.fn(async () => {}),
}));

// ── Auth ──────────────────────────────────────────────────────────────────────
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({
    userId: "platform-admin",
    email: "admin@platform.test",
  })),
}));

// ── Slack — controlled per-test ───────────────────────────────────────────────
// The action imports sendIframerAccountSlackNotification (not sendIframerAccountSlackNotificationMock).
const sendIframerAccountSlackNotificationMock = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true })),
);
vi.mock("@/lib/slack", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/slack")>();
  return {
    ...actual,
    resolveSlackChannel: vi.fn(() => "#test-iframer-alerts"),
    sendIframerAccountSlackNotification: (...a: unknown[]) =>
      sendIframerAccountSlackNotificationMock(...(a as Parameters<typeof sendIframerAccountSlackNotificationMock>)),
    sendBillingAlertSlackNotification: vi.fn(async () => ({ ok: true })),
    sendRefundDbFailureSlackNotification: vi.fn(async () => {}),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// Ensure SLACK_BILLING_ALERTS_CHANNEL is set so replay is not skipped due to missing channel.
process.env.SLACK_BILLING_ALERTS_CHANNEL = "#test-iframer-alerts";

import { replayFailedIframerSlackAlerts } from "@/app/platform/actions";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];

function uid() { return `${randomUUID()}-ifr-${RUN}-${++seq}`; }

const VALID_PAYLOAD = JSON.stringify({
  action: "linked",
  accountId: "ifrm-acct-test-123",
  adminEmail: "admin@platform.test",
});

async function createTenant(opts: {
  iframerSlackPostFailed?: Date | null;
  iframerSlackFailedPayload?: string | null;
} = {}) {
  const id = uid();
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "iFramer Replay Test Gallery",
    type: "ARTIST",
    iframerSlackPostFailed: opts.iframerSlackPostFailed ?? null,
    iframerSlackFailedPayload: opts.iframerSlackFailedPayload ?? null,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function cleanup() {
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(async () => {
  sendIframerAccountSlackNotificationMock.mockClear();
  await cleanup();
});
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("replayFailedIframerSlackAlerts — real-DB integration", () => {
  it("success path: clears both iframerSlackPostFailed and iframerSlackFailedPayload", async () => {
    const tenantId = await createTenant({
      iframerSlackPostFailed: new Date(Date.now() - 60000),
      iframerSlackFailedPayload: VALID_PAYLOAD,
    });

    sendIframerAccountSlackNotificationMock.mockResolvedValueOnce({ ok: true });

    const result = await replayFailedIframerSlackAlerts();

    expect(result.replayed).toBeGreaterThanOrEqual(1);

    const row = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, tenantId),
    });
    expect(row?.iframerSlackPostFailed).toBeNull();
    expect(row?.iframerSlackFailedPayload).toBeNull();
  });

  it("failure path (Slack ok:false): both fields remain non-null; failed incremented", async () => {
    const failedAt = new Date(Date.now() - 60000);
    const tenantId = await createTenant({
      iframerSlackPostFailed: failedAt,
      iframerSlackFailedPayload: VALID_PAYLOAD,
    });

    sendIframerAccountSlackNotificationMock.mockResolvedValueOnce({ ok: false });

    const result = await replayFailedIframerSlackAlerts();

    expect(result.failed).toBeGreaterThanOrEqual(1);

    const row = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, tenantId),
    });
    expect(row?.iframerSlackPostFailed).not.toBeNull();
    expect(row?.iframerSlackFailedPayload).not.toBeNull();
  });

  it("null payload: tenant is skipped without Slack call; fields unchanged", async () => {
    const failedAt = new Date(Date.now() - 60000);
    const tenantId = await createTenant({
      iframerSlackPostFailed: failedAt,
      iframerSlackFailedPayload: null,
    });

    const result = await replayFailedIframerSlackAlerts();

    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(sendIframerAccountSlackNotificationMock).not.toHaveBeenCalled();

    const row = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, tenantId),
    });
    expect(row?.iframerSlackPostFailed).not.toBeNull();
  });

  it("tenant with null iframerSlackPostFailed is not selected for replay", async () => {
    await createTenant({
      iframerSlackPostFailed: null,
      iframerSlackFailedPayload: null,
    });

    const _result = await replayFailedIframerSlackAlerts();

    // The tenant should not contribute to replayed/failed counts.
    expect(sendIframerAccountSlackNotificationMock).not.toHaveBeenCalled();
    // Result may have counts from other suites if running in parallel, so
    // just assert the call was not made for our tenant.
  });
});
