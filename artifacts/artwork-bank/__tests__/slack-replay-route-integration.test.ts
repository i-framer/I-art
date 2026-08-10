/**
 * Slack replay route — auth + DB action — real-DB integration.
 *
 * app/api/slack-replay/route.ts:
 *   POST (and GET) /api/slack-replay
 *   Auth: requires Bearer {SLACK_REPLAY_SECRET} or {CRON_SECRET} when set.
 *   When neither is configured → open (returns 200).
 *   Success: replays pending stripe alerts, returns { replayed, failed, skipped }.
 *
 *  1. Wrong Bearer token → 401 when SLACK_REPLAY_SECRET is set.
 *  2. Correct Bearer SLACK_REPLAY_SECRET → 200.
 *  3. No auth header when no secret configured → 200 (open endpoint).
 *  4. Replay with pending alert → slackPostFailed cleared on success.
 *  5. Replay with no pending alerts → { replayed: 0, failed: 0, skipped: 0 }.
 *  6. Dismissed alert is not replayed (dismissedAt IS NOT NULL skips it).
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, stripeAlertsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdAlertIds: string[] = [];

function uid() { return `${randomUUID()}-srri-${RUN}-${++seq}`; }

vi.mock("@/lib/slack", () => ({
  resolveSlackChannel: vi.fn(() => "#billing-alerts"),
  sendBillingAlertSlackNotification: vi.fn(async () => ({ ok: true })),
  postToSlack: vi.fn(async () => {}),
}));

import { POST as slackReplayPOST } from "@/app/api/slack-replay/route";
import { sendBillingAlertSlackNotification } from "@/lib/slack";
const mockSlackPost = vi.mocked(sendBillingAlertSlackNotification);

function post(authHeader?: string) {
  const headers: Record<string, string> = {};
  if (authHeader) headers["authorization"] = authHeader;
  return slackReplayPOST(new Request("http://localhost/api/slack-replay", {
    method: "POST",
    headers,
  }));
}

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Slack Replay Test", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createPendingAlert(tenantId: string, opts: { dismissed?: boolean } = {}) {
  const id = uid();
  await db.insert(stripeAlertsTable).values({
    id, tenantId,
    reason: "Test billing alert",
    eventType: "invoice.payment_failed",
    stripeEventId: `evt_${uid()}`,
    slackPostFailed: new Date(), // has a failure
    ...(opts.dismissed ? { dismissedAt: new Date() } : {}),
  } as any);
  createdAlertIds.push(id);
  return id;
}

async function getAlert(id: string) {
  return db.query.stripeAlertsTable.findFirst({ where: eq(stripeAlertsTable.id, id) });
}

async function cleanup() {
  for (const id of createdAlertIds.splice(0)) {
    await db.delete(stripeAlertsTable).where(eq(stripeAlertsTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
  delete process.env.SLACK_REPLAY_SECRET;
  delete process.env.CRON_SECRET;
}

afterEach(async () => { mockSlackPost.mockClear(); await cleanup(); });
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Slack replay route auth + DB action — real-DB integration", () => {
  it("wrong Bearer token → 401 when SLACK_REPLAY_SECRET is set", async () => {
    process.env.SLACK_REPLAY_SECRET = "correct-secret";

    const res = await post("Bearer wrong-secret");

    expect(res.status).toBe(401);
  });

  it("correct Bearer SLACK_REPLAY_SECRET → 200", async () => {
    process.env.SLACK_REPLAY_SECRET = "my-test-secret";

    const res = await post("Bearer my-test-secret");

    expect(res.status).toBe(200);
  });

  it("no auth header when no secret configured → 200 (open endpoint)", async () => {
    delete process.env.SLACK_REPLAY_SECRET;
    delete process.env.CRON_SECRET;

    const res = await post(); // no auth

    expect(res.status).toBe(200);
  });

  it("replay with pending alert → slackPostFailed cleared on Slack success", async () => {
    delete process.env.SLACK_REPLAY_SECRET;
    const tenantId = await createTenant();
    const alertId  = await createPendingAlert(tenantId);
    mockSlackPost.mockResolvedValue({ ok: true });

    await post();

    const row = await getAlert(alertId);
    expect(row?.slackPostFailed).toBeNull();
  });

  it("replay with no pending alerts → { replayed: 0, failed: 0, skipped: 0 }", async () => {
    delete process.env.SLACK_REPLAY_SECRET;
    // Ensure no pending alerts exist by not creating any.

    const res = await post();
    const body = await res.json();

    expect(body.replayed).toBe(0);
    expect(body.failed).toBe(0);
    expect(body.skipped).toBe(0);
  });

  it("dismissed alert is not replayed (dismissedAt IS NOT NULL skips it)", async () => {
    delete process.env.SLACK_REPLAY_SECRET;
    const tenantId = await createTenant();
    const alertId  = await createPendingAlert(tenantId, { dismissed: true });

    await post();

    // slackPostFailed should remain (not cleared) since the alert was skipped.
    const row = await getAlert(alertId);
    expect(row?.slackPostFailed).not.toBeNull();
    expect(mockSlackPost).not.toHaveBeenCalled();
  });
});
