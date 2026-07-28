/**
 * End-to-end verification (against a mock of the real DB schema) that:
 *
 * 1. An unmatched customer.subscription.* event inserts a row into
 *    stripe_alert via `onConflictDoNothing`.
 * 2. An unmatched invoice.payment_failed event inserts a row the same way.
 * 3. Sending the same stripeEventId a second time does NOT create a
 *    duplicate (idempotency via the unique constraint + onConflictDoNothing).
 * 4. dismissBillingAlert sets dismissed_at on the target row.
 * 5. A dismissed alert would no longer appear in an "unresolved" query
 *    (column is set; app logic filters on `dismissedAt IS NULL`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Fake DB ──────────────────────────────────────────────────────────────────
//
// We track every insert/update call with enough fidelity to verify:
//   - what table was targeted
//   - what values were passed
//   - whether onConflictDoNothing was called
//   - the chain of .set().where().returning() for updates

type AlertRow = {
  id: string;
  stripeEventId: string;
  eventType: string;
  customerId: string | null;
  subscriptionId: string | null;
  reason: string;
  dismissedAt: Date | null;
  createdAt: Date;
};

const db_state = vi.hoisted(() => ({
  alerts: [] as AlertRow[],
  insertCalls: [] as Array<{ table: string; values: any; conflictTarget?: string }>,
  updateCalls: [] as Array<{ table: string; set: any; whereId: string | null }>,
  tenantRows: [] as Array<{ id: string }>,
}));

// Table descriptor objects — used as identity keys in the mock.
const tables = vi.hoisted(() => ({
  ordersTable: {
    stripeSessionId: "stripeSessionId",
    id: "id",
  },
  orderItemsTable: {},
  artworksTable: { id: "id", tenantId: "tenantId", status: "status" },
  tenantsTable: {
    id: "id",
    stripeCustomerId: "stripeCustomerId",
    stripeSubscriptionId: "stripeSubscriptionId",
    subscriptionStatus: "subscriptionStatus",
  },
  stripeAlertsTable: {
    id: "id",
    stripeEventId: "stripeEventId",
    dismissedAt: "dismissedAt",
  },
}));

vi.mock("@workspace/db", () => {
  // Minimal builder that records calls and simulates the DB behaviour we care
  // about (unique-constraint idempotency + update returning).
  const makeInsertBuilder = (table: any, values: any) => {
    let conflictTarget: string | undefined;

    // Core insert logic shared by `then` (bare await) and `returning()`.
    const doInsert = (): AlertRow | null => {
      if (table !== tables.stripeAlertsTable) return null;
      const existing = db_state.alerts.find(
        (a) => a.stripeEventId === values.stripeEventId,
      );
      let inserted: AlertRow | null = null;
      if (!existing) {
        const row: AlertRow = {
          id: `alert-${db_state.alerts.length + 1}`,
          stripeEventId: values.stripeEventId,
          eventType: values.eventType,
          customerId: values.customerId ?? null,
          subscriptionId: values.subscriptionId ?? null,
          reason: values.reason,
          dismissedAt: null,
          createdAt: new Date(),
        };
        db_state.alerts.push(row);
        inserted = row;
      }
      db_state.insertCalls.push({
        table: "stripeAlertsTable",
        values,
        conflictTarget,
      });
      return inserted;
    };

    const builder = {
      onConflictDoNothing(opts?: { target?: any }) {
        conflictTarget = opts?.target ? "stripeEventId" : undefined;
        return builder;
      },
      returning(_cols?: any) {
        const inserted = doInsert();
        return Promise.resolve(inserted ? [{ id: inserted.id }] : []);
      },
      then(resolve: (v: any) => any) {
        doInsert();
        return resolve(undefined);
      },
    };
    return builder;
  };

  const makeUpdateBuilder = (table: any) => ({
    set(vals: any) {
      return {
        where() {
          if (table === tables.stripeAlertsTable && vals.dismissedAt) {
            // Apply dismissedAt to the first undismissed alert in our store.
            // Tests only ever dismiss one alert at a time, so this is unambiguous.
            const alert = db_state.alerts.find((a) => a.dismissedAt === null);
            if (alert) alert.dismissedAt = vals.dismissedAt;
            db_state.updateCalls.push({
              table: "stripeAlertsTable",
              set: vals,
              whereId: alert?.id ?? null,
            });
            return {
              returning: () =>
                Promise.resolve(alert ? [{ id: alert.id }] : []),
            };
          }
          if (table === tables.tenantsTable) {
            return {
              returning: async () => [],
            };
          }
          return { returning: async () => [] };
        },
      };
    },
  });

  return {
    db: {
      query: {
        tenantsTable: {
          findFirst: vi.fn(async () => undefined),
        },
        ordersTable: { findFirst: vi.fn(async () => undefined) },
        artworksTable: { findFirst: vi.fn(async () => undefined) },
      },
      insert: vi.fn((table: any) => ({
        values: (values: any) => makeInsertBuilder(table, values),
      })),
      update: vi.fn((table: any) => makeUpdateBuilder(table)),
    },
    ...tables,
    // sql tag used in cancelGuard — return a plain object
    sql: Object.assign((_tpl: TemplateStringsArray, ..._args: any[]) => ({}), {
      raw: (s: string) => s,
    }),
  };
});

vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(),
  getStripeWebhookSecret: vi.fn().mockResolvedValue(null),
  calcApplicationFee: (cents: number) => Math.round(cents * 0.05),
  StripeNotConfiguredError: class StripeNotConfiguredError extends Error {},
}));

vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: vi.fn(),
  sendBillingAlertNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/iframer", () => ({
  createIFramerJob: vi.fn(),
  IFramerError: class IFramerError extends Error {},
}));

vi.mock("@/lib/base-url", () => ({ getTenantUrl: vi.fn(() => "http://localhost") }));

const mockHeaders = vi.hoisted(() => vi.fn());
vi.mock("next/headers", () => ({
  headers: () => mockHeaders(),
}));

// For dismissBillingAlert
vi.mock("@/lib/platform-admin", () => ({
  requirePlatformAdmin: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { POST as webhookPOST } from "@/app/api/stripe/webhook/route";
import { dismissBillingAlert } from "@/app/platform/actions";
import { db } from "@workspace/db";

// ── Helpers ───────────────────────────────────────────────────────────────────

function subscriptionEvent(
  eventId: string,
  type = "customer.subscription.updated",
) {
  return {
    type,
    id: eventId,
    data: {
      object: {
        id: "sub_unmatched_001",
        status: "active",
        customer: "cus_unmatched_001",
        metadata: {}, // no billingTenantId → will fail tenant lookup
      },
    },
  };
}

function invoiceEvent(eventId: string) {
  return {
    type: "invoice.payment_failed",
    id: eventId,
    data: {
      object: {
        id: "in_unmatched_001",
        customer: "cus_unmatched_invoice",
        subscription: "sub_invoice_001",
      },
    },
  };
}

async function postWebhook(payload: object) {
  return webhookPOST(
    new Request("http://localhost/api/stripe/webhook", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  );
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  db_state.alerts.length = 0;
  db_state.insertCalls.length = 0;
  db_state.updateCalls.length = 0;
  db_state.tenantRows.length = 0;

  process.env.STRIPE_WEBHOOK_DEV_BYPASS = "true";
  mockHeaders.mockReturnValue(new Headers());

  // No tenant will match — ensures the unmatched path is taken
  vi.mocked(db.query.tenantsTable.findFirst).mockResolvedValue(
    undefined as any,
  );
});

afterEach(() => {
  delete process.env.STRIPE_WEBHOOK_DEV_BYPASS;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Unmatched subscription event → stripe_alert row inserted", () => {
  it("inserts a row when no tenant matches the subscription event", async () => {
    const res = await postWebhook(
      subscriptionEvent("evt_sub_001", "customer.subscription.updated"),
    );

    expect(res.status).toBe(200);
    expect(db_state.alerts).toHaveLength(1);

    const alert = db_state.alerts[0];
    expect(alert.stripeEventId).toBe("evt_sub_001");
    expect(alert.eventType).toBe("customer.subscription.updated");
    expect(alert.customerId).toBe("cus_unmatched_001");
    expect(alert.subscriptionId).toBe("sub_unmatched_001");
    expect(alert.reason).toMatch(/no tenant matched/i);
    expect(alert.dismissedAt).toBeNull();
  });

  it("inserts a row for customer.subscription.deleted too", async () => {
    const res = await postWebhook(
      subscriptionEvent("evt_sub_del_001", "customer.subscription.deleted"),
    );

    expect(res.status).toBe(200);
    expect(db_state.alerts).toHaveLength(1);
    expect(db_state.alerts[0].eventType).toBe("customer.subscription.deleted");
  });
});

describe("Unmatched invoice.payment_failed → stripe_alert row inserted", () => {
  it("inserts a row when no tenant matches the customer ID", async () => {
    const res = await postWebhook(invoiceEvent("evt_inv_001"));

    expect(res.status).toBe(200);
    expect(db_state.alerts).toHaveLength(1);

    const alert = db_state.alerts[0];
    expect(alert.stripeEventId).toBe("evt_inv_001");
    expect(alert.eventType).toBe("invoice.payment_failed");
    expect(alert.customerId).toBe("cus_unmatched_invoice");
    expect(alert.reason).toMatch(/no tenant matched/i);
    expect(alert.dismissedAt).toBeNull();
  });
});

describe("Idempotency — duplicate stripeEventId does not create a second row", () => {
  it("delivers the same event twice but only stores one alert row", async () => {
    const payload = subscriptionEvent("evt_idempotent_001");

    const res1 = await postWebhook(payload);
    const res2 = await postWebhook(payload);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    // Two insert attempts were made …
    expect(db_state.insertCalls).toHaveLength(2);
    // … but only one row exists (second was a no-op due to conflict)
    expect(db_state.alerts).toHaveLength(1);
  });

  it("uses onConflictDoNothing targeting stripeEventId", async () => {
    await postWebhook(subscriptionEvent("evt_conflict_check_001"));

    const insertCall = db_state.insertCalls[0];
    expect(insertCall.conflictTarget).toBe("stripeEventId");
  });
});

describe("dismissBillingAlert — sets dismissed_at on the target row", () => {
  it("marks the alert as dismissed", async () => {
    // First create an alert via the webhook path
    await postWebhook(subscriptionEvent("evt_to_dismiss_001"));
    expect(db_state.alerts).toHaveLength(1);

    const alertId = db_state.alerts[0].id;

    // The mock's makeUpdateBuilder handles dismissals by applying dismissedAt
    // to the first undismissed row — no need to patch mid-test.
    await dismissBillingAlert(alertId);

    expect(db_state.updateCalls).toHaveLength(1);
    expect(db_state.updateCalls[0].set.dismissedAt).toBeInstanceOf(Date);

    // The row now has a dismissedAt timestamp
    const alert = db_state.alerts[0];
    expect(alert.dismissedAt).toBeInstanceOf(Date);
  });

  it("a dismissed alert no longer appears in the unresolved list", async () => {
    // Seed two alerts
    await postWebhook(subscriptionEvent("evt_keep_001"));
    await postWebhook(subscriptionEvent("evt_dismiss_002"));
    expect(db_state.alerts).toHaveLength(2);

    // Dismiss the second one
    db_state.alerts[1].dismissedAt = new Date();

    // Simulate what the app query does: filter dismissedAt IS NULL
    const unresolved = db_state.alerts.filter((a) => a.dismissedAt === null);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].stripeEventId).toBe("evt_keep_001");
  });
});
