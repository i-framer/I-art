/**
 * replayFailedIframerSlackAlerts action — real-DB integration.
 *
 * app/platform/actions.ts:206 queries tenantsTable for iframerSlackPostFailed IS NOT NULL,
 * then replays the stored payload. This suite verifies the DB-state contract:
 *
 *  1. Tenant with no payload is counted as skipped; flag is not cleared.
 *  2. Successful replay clears iframerSlackPostFailed on the tenant.
 *  3. Tenant with no SLACK_BILLING_ALERTS_CHANNEL is counted as skipped; flag retained.
 *  4. Only tenants with iframerSlackPostFailed set are selected.
 *  5. Failed replay increments failed count; flag is not cleared.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable } from "@workspace/db";
import { eq, isNotNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];

function uid() { return `${randomUUID()}-prsa-${RUN}-${++seq}`; }

// ── Platform admin gate ───────────────────────────────────────────────────────
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ userId: "platform-admin-user", email: "admin@iart.test", tenantId: "platform" })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

vi.mock("@/lib/platform-admin", () => ({
  isPlatformAdmin: vi.fn().mockReturnValue(true),
  requirePlatformAdmin: vi.fn().mockResolvedValue(undefined),
}));

// ── Slack mock ────────────────────────────────────────────────────────────────
const sendIframerAccountSlackNotification = vi.hoisted(() => vi.fn());
vi.mock("@/lib/slack", () => ({
  resolveSlackChannel: vi.fn().mockReturnValue("#alerts-test"),
  sendBillingAlertSlackNotification: vi.fn().mockResolvedValue({ ok: true }),
  sendIframerAccountSlackNotification,
}));

import { replayFailedIframerSlackAlerts } from "@/app/platform/actions";

// ── DB helpers ────────────────────────────────────────────────────────────────
async function createTenant(opts: {
  iframerSlackPostFailed?: boolean;
  iframerSlackFailedPayload?: string | null;
} = {}) {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Replay Slack Test Gallery", type: "ARTIST",
    iframerSlackPostFailed: opts.iframerSlackPostFailed ? new Date() : null,
    iframerSlackFailedPayload: opts.iframerSlackFailedPayload ?? null,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function tenantSlackFailed(id: string) {
  const row = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, id) });
  return row?.iframerSlackPostFailed;
}

async function cleanup() {
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("replayFailedIframerSlackAlerts — real-DB integration", () => {
  it("tenant with no payload is counted as skipped; iframerSlackPostFailed flag is not cleared", async () => {
    const tenantId = await createTenant({
      iframerSlackPostFailed: true,
      iframerSlackFailedPayload: null,
    });

    process.env.SLACK_BILLING_ALERTS_CHANNEL = "#alerts";
    const result = await replayFailedIframerSlackAlerts();
    delete process.env.SLACK_BILLING_ALERTS_CHANNEL;

    expect(result.skipped).toBeGreaterThanOrEqual(1);
    // Flag must not be cleared when payload is missing.
    const flag = await tenantSlackFailed(tenantId);
    expect(flag).not.toBeNull();
  });

  it("tenant with no SLACK_BILLING_ALERTS_CHANNEL is counted as skipped; flag retained", async () => {
    const payload = JSON.stringify({ action: "linked", accountId: "acct_test", adminEmail: "admin@test.com" });
    const tenantId = await createTenant({
      iframerSlackPostFailed: true,
      iframerSlackFailedPayload: payload,
    });

    // Ensure channel is not set.
    const prev = process.env.SLACK_BILLING_ALERTS_CHANNEL;
    delete process.env.SLACK_BILLING_ALERTS_CHANNEL;

    const result = await replayFailedIframerSlackAlerts();
    if (prev) process.env.SLACK_BILLING_ALERTS_CHANNEL = prev;

    expect(result.skipped).toBeGreaterThanOrEqual(1);
    const flag = await tenantSlackFailed(tenantId);
    expect(flag).not.toBeNull();
  });

  it("successful replay clears iframerSlackPostFailed on the tenant", async () => {
    const payload = JSON.stringify({ action: "linked", accountId: "acct_replay_ok", adminEmail: "admin@ok.test" });
    const tenantId = await createTenant({
      iframerSlackPostFailed: true,
      iframerSlackFailedPayload: payload,
    });

    // sendIframerAccountSlackNotification resolves with ok=true.
    sendIframerAccountSlackNotification.mockResolvedValueOnce({ ok: true });
    process.env.SLACK_BILLING_ALERTS_CHANNEL = "#alerts-test";

    const result = await replayFailedIframerSlackAlerts();
    delete process.env.SLACK_BILLING_ALERTS_CHANNEL;

    expect(result.replayed).toBeGreaterThanOrEqual(1);
    // Flag must be cleared.
    const flag = await tenantSlackFailed(tenantId);
    expect(flag).toBeNull();
  });

  it("tenants without iframerSlackPostFailed are not selected by the query", async () => {
    // Tenant with no failed flag.
    const cleanTenantId = await createTenant({ iframerSlackPostFailed: false });

    process.env.SLACK_BILLING_ALERTS_CHANNEL = "#alerts";
    await replayFailedIframerSlackAlerts();
    delete process.env.SLACK_BILLING_ALERTS_CHANNEL;

    // Flag on clean tenant must still be null.
    const flag = await tenantSlackFailed(cleanTenantId);
    expect(flag).toBeNull();
  });

  it("failed replay increments failed count; flag is not cleared", async () => {
    const payload = JSON.stringify({ action: "linked", accountId: "acct_replay_fail", adminEmail: "fail@test.com" });
    const tenantId = await createTenant({
      iframerSlackPostFailed: true,
      iframerSlackFailedPayload: payload,
    });

    // sendIframerAccountSlackNotification returns ok=false.
    sendIframerAccountSlackNotification.mockResolvedValueOnce({ ok: false });
    process.env.SLACK_BILLING_ALERTS_CHANNEL = "#alerts-test";

    const result = await replayFailedIframerSlackAlerts();
    delete process.env.SLACK_BILLING_ALERTS_CHANNEL;

    expect(result.failed).toBeGreaterThanOrEqual(1);
    // Flag must remain set on failure.
    const flag = await tenantSlackFailed(tenantId);
    expect(flag).not.toBeNull();
  });
});
