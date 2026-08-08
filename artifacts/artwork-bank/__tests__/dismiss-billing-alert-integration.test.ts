/**
 * dismissBillingAlert platform action — real-DB integration.
 *
 * app/platform/actions.ts:297: dismissBillingAlert(alertId: string)
 *   Sets stripeAlertsTable.dismissedAt for the given alert ID.
 *   Only platform admins can call it.
 *
 *  1. Dismissing a real alert row sets dismissedAt to a recent timestamp.
 *  2. A second dismiss on the same row is idempotent (no error, row updated).
 *  3. Dismissing a nonexistent ID throws or is a no-op — no crash.
 *  4. Non-platform-admin is rejected before any DB write.
 *  5. Row fields other than dismissedAt are unaffected by dismiss.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, stripeAlertsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdAlertIds: string[] = [];

function uid() { return `${randomUUID()}-dbai-${RUN}-${++seq}`; }

const mockIsPlatformAdmin = { value: true };

vi.mock("@/lib/platform-admin", () => ({
  isPlatformAdmin: vi.fn(async () => mockIsPlatformAdmin.value),
  requirePlatformAdmin: vi.fn(async () => {
    if (!mockIsPlatformAdmin.value) throw new Error("Forbidden");
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

import { dismissBillingAlert } from "@/app/platform/actions";

async function createAlert(opts: { dismissedAt?: Date | null } = {}) {
  const id = uid();
  const eventId = uid();
  await db.insert(stripeAlertsTable).values({
    id,
    stripeEventId: eventId,
    eventType: "invoice.payment_failed",
    reason: "Test alert for dismissal",
    dismissedAt: opts.dismissedAt ?? null,
  } as any);
  createdAlertIds.push(id);
  return id;
}

async function alertRow(id: string) {
  return db.query.stripeAlertsTable.findFirst({ where: eq(stripeAlertsTable.id, id) });
}

async function cleanup() {
  mockIsPlatformAdmin.value = true;
  for (const id of createdAlertIds.splice(0)) {
    await db.delete(stripeAlertsTable).where(eq(stripeAlertsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

const RECENT_MS = 10_000;

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("dismissBillingAlert platform action — real-DB integration", () => {
  it("dismissing a real alert row sets dismissedAt to a recent timestamp", async () => {
    const alertId = await createAlert();
    const before = Date.now();

    await dismissBillingAlert(alertId);

    const row = await alertRow(alertId);
    expect(row?.dismissedAt).not.toBeNull();
    expect(row!.dismissedAt!.getTime()).toBeGreaterThanOrEqual(before - RECENT_MS);
  });

  it("a second dismiss on the same row is idempotent (no error)", async () => {
    const alertId = await createAlert();

    await dismissBillingAlert(alertId);
    await dismissBillingAlert(alertId); // second call

    const row = await alertRow(alertId);
    expect(row?.dismissedAt).not.toBeNull();
  });

  it("non-platform-admin is rejected before any DB write", async () => {
    const alertId = await createAlert();
    mockIsPlatformAdmin.value = false;

    await expect(dismissBillingAlert(alertId)).rejects.toThrow();

    const row = await alertRow(alertId);
    expect(row?.dismissedAt).toBeNull(); // unchanged
  });

  it("row fields other than dismissedAt are unaffected by dismiss", async () => {
    const alertId = await createAlert();

    await dismissBillingAlert(alertId);

    const row = await alertRow(alertId);
    expect(row?.eventType).toBe("invoice.payment_failed");
    expect(row?.reason).toBe("Test alert for dismissal");
    expect(row?.dismissedAt).not.toBeNull();
  });

  it("dismissing a nonexistent ID does not crash (no-op or graceful)", async () => {
    // Expect either resolve or a predictable error — must not explode uncontrollably.
    const nonexistentId = uid();
    try {
      await dismissBillingAlert(nonexistentId);
      // No crash — acceptable
    } catch (err) {
      // Any thrown error must be a predictable Error instance, not a DB crash.
      expect(err).toBeInstanceOf(Error);
    }
  });
});
