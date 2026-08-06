/**
 * Integration tests: account.updated webhook handler must keep the
 * stripeChargesEnabled / stripePayoutsEnabled cache on the tenant row current.
 *
 * Two scenarios under test:
 *
 *  1. Known account — fire a synthetic account.updated event for a tenant that
 *     owns the stripeAccountId; confirm the DB row is updated to reflect the
 *     latest charges_enabled / payouts_enabled values.
 *
 *  2. Unknown account — fire the same event for an account ID that no tenant
 *     owns; confirm the route still returns 200 (so Stripe stops retrying) and
 *     that no tenant row is mutated.
 *
 * Uses STRIPE_WEBHOOK_DEV_BYPASS=true so no real Stripe signature is required.
 * Non-DB dependencies (Stripe client, email, Slack, iFramer) are mocked because
 * the account.updated path does not invoke them; the mocks exist only to prevent
 * import-time crashes.
 */
import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { randomUUID } from "node:crypto";

// ── Mock next/headers — not available in plain Node ───────────────────────────
vi.mock("next/headers", () => ({
  headers: () => new Headers(), // no stripe-signature header
}));

// ── Mock non-DB dependencies used by other event handlers ────────────────────
vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(),
  getStripeWebhookSecret: vi.fn().mockResolvedValue(null), // forces dev-bypass path
  calcApplicationFee: (cents: number) => Math.round(cents * 0.05),
  StripeNotConfiguredError: class StripeNotConfiguredError extends Error {},
  PLATFORM_FEE_PERCENT: 5,
}));

vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: vi.fn(),
  sendBillingAlertNotification: vi.fn(),
}));

vi.mock("@/lib/slack", () => ({
  sendBillingAlertSlackNotification: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@/lib/iframer", () => ({
  createIFramerJob: vi.fn(),
  IFramerError: class IFramerError extends Error {},
}));

vi.mock("@/lib/base-url", () => ({
  getPlatformBaseUrl: () => "https://platform.test",
  getTenantUrl: () => "https://tenant.test",
}));

// ── Real DB — that is the whole point of this integration test ────────────────
import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// ── Route under test — imported after all mocks are registered ────────────────
import { POST as webhookPOST } from "@/app/api/stripe/webhook/route";

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid() {
  return randomUUID();
}

/** POST a synthetic Stripe event using the dev-bypass path. */
function postEvent(event: object) {
  return webhookPOST(
    new Request("http://localhost/api/stripe/webhook", {
      method: "POST",
      body: JSON.stringify(event),
    }),
  );
}

/** Create a minimal tenant row and return its id. */
async function createTenant(overrides: {
  stripeAccountId?: string;
  stripeChargesEnabled?: boolean | null;
  stripePayoutsEnabled?: boolean | null;
}) {
  const id = uid();
  await db.insert(tenantsTable).values({
    id,
    type: "FRAMER",
    businessName: `Test Gallery ${id}`,
    slug: `test-slug-${id}`,
    stripeAccountId: overrides.stripeAccountId ?? null,
    stripeChargesEnabled: overrides.stripeChargesEnabled ?? null,
    stripePayoutsEnabled: overrides.stripePayoutsEnabled ?? null,
  } as any);
  return id;
}

/** Read back the readiness columns for a tenant. */
async function readReadiness(tenantId: string) {
  return db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.id, tenantId),
    columns: { stripeChargesEnabled: true, stripePayoutsEnabled: true },
  });
}

// ── Cleanup tracking ──────────────────────────────────────────────────────────

const createdTenantIds: string[] = [];

beforeEach(() => {
  createdTenantIds.length = 0;
  process.env.STRIPE_WEBHOOK_DEV_BYPASS = "true";
});

afterEach(async () => {
  delete process.env.STRIPE_WEBHOOK_DEV_BYPASS;
  for (const id of createdTenantIds) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describeIntegration(
  "account.updated webhook — Stripe readiness cache on tenant row",
  () => {
    /**
     * Stale-cache warning scenario
     *
     * The settings page shows a warning banner when live Stripe reports
     * charges_enabled=true but the DB column stripeChargesEnabled is not true
     * (i.e. it is false or null).  The banner condition is:
     *
     *   stripeStatus === "active" && tenant.stripeChargesEnabled !== true
     *
     * This test starts with that exact mismatch (DB says false, live says
     * enabled), fires a synthetic account.updated webhook, and confirms the DB
     * column is flipped to true so the banner condition is no longer satisfied.
     */
    it(
      "stale-cache warning clears: DB updates from false→true after account.updated webhook",
      async () => {
        const stripeAccountId = `acct_test_${uid().slice(0, 8)}`;
        // Simulate the mismatch state: live Stripe has charges enabled, but the
        // cached DB column (stripeChargesEnabled) still shows false.
        const tenantId = await createTenant({
          stripeAccountId,
          stripeChargesEnabled: false, // the stale/incorrect cached value
          stripePayoutsEnabled: false,
        });
        createdTenantIds.push(tenantId);

        // Confirm the mismatch state before the webhook fires — the banner
        // condition `tenant.stripeChargesEnabled !== true` is satisfied.
        const before = await readReadiness(tenantId);
        expect(before?.stripeChargesEnabled).toBe(false);

        // A real account.updated webhook arrives (or is manually redelivered)
        // containing the authoritative Stripe values.
        const res = await postEvent({
          type: "account.updated",
          data: {
            object: {
              id: stripeAccountId,
              charges_enabled: true,
              payouts_enabled: true,
            },
          },
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.received).toBe(true);

        // After the webhook the DB column is true.  The settings page reads
        // tenant.stripeChargesEnabled directly from the DB; on the next render
        // the banner condition becomes:
        //   stripeStatus === "active" && true !== true  →  false
        // so the stale-cache warning banner is no longer rendered.
        const after = await readReadiness(tenantId);
        expect(after?.stripeChargesEnabled).toBe(true);
        expect(after?.stripePayoutsEnabled).toBe(true);
      },
    );

    it(
      "updates stripeChargesEnabled and stripePayoutsEnabled for a known account",
      async () => {
        const stripeAccountId = `acct_test_${uid().slice(0, 8)}`;
        const tenantId = await createTenant({
          stripeAccountId,
          stripeChargesEnabled: null,
          stripePayoutsEnabled: null,
        });
        createdTenantIds.push(tenantId);

        const res = await postEvent({
          type: "account.updated",
          data: {
            object: {
              id: stripeAccountId,
              charges_enabled: true,
              payouts_enabled: true,
            },
          },
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.received).toBe(true);

        const row = await readReadiness(tenantId);
        expect(row?.stripeChargesEnabled).toBe(true);
        expect(row?.stripePayoutsEnabled).toBe(true);
      },
    );

    it(
      "flips charges/payouts back to false when Stripe restricts the account",
      async () => {
        const stripeAccountId = `acct_test_${uid().slice(0, 8)}`;
        const tenantId = await createTenant({
          stripeAccountId,
          stripeChargesEnabled: true,
          stripePayoutsEnabled: true,
        });
        createdTenantIds.push(tenantId);

        const res = await postEvent({
          type: "account.updated",
          data: {
            object: {
              id: stripeAccountId,
              charges_enabled: false,
              payouts_enabled: false,
            },
          },
        });

        expect(res.status).toBe(200);

        const row = await readReadiness(tenantId);
        expect(row?.stripeChargesEnabled).toBe(false);
        expect(row?.stripePayoutsEnabled).toBe(false);
      },
    );

    it(
      "returns 200 and mutates no tenant row when the account ID is unknown",
      async () => {
        // Create a real tenant so we can confirm it is NOT touched.
        const ownedAccountId = `acct_test_${uid().slice(0, 8)}`;
        const tenantId = await createTenant({
          stripeAccountId: ownedAccountId,
          stripeChargesEnabled: null,
          stripePayoutsEnabled: null,
        });
        createdTenantIds.push(tenantId);

        const unknownAccountId = `acct_unknown_${uid().slice(0, 8)}`;

        const res = await postEvent({
          type: "account.updated",
          data: {
            object: {
              id: unknownAccountId,
              charges_enabled: true,
              payouts_enabled: true,
            },
          },
        });

        // 200 is required — Stripe must not retry a legitimate unmatched event.
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.received).toBe(true);

        // The tenant that owns a different account must remain untouched.
        const row = await readReadiness(tenantId);
        expect(row?.stripeChargesEnabled).toBeNull();
        expect(row?.stripePayoutsEnabled).toBeNull();
      },
    );
  },
);
