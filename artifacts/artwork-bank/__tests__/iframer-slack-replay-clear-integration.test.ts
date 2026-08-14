/**
 * replayFailedIframerSlackAlerts — real-DB integration.
 *
 * Verifies that after a full-success replay, ALL tenantsTable rows that
 * previously had iframerSlackPostFailed set are cleared to null (and
 * iframerSlackFailedPayload is also cleared).  This proves the server
 * action's UPDATE path commits correctly against a real PostgreSQL database,
 * so a regression in the clearing logic would be caught here rather than
 * slipping past unit tests that mock the DB.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
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

// ── Slack — always succeeds unless overridden ──────────────────────────────────
const sendIframerAccountSlackNotificationMock = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true })),
);
vi.mock("@/lib/slack", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/slack")>();
  return {
    ...actual,
    resolveSlackChannel: vi.fn(() => "#test-billing-alerts"),
    sendIframerAccountSlackNotification: (
      ...a: unknown[]
    ) =>
      sendIframerAccountSlackNotificationMock(
        ...(a as Parameters<typeof sendIframerAccountSlackNotificationMock>),
      ),
    sendBillingAlertSlackNotification: vi.fn(async () => ({ ok: true })),
    sendRefundDbFailureSlackNotification: vi.fn(async () => {}),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// Ensure the channel env var is present so the action doesn't skip all rows.
process.env.SLACK_BILLING_ALERTS_CHANNEL = "#test-billing-alerts";

import { replayFailedIframerSlackAlerts } from "@/app/platform/actions";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];

function uid() {
  return `${randomUUID()}-ifrc-${RUN}-${++seq}`;
}

/** Minimal valid payload the action will parse and forward to Slack. */
function makePayload(
  action: "linked" | "unlinked" = "linked",
): string {
  return JSON.stringify({ action, accountId: "acct_test", adminEmail: "admin@test.example" });
}

async function createTenant(opts: {
  iframerSlackPostFailed?: Date | null;
  iframerSlackFailedPayload?: string | null;
}) {
  const id = uid();
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "iFramer Slack Replay Test",
    type: "ARTIST",
    iframerSlackPostFailed: opts.iframerSlackPostFailed ?? null,
    iframerSlackFailedPayload: opts.iframerSlackFailedPayload ?? null,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function cleanup() {
  const ids = createdTenantIds.splice(0);
  if (ids.length) {
    await db
      .delete(tenantsTable)
      .where(inArray(tenantsTable.id, ids))
      .catch(() => {});
  }
}

afterEach(async () => {
  sendIframerAccountSlackNotificationMock.mockClear();
  await cleanup();
});
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration(
  "replayFailedIframerSlackAlerts — real-DB integration",
  () => {
    it(
      "full-success replay: all seeded iframerSlackPostFailed rows are cleared to null",
      async () => {
        // Seed several tenants with failure timestamps spread across the past.
        const tenantIds = await Promise.all([
          createTenant({
            iframerSlackPostFailed: new Date(Date.now() - 120_000),
            iframerSlackFailedPayload: makePayload("linked"),
          }),
          createTenant({
            iframerSlackPostFailed: new Date(Date.now() - 60_000),
            iframerSlackFailedPayload: makePayload("unlinked"),
          }),
          createTenant({
            iframerSlackPostFailed: new Date(Date.now() - 30_000),
            iframerSlackFailedPayload: makePayload("linked"),
          }),
        ]);

        // All Slack calls succeed (default mock returns { ok: true }).
        const result = await replayFailedIframerSlackAlerts();

        // At least the three rows we seeded should have been replayed.
        expect(result.replayed).toBeGreaterThanOrEqual(tenantIds.length);
        expect(result.failed).toBe(0);

        // Re-query every seeded row and assert both columns are cleared.
        const rows = await db.query.tenantsTable.findMany({
          where: (t, { inArray: inArr }) => inArr(t.id, tenantIds),
        });

        expect(rows).toHaveLength(tenantIds.length);
        for (const row of rows) {
          expect(row.iframerSlackPostFailed).toBeNull();
          expect(row.iframerSlackFailedPayload).toBeNull();
        }
      },
    );

    it(
      "failure path (Slack ok:false): iframerSlackPostFailed remains non-null; failed incremented",
      async () => {
        const tenantId = await createTenant({
          iframerSlackPostFailed: new Date(Date.now() - 60_000),
          iframerSlackFailedPayload: makePayload("linked"),
        });

        sendIframerAccountSlackNotificationMock.mockResolvedValueOnce({
          ok: false,
        });

        const result = await replayFailedIframerSlackAlerts();

        expect(result.failed).toBeGreaterThanOrEqual(1);

        const row = await db.query.tenantsTable.findFirst({
          where: eq(tenantsTable.id, tenantId),
        });
        expect(row?.iframerSlackPostFailed).not.toBeNull();
      },
    );

    it(
      "failure path (Slack ok:false): iframerSlackPostFailed is refreshed to the current time",
      async () => {
        // Seed a tenant with a failure timestamp well in the past.
        const pastDate = new Date(Date.now() - 5 * 60_000); // 5 minutes ago
        const tenantId = await createTenant({
          iframerSlackPostFailed: pastDate,
          iframerSlackFailedPayload: makePayload("linked"),
        });

        sendIframerAccountSlackNotificationMock.mockResolvedValueOnce({
          ok: false,
        });

        const sweepStartedAt = new Date();
        const result = await replayFailedIframerSlackAlerts();

        expect(result.failed).toBeGreaterThanOrEqual(1);

        const row = await db.query.tenantsTable.findFirst({
          where: eq(tenantsTable.id, tenantId),
        });

        // The timestamp must be non-null (still failing)...
        expect(row?.iframerSlackPostFailed).not.toBeNull();

        // ...AND it must have been refreshed to at or after the sweep start,
        // proving the action wrote a new value rather than leaving the stale one.
        expect(row!.iframerSlackPostFailed!.getTime()).toBeGreaterThanOrEqual(
          sweepStartedAt.getTime(),
        );
      },
    );

    it(
      "failure path (Slack ok:false): iframerSlackFailedPayload is left intact for the next retry",
      async () => {
        const originalPayload = makePayload("linked");
        const tenantId = await createTenant({
          iframerSlackPostFailed: new Date(Date.now() - 60_000),
          iframerSlackFailedPayload: originalPayload,
        });

        sendIframerAccountSlackNotificationMock.mockResolvedValueOnce({
          ok: false,
        });

        const result = await replayFailedIframerSlackAlerts();

        expect(result.failed).toBeGreaterThanOrEqual(1);

        const row = await db.query.tenantsTable.findFirst({
          where: eq(tenantsTable.id, tenantId),
        });

        // The payload must still equal the original seeded value so the next
        // retry attempt can forward it to Slack.
        expect(row?.iframerSlackFailedPayload).toBe(originalPayload);
      },
    );

    it(
      "exception path (Slack throws): iframerSlackFailedPayload is left intact for the next retry",
      async () => {
        const originalPayload = makePayload("linked");
        const tenantId = await createTenant({
          iframerSlackPostFailed: new Date(Date.now() - 60_000),
          iframerSlackFailedPayload: originalPayload,
        });

        // Simulate the Slack SDK throwing entirely rather than returning ok:false.
        sendIframerAccountSlackNotificationMock.mockRejectedValueOnce(
          new Error("ETIMEDOUT: Slack SDK network error"),
        );

        const result = await replayFailedIframerSlackAlerts();

        expect(result.failed).toBeGreaterThanOrEqual(1);

        const row = await db.query.tenantsTable.findFirst({
          where: eq(tenantsTable.id, tenantId),
        });

        // The payload must still equal the original seeded value so the next
        // retry attempt can forward it to Slack.
        expect(row?.iframerSlackFailedPayload).toBe(originalPayload);
      },
    );

    it(
      "exception path (Slack throws): iframerSlackPostFailed is left at the original seeded timestamp",
      async () => {
        // Seed with a known past timestamp so we can compare exactly.
        const originalFailedAt = new Date(Date.now() - 60_000);
        const tenantId = await createTenant({
          iframerSlackPostFailed: originalFailedAt,
          iframerSlackFailedPayload: makePayload("linked"),
        });

        // Simulate the Slack SDK throwing entirely rather than returning ok:false.
        sendIframerAccountSlackNotificationMock.mockRejectedValueOnce(
          new Error("ETIMEDOUT: Slack SDK network error"),
        );

        const result = await replayFailedIframerSlackAlerts();

        expect(result.failed).toBeGreaterThanOrEqual(1);

        const row = await db.query.tenantsTable.findFirst({
          where: eq(tenantsTable.id, tenantId),
        });

        // The timestamp must not be null — the failure flag must still be set.
        expect(row?.iframerSlackPostFailed).not.toBeNull();

        // The timestamp must equal the original seeded value — it must not be
        // reset to null or refreshed to a newer date when an exception is thrown,
        // because the original timestamp is the most accurate signal to operators
        // that the alert has been stuck since before the latest sweep.
        expect(row!.iframerSlackPostFailed!.getTime()).toBe(
          originalFailedAt.getTime(),
        );
      },
    );

    it(
      "exception path (mixed sweep): throwing tenant keeps original timestamp while successful tenant is cleared",
      async () => {
        // Seed a tenant whose Slack call will throw (exception path).
        // createTenant sets slug === id, so we know the slug before querying.
        const originalFailedAt = new Date(Date.now() - 90_000);
        const throwingTenantId = await createTenant({
          iframerSlackPostFailed: originalFailedAt,
          iframerSlackFailedPayload: makePayload("linked"),
        });
        const throwingSlug = throwingTenantId; // slug === id by convention in createTenant

        // Seed a second tenant whose Slack call will succeed.
        const successTenantId = await createTenant({
          iframerSlackPostFailed: new Date(Date.now() - 45_000),
          iframerSlackFailedPayload: makePayload("unlinked"),
        });

        // Route by tenantSlug so the result is independent of SQL row order and
        // unaffected by any other pending rows already in the integration DB.
        // Use rest-args to satisfy the 0-arg inferred mock type while still
        // inspecting the tenantSlug the action passes.
        sendIframerAccountSlackNotificationMock.mockImplementation(
          async (...args: unknown[]) => {
            const { tenantSlug } = args[0] as { tenantSlug: string };
            if (tenantSlug === throwingSlug) {
              throw new Error("ETIMEDOUT: Slack SDK network error");
            }
            return { ok: true as const };
          },
        );

        const result = await replayFailedIframerSlackAlerts();

        // At least one succeeded and at least one failed.
        expect(result.replayed).toBeGreaterThanOrEqual(1);
        expect(result.failed).toBeGreaterThanOrEqual(1);

        // The successful tenant's flags must both be cleared.
        const successRow = await db.query.tenantsTable.findFirst({
          where: eq(tenantsTable.id, successTenantId),
        });
        expect(successRow?.iframerSlackPostFailed).toBeNull();
        expect(successRow?.iframerSlackFailedPayload).toBeNull();

        // The throwing tenant's timestamp must still equal the original seeded value —
        // the successful tenant's commit must not have touched it as a side-effect.
        const throwingRow = await db.query.tenantsTable.findFirst({
          where: eq(tenantsTable.id, throwingTenantId),
        });
        expect(throwingRow?.iframerSlackPostFailed).not.toBeNull();
        expect(throwingRow!.iframerSlackPostFailed!.getTime()).toBe(
          originalFailedAt.getTime(),
        );

        // Restore the default mock implementation so subsequent tests are unaffected.
        sendIframerAccountSlackNotificationMock.mockImplementation(
          async () => ({ ok: true as const }),
        );
      },
    );

    it(
      "exception path (all-throw sweep): iframerSlackPostFailed unchanged for every tenant when all throw",
      async () => {
        // Seed three tenants, each with a distinct known past timestamp.
        const originalFailedAt = [
          new Date(Date.now() - 120_000),
          new Date(Date.now() - 90_000),
          new Date(Date.now() - 60_000),
        ];

        const tenantIds = await Promise.all(
          originalFailedAt.map((ts) =>
            createTenant({
              iframerSlackPostFailed: ts,
              iframerSlackFailedPayload: makePayload("linked"),
            }),
          ),
        );

        // Every Slack call throws — simulate total transport failure.
        sendIframerAccountSlackNotificationMock.mockImplementation(async () => {
          throw new Error("ETIMEDOUT: Slack SDK network error");
        });

        const result = await replayFailedIframerSlackAlerts();

        // No tenant succeeded.
        expect(result.replayed).toBe(0);
        // At least as many failures as tenants seeded.
        expect(result.failed).toBeGreaterThanOrEqual(tenantIds.length);

        // Re-query every seeded row and assert neither column was touched.
        const rows = await db.query.tenantsTable.findMany({
          where: (t, { inArray: inArr }) => inArr(t.id, tenantIds),
        });

        expect(rows).toHaveLength(tenantIds.length);
        for (const row of rows) {
          // Flag must still be set (not cleared).
          expect(row.iframerSlackPostFailed).not.toBeNull();

          // Timestamp must equal the original seeded value — no refresh.
          const idx = tenantIds.indexOf(row.id);
          expect(row.iframerSlackPostFailed!.getTime()).toBe(
            originalFailedAt[idx].getTime(),
          );

          // Payload must also be preserved — the exception path must not clear it.
          expect(row.iframerSlackFailedPayload).toBe(makePayload("linked"));
        }

        // Restore the default mock implementation so subsequent tests are unaffected.
        sendIframerAccountSlackNotificationMock.mockImplementation(
          async () => ({ ok: true as const }),
        );
      },
    );

    it(
      "tenant without a stored payload is counted as skipped, not failed",
      async () => {
        const tenantId = await createTenant({
          iframerSlackPostFailed: new Date(Date.now() - 60_000),
          iframerSlackFailedPayload: null, // no payload → action must skip
        });

        const result = await replayFailedIframerSlackAlerts();

        expect(result.skipped).toBeGreaterThanOrEqual(1);

        // Row must be left untouched — the flag stays set.
        const row = await db.query.tenantsTable.findFirst({
          where: eq(tenantsTable.id, tenantId),
        });
        expect(row?.iframerSlackPostFailed).not.toBeNull();
      },
    );
  },
);
