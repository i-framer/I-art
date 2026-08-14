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
const sendIframerReplayDbFailureSlackNotificationMock = vi.hoisted(() =>
  vi.fn(async (_arg: { tenantId: string }) => ({ ok: true as const })),
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
    sendIframerReplayDbFailureSlackNotification: (
      ...a: unknown[]
    ) =>
      sendIframerReplayDbFailureSlackNotificationMock(
        ...(a as Parameters<typeof sendIframerReplayDbFailureSlackNotificationMock>),
      ),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// ── db.update intercept — lets individual tests force the clear step to throw ──
//
// db is exported as a lazyProxy (Proxy over {}).  vi.spyOn installs the spy on
// the proxy's empty target, but the proxy's get-trap reads from the real drizzle
// instance, so the spy is invisible to the action.
//
// Fix: a module-level vi.mock wraps db in a new Proxy that routes "update"
// through a hoisted vi.fn.  A mutable flag object (also hoisted) controls
// whether the spy forwards to the real drizzle update or throws.  Tests toggle
// the flag; afterEach resets it so no bleed-through occurs.
//
const dbUpdateCtrl = vi.hoisted(() => ({ shouldThrow: false }));
vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  return {
    ...actual,
    // Wrap db in a proxy that intercepts only "update".
    db: new Proxy(actual.db as object, {
      get(target, prop) {
        if (prop === "update") {
          // Return a function that either throws or delegates to the real update.
          return (...args: unknown[]) => {
            if (dbUpdateCtrl.shouldThrow) {
              throw new Error("simulated DB write failure on clear");
            }
            return (actual.db as { update: (...a: unknown[]) => unknown }).update(...args);
          };
        }
        const val = Reflect.get(target, prop);
        return typeof val === "function" ? val.bind(target) : val;
      },
    }) as typeof actual.db,
  };
});

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
  sendIframerReplayDbFailureSlackNotificationMock.mockClear();
  // Safety-net: always reset the throw flag so a failing test can't bleed
  // into the next one.
  dbUpdateCtrl.shouldThrow = false;
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
        // (Atomicity — both columns in one .set() call — is enforced by the
        // unit test in iframer-slack-replay-atomic-clear.test.ts.)
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

        // The throwing tenant's payload must also be preserved — the exception
        // path must not clear or overwrite iframerSlackFailedPayload even when
        // the other tenant's transaction commits successfully.
        expect(throwingRow?.iframerSlackFailedPayload).toBe(
          makePayload("linked"),
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

    it(
      "DB write failure after successful Slack delivery: both columns remain non-null (no silent data loss)",
      async () => {
        // Seed a tenant with both failure columns set.
        const originalPayload = makePayload("linked");
        const originalFailedAt = new Date(Date.now() - 60_000);
        const tenantId = await createTenant({
          iframerSlackPostFailed: originalFailedAt,
          iframerSlackFailedPayload: originalPayload,
        });

        // Slack succeeds (default mock returns { ok: true }).
        // Force ALL db.update calls to throw for the duration of the sweep so
        // the clear step is guaranteed to fail regardless of how many pending
        // rows exist in the integration DB at the time of the run.
        dbUpdateCtrl.shouldThrow = true;
        let result: Awaited<ReturnType<typeof replayFailedIframerSlackAlerts>>;
        try {
          result = await replayFailedIframerSlackAlerts();
        } finally {
          // Always restore so the assertions and afterEach cleanup use the
          // real db.update path.
          dbUpdateCtrl.shouldThrow = false;
        }

        // The action counts a successful Slack delivery even when the DB
        // clear fails — replayed is still incremented because the message
        // was delivered (Slack returned ok: true).
        expect(result!.replayed).toBeGreaterThanOrEqual(1);

        // Re-query the row using the now-restored real db and verify neither
        // column was silently cleared by the failed update.
        const row = await db.query.tenantsTable.findFirst({
          where: eq(tenantsTable.id, tenantId),
        });

        // iframerSlackPostFailed must still be set — the DB write failure
        // must not have partially committed only the timestamp column.
        expect(row?.iframerSlackPostFailed).not.toBeNull();

        // iframerSlackFailedPayload must also still be set — both columns are
        // written in a single .set() call so they either both clear or neither
        // does (the action's try/catch swallows the error and leaves them intact).
        expect(row?.iframerSlackFailedPayload).toBe(originalPayload);
      },
    );

    it(
      "DB update failure after ok:false Slack response: iframerSlackPostFailed retains the original seeded value",
      async () => {
        // Seed a tenant with a known past failure timestamp.
        const originalPayload = makePayload("linked");
        const originalFailedAt = new Date(Date.now() - 60_000);
        const tenantId = await createTenant({
          iframerSlackPostFailed: originalFailedAt,
          iframerSlackFailedPayload: originalPayload,
        });

        // Slack returns ok:false — the refresh-timestamp update path is taken.
        sendIframerAccountSlackNotificationMock.mockResolvedValueOnce({
          ok: false,
        });

        // Force the db.update (refresh step) to throw so the update never lands.
        dbUpdateCtrl.shouldThrow = true;
        let result: Awaited<ReturnType<typeof replayFailedIframerSlackAlerts>>;
        try {
          result = await replayFailedIframerSlackAlerts();
        } finally {
          // Always restore so assertions and afterEach cleanup use the real path.
          dbUpdateCtrl.shouldThrow = false;
        }

        // The action still counted this as a failure.
        expect(result!.failed).toBeGreaterThanOrEqual(1);

        // Re-query using the restored real db.
        const row = await db.query.tenantsTable.findFirst({
          where: eq(tenantsTable.id, tenantId),
        });

        // iframerSlackPostFailed must still be set — the failed DB write must
        // not have partially committed or silently zeroed the column.
        expect(row?.iframerSlackPostFailed).not.toBeNull();

        // The timestamp must equal the original seeded value — the DB write
        // failure means no refresh occurred, so the column is unchanged.
        expect(row!.iframerSlackPostFailed!.getTime()).toBe(
          originalFailedAt.getTime(),
        );

        // The payload must also be untouched — the ok:false path only touches
        // iframerSlackPostFailed, so iframerSlackFailedPayload must survive.
        expect(row?.iframerSlackFailedPayload).toBe(originalPayload);
      },
    );

    it(
      "DB update failure after ok:false Slack response: sendIframerReplayDbFailureSlackNotification is called with the correct tenantId",
      async () => {
        // Seed a tenant so the action has a row to process.
        const originalPayload = makePayload("linked");
        const tenantId = await createTenant({
          iframerSlackPostFailed: new Date(Date.now() - 60_000),
          iframerSlackFailedPayload: originalPayload,
        });

        // Slack returns ok:false — the refresh-timestamp update path is taken.
        sendIframerAccountSlackNotificationMock.mockResolvedValueOnce({
          ok: false,
        });

        // Force db.update to throw so the catch block fires the Slack alert.
        dbUpdateCtrl.shouldThrow = true;
        try {
          await replayFailedIframerSlackAlerts();
        } finally {
          dbUpdateCtrl.shouldThrow = false;
        }

        // The DB-failure Slack helper must have been called at least once
        // for the affected tenant so operators see the stuck retry in Slack.
        expect(
          sendIframerReplayDbFailureSlackNotificationMock,
        ).toHaveBeenCalledWith(
          expect.objectContaining({ tenantId }),
        );
      },
    );

    it(
      "DB update failure for two ok:false tenants: sendIframerReplayDbFailureSlackNotification fires exactly once per tenant with distinct tenantIds",
      async () => {
        // Seed two tenants, each with a stored failure payload.
        const tenantIdA = await createTenant({
          iframerSlackPostFailed: new Date(Date.now() - 120_000),
          iframerSlackFailedPayload: makePayload("linked"),
        });
        const tenantIdB = await createTenant({
          iframerSlackPostFailed: new Date(Date.now() - 60_000),
          iframerSlackFailedPayload: makePayload("unlinked"),
        });

        // Both Slack calls return ok:false (the refresh-timestamp update path is taken).
        sendIframerAccountSlackNotificationMock.mockResolvedValue({
          ok: false,
        });

        // Force db.update to throw for both tenants so the catch block fires
        // sendIframerReplayDbFailureSlackNotification for each one.
        dbUpdateCtrl.shouldThrow = true;
        try {
          await replayFailedIframerSlackAlerts();
        } finally {
          // Always restore so assertions and afterEach cleanup use the real path.
          dbUpdateCtrl.shouldThrow = false;
          // Reset the Slack mock back to the default success implementation.
          sendIframerAccountSlackNotificationMock.mockResolvedValue({
            ok: true as const,
          });
        }

        // The DB-failure Slack helper must have been called exactly once per
        // affected tenant — not zero times (silent failure) and not more than
        // once per tenant (duplicate from a regression in the catch block).
        expect(
          sendIframerReplayDbFailureSlackNotificationMock,
        ).toHaveBeenCalledTimes(2);

        // Each call must reference a distinct tenantId so operators can identify
        // which rows are stuck.
        const calledWithIds = sendIframerReplayDbFailureSlackNotificationMock.mock.calls.map(
          (args) => (args[0] as { tenantId: string }).tenantId,
        );
        expect(calledWithIds).toContain(tenantIdA);
        expect(calledWithIds).toContain(tenantIdB);
        expect(new Set(calledWithIds).size).toBe(2);
      },
    );

    it(
      "DB update failure with mixed tenants: sendIframerReplayDbFailureSlackNotification fires exactly twice even when one tenant's Slack call succeeds",
      async () => {
        // Seed two tenants whose Slack calls will return ok:false — these are the
        // rows where a DB write failure should fire the DB-failure Slack alert.
        const tenantIdA = await createTenant({
          iframerSlackPostFailed: new Date(Date.now() - 120_000),
          iframerSlackFailedPayload: makePayload("linked"),
        });
        const tenantIdB = await createTenant({
          iframerSlackPostFailed: new Date(Date.now() - 60_000),
          iframerSlackFailedPayload: makePayload("unlinked"),
        });

        // Seed one tenant whose Slack call will succeed (ok:true path).  When
        // db.update throws on the clear step for this tenant, the catch block
        // only logs — it must NOT call sendIframerReplayDbFailureSlackNotification
        // because that helper is wired to the ok:false refresh branch only.
        const okTenantId = await createTenant({
          iframerSlackPostFailed: new Date(Date.now() - 30_000),
          iframerSlackFailedPayload: makePayload("linked"),
        });
        const okSlug = okTenantId; // slug === id by convention in createTenant

        // Route by tenantSlug: the ok tenant gets ok:true; the other two get ok:false.
        sendIframerAccountSlackNotificationMock.mockImplementation(
          async (...args: unknown[]) => {
            const { tenantSlug } = args[0] as { tenantSlug: string };
            if (tenantSlug === okSlug) {
              return { ok: true as const };
            }
            return { ok: false as const };
          },
        );

        // Force db.update to throw for every tenant so:
        //   ok:true tenant  → clear step throws → catch logs only, no Slack alert
        //   ok:false tenantA → refresh step throws → catch fires Slack alert
        //   ok:false tenantB → refresh step throws → catch fires Slack alert
        dbUpdateCtrl.shouldThrow = true;
        try {
          await replayFailedIframerSlackAlerts();
        } finally {
          dbUpdateCtrl.shouldThrow = false;
          // Restore default success implementation so subsequent tests are unaffected.
          sendIframerAccountSlackNotificationMock.mockImplementation(
            async () => ({ ok: true as const }),
          );
        }

        // The DB-failure Slack helper must have been called exactly twice — once
        // per ok:false tenant — confirming the guard does not fire for the ok:true
        // tenant and does not fire more than once per failing tenant even when the
        // in-flight row set contains an unrelated succeeding row.
        expect(
          sendIframerReplayDbFailureSlackNotificationMock,
        ).toHaveBeenCalledTimes(2);

        const calledWithIds =
          sendIframerReplayDbFailureSlackNotificationMock.mock.calls.map(
            (args) => (args[0] as { tenantId: string }).tenantId,
          );
        expect(calledWithIds).toContain(tenantIdA);
        expect(calledWithIds).toContain(tenantIdB);
        expect(calledWithIds).not.toContain(okTenantId);
      },
    );

    it(
      "mixed sweep with DB write failure: ok:true tenant's iframerSlackPostFailed remains non-null when clear step throws",
      async () => {
        // Seed one tenant whose Slack call returns ok:true — this is the tenant
        // whose clear step will throw because dbUpdateCtrl.shouldThrow = true.
        // The catch block swallows the error, so without a DB-state assertion the
        // silent no-op would never be detected.
        const okOriginalFailedAt = new Date(Date.now() - 75_000);
        const okOriginalPayload = makePayload("linked");
        const okTenantId = await createTenant({
          iframerSlackPostFailed: okOriginalFailedAt,
          iframerSlackFailedPayload: okOriginalPayload,
        });
        const okSlug = okTenantId; // slug === id by convention in createTenant

        // Seed a second tenant whose Slack call returns ok:false — it exercises
        // the refresh branch, confirming the sweep still processes multiple tenants
        // rather than short-circuiting after the first DB error.
        const failingTenantId = await createTenant({
          iframerSlackPostFailed: new Date(Date.now() - 45_000),
          iframerSlackFailedPayload: makePayload("unlinked"),
        });
        const failingSlug = failingTenantId;

        // Route by tenantSlug: the ok tenant gets ok:true; the failing tenant gets ok:false.
        sendIframerAccountSlackNotificationMock.mockImplementation(
          async (...args: unknown[]) => {
            const { tenantSlug } = args[0] as { tenantSlug: string };
            if (tenantSlug === okSlug) {
              return { ok: true as const };
            }
            if (tenantSlug === failingSlug) {
              return { ok: false as const };
            }
            return { ok: true as const };
          },
        );

        // Force ALL db.update calls to throw so:
        //   ok:true tenant  → clear step throws → catch swallows, flag NOT cleared
        //   ok:false tenant → refresh step throws → catch fires Slack alert
        dbUpdateCtrl.shouldThrow = true;
        let result: Awaited<ReturnType<typeof replayFailedIframerSlackAlerts>>;
        try {
          result = await replayFailedIframerSlackAlerts();
        } finally {
          dbUpdateCtrl.shouldThrow = false;
          // Restore default success implementation so subsequent tests are unaffected.
          sendIframerAccountSlackNotificationMock.mockImplementation(
            async () => ({ ok: true as const }),
          );
        }

        // The action counts the ok:true tenant as replayed (Slack delivered the
        // message) even though the flag clear failed.
        expect(result!.replayed).toBeGreaterThanOrEqual(1);
        // The ok:false tenant is counted as failed.
        expect(result!.failed).toBeGreaterThanOrEqual(1);

        // ── Key DB-state assertion ─────────────────────────────────────────────
        // iframerSlackPostFailed must still be set on the ok:true tenant.
        // The DB write threw so the clear never committed — the flag must not
        // have been silently zeroed by the catch block.
        const okRow = await db.query.tenantsTable.findFirst({
          where: eq(tenantsTable.id, okTenantId),
        });
        expect(okRow?.iframerSlackPostFailed).not.toBeNull();

        // The timestamp must equal the original seeded value — the failed clear
        // must not have written a new value or partially committed.
        expect(okRow!.iframerSlackPostFailed!.getTime()).toBe(
          okOriginalFailedAt.getTime(),
        );

        // iframerSlackFailedPayload must also remain intact — both columns are
        // written in a single .set() call, so if the update threw, neither column
        // should have changed.
        expect(okRow?.iframerSlackFailedPayload).toBe(okOriginalPayload);
      },
    );

    it(
      "ok:false Slack response with successful DB update: sendIframerReplayDbFailureSlackNotification is NOT called",
      async () => {
        // Seed a tenant with a stored failure payload so the action processes it.
        const tenantId = await createTenant({
          iframerSlackPostFailed: new Date(Date.now() - 60_000),
          iframerSlackFailedPayload: makePayload("linked"),
        });

        // Slack returns ok:false — the refresh-timestamp update path is taken.
        sendIframerAccountSlackNotificationMock.mockResolvedValueOnce({
          ok: false,
        });

        // dbUpdateCtrl.shouldThrow is false (default) — the DB update succeeds.
        // The DB-failure Slack helper must NOT be called because the catch block
        // that fires it is only reached when db.update throws, not on ok:false alone.
        const result = await replayFailedIframerSlackAlerts();

        expect(result.failed).toBeGreaterThanOrEqual(1);

        // The critical assertion: no spurious DB-failure Slack alert must fire.
        expect(
          sendIframerReplayDbFailureSlackNotificationMock,
        ).not.toHaveBeenCalled();

        // Sanity: confirm the row's failure flag was refreshed (DB write did land).
        const row = await db.query.tenantsTable.findFirst({
          where: eq(tenantsTable.id, tenantId),
        });
        expect(row?.iframerSlackPostFailed).not.toBeNull();
      },
    );

    it(
      "DB update failure after ok:false Slack response: console.error is emitted with tenantId and refresh-failure message",
      async () => {
        // Seed a tenant so the action has a row to process.
        const originalPayload = makePayload("linked");
        const tenantId = await createTenant({
          iframerSlackPostFailed: new Date(Date.now() - 60_000),
          iframerSlackFailedPayload: originalPayload,
        });

        // Slack returns ok:false — the refresh-timestamp update path is taken.
        sendIframerAccountSlackNotificationMock.mockResolvedValueOnce({
          ok: false,
        });

        // Spy on console.error before forcing the DB throw so we capture only
        // the log emitted during this test (restored in the spy's own cleanup).
        const errorSpy = vi
          .spyOn(console, "error")
          .mockImplementation(() => {});

        // Force db.update to throw so the catch block runs and logs.
        dbUpdateCtrl.shouldThrow = true;
        try {
          await replayFailedIframerSlackAlerts();
        } finally {
          dbUpdateCtrl.shouldThrow = false;
        }

        // Capture calls before restoring (mockRestore clears recorded calls).
        const calls = errorSpy.mock.calls.slice();
        errorSpy.mockRestore();

        // console.error must have been called at least once.
        expect(calls.length).toBeGreaterThan(0);

        // At least one call must reference both the tenantId and the
        // refresh-failure concept so operators can identify the stuck row.
        const matchingCall = calls.find(
          (args) =>
            args.some(
              (a) =>
                typeof a === "string" &&
                a.includes(tenantId) &&
                a.toLowerCase().includes("refresh"),
            ),
        );
        expect(matchingCall).toBeDefined();
      },
    );

    it(
      "concurrent sweep race: ok:true tenant's row is fully cleared after both sweeps settle",
      async () => {
        // Seed a single tenant with both failure columns set.  Two sweeps will
        // race to process this row; the test confirms that after both settle:
        //   1. The row is fully cleared — neither column is left non-null.
        //   2. No partial clear occurred — both columns are always written in a
        //      single .set() call, so they must either both commit or both fail.
        //   3. The Slack notification was delivered at least once — confirming
        //      the concurrent race did not silently swallow both deliveries.
        //
        // Note: because the SELECT in each sweep reads all rows before either
        // sweep's clear commits (Node.js interleaves at each await), both sweeps
        // may independently send the Slack notification and independently clear
        // the row.  This is expected behaviour for a non-transactional loop; the
        // test guards against a regression where the second clear leaves the row
        // in a *partially* cleared state (e.g. one column null, the other not).
        const originalPayload = makePayload("linked");
        const tenantId = await createTenant({
          iframerSlackPostFailed: new Date(Date.now() - 60_000),
          iframerSlackFailedPayload: originalPayload,
        });

        // Both sweeps run concurrently — neither waits for the other.
        // Slack mock returns ok:true (default) so both sweeps will attempt the
        // clear step if they each read the row before the first clear commits.
        const [result1, result2] = await Promise.all([
          replayFailedIframerSlackAlerts(),
          replayFailedIframerSlackAlerts(),
        ]);

        // Between the two sweeps, the tenant must have been counted as replayed
        // at least once — confirming the Slack message was delivered.
        expect(result1.replayed + result2.replayed).toBeGreaterThanOrEqual(1);

        // Neither sweep should have counted this tenant as failed.
        expect(result1.failed + result2.failed).toBe(0);

        // ── Key DB-state assertion ─────────────────────────────────────────────
        // Re-query the row after BOTH sweeps have settled.
        const row = await db.query.tenantsTable.findFirst({
          where: eq(tenantsTable.id, tenantId),
        });

        // iframerSlackPostFailed must be null — the row must be fully cleared.
        // A partial commit that zeroed only one column would leave the other
        // non-null and surface here.
        expect(row?.iframerSlackPostFailed).toBeNull();

        // iframerSlackFailedPayload must also be null — both columns are written
        // in a single .set() call, so a race that leaves this non-null while
        // iframerSlackPostFailed is null would indicate a split write regression.
        expect(row?.iframerSlackFailedPayload).toBeNull();

        // ── Duplicate-send boundary ────────────────────────────────────────────
        // In a true concurrent race both sweeps may read the row before the first
        // clear commits, so up to 2 Slack calls are expected.  The assertion
        // confirms at least 1 delivery occurred and no spurious third call (which
        // would indicate a retry loop regression rather than a simple race).
        const slackCallCount =
          (sendIframerAccountSlackNotificationMock.mock.calls as unknown[][]).filter(
            (args) =>
              (args[0] as { tenantSlug?: string }).tenantSlug === tenantId,
          ).length;
        expect(slackCallCount).toBeGreaterThanOrEqual(1);
        expect(slackCallCount).toBeLessThanOrEqual(2);
      },
    );

    it(
      "sequential sweeps: second sweep sends no Slack when first sweep already committed the DB clear",
      async () => {
        // This test covers the scenario where the first sweep's UPDATE commits
        // *before* the second sweep's SELECT executes — i.e. the sweeps run
        // strictly in sequence rather than concurrently interleaved.
        //
        // In this scenario PostgreSQL guarantees that the second sweep's SELECT
        // reads committed data and therefore finds zero pending rows.  The second
        // sweep must process nothing and send no Slack notification.
        //
        // This is the happy-path guard for the at-most-twice duplicate window
        // documented in the concurrent-race test above: when the two sweeps are
        // fully serialised (first await resolves before second begins), no
        // duplicate delivery can occur.
        const originalPayload = makePayload("linked");
        const tenantId = await createTenant({
          iframerSlackPostFailed: new Date(Date.now() - 60_000),
          iframerSlackFailedPayload: originalPayload,
        });

        // ── First sweep: runs to completion (Slack ok:true, row is cleared) ────
        const result1 = await replayFailedIframerSlackAlerts();

        // The first sweep must have processed our seeded tenant.
        expect(result1.replayed).toBeGreaterThanOrEqual(1);
        expect(result1.failed).toBe(0);

        // Confirm the row is cleared before the second sweep starts — this is
        // the pre-condition that makes the second sweep's SELECT see nothing.
        const clearedRow = await db.query.tenantsTable.findFirst({
          where: eq(tenantsTable.id, tenantId),
        });
        expect(clearedRow?.iframerSlackPostFailed).toBeNull();
        expect(clearedRow?.iframerSlackFailedPayload).toBeNull();

        // Reset the Slack call counter so we can distinguish first-sweep calls
        // from any second-sweep calls.
        sendIframerAccountSlackNotificationMock.mockClear();

        // ── Second sweep: starts only after first sweep's UPDATE has committed ──
        const result2 = await replayFailedIframerSlackAlerts();

        // The second sweep may process other pending rows in the integration DB,
        // but it must not have replayed or failed for our specific tenant.
        // We assert this by checking the Slack mock was NOT called with our
        // tenant's slug — the cleared row must be invisible to the SELECT.
        const slackCallsForOurTenant = (
          sendIframerAccountSlackNotificationMock.mock.calls as unknown[][]
        ).filter(
          (args) =>
            (args[0] as { tenantSlug?: string } | undefined)?.tenantSlug ===
            tenantId,
        );
        expect(slackCallsForOurTenant).toHaveLength(0);

        // The row must remain fully cleared after the second sweep settles —
        // a regression that re-sets either column would surface here.
        const rowAfterSecondSweep = await db.query.tenantsTable.findFirst({
          where: eq(tenantsTable.id, tenantId),
        });
        expect(rowAfterSecondSweep?.iframerSlackPostFailed).toBeNull();
        expect(rowAfterSecondSweep?.iframerSlackFailedPayload).toBeNull();

        // Silence the unused-variable lint warning — result2 is intentionally
        // not constrained beyond the per-tenant Slack assertions above, because
        // other integration-DB rows are outside this test's control.
        void result2;
      },
    );
  },
);
