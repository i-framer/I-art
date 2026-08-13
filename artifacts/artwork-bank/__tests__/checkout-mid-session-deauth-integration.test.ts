/**
 * Integration test: buyer sees the not-ready message when the gallery's
 * Stripe account is deauthorized mid-session.
 *
 * Scenario under test:
 *
 *   1. A tenant row starts with stripeChargesEnabled = true (gallery was
 *      ready when the buyer loaded the artwork page).
 *   2. A synthetic account.updated webhook fires with charges_enabled = false
 *      (Stripe deauthorizes the account while the buyer has the page open).
 *   3. The buyer then clicks "Buy" — a checkout POST arrives.
 *   4. The checkout route reads the now-false DB column via the readiness gate
 *      and must return 503 with the user-visible "not yet ready" message —
 *      never a 500 (unhandled error).
 *
 * Uses the real PostgreSQL database so the full
 *   webhook POST → DB update → checkout POST → DB read → readiness gate
 * path is exercised without any mocking of the DB layer.
 *
 * Non-DB dependencies (Stripe client, rate-limit, object-storage, email,
 * iFramer, Slack) are mocked because neither the account.updated handler nor
 * the readiness-gate fast-path touches them.
 */
import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { randomUUID } from "node:crypto";

// ── Mock next/headers — not available in plain Node ──────────────────────────
vi.mock("next/headers", () => ({
  headers: () => new Headers(),
}));

// ── Mock rate-limit: always allow so it never interferes ─────────────────────
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue(true),
}));

// ── Mock object-storage (image URL is optional; real calls would need creds) ─
vi.mock("@/lib/object-storage", () => ({
  getServeUrl: vi.fn().mockResolvedValue("https://img.example/test"),
}));

// ── Mock Stripe — readiness gate fast-paths before touching Stripe ────────────
const sessionsCreate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn().mockResolvedValue({
    checkout: { sessions: { create: sessionsCreate } },
  }),
  getStripeWebhookSecret: vi.fn().mockResolvedValue(null), // forces dev-bypass in webhook
  calcApplicationFee: (cents: number) => Math.round(cents * 0.05),
  calcApplicationFeeForTenant: (cents: number) => ({ feeCents: Math.round(cents * 0.05), commissionBasisPoints: 500 }),
  StripeNotConfiguredError: class StripeNotConfiguredError extends Error {},
  PLATFORM_FEE_PERCENT: 5,
}));

// ── Mock email / iFramer / Slack — not involved in either path ───────────────
vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: vi.fn(),
  sendBillingAlertNotification: vi.fn(),
}));
vi.mock("@/lib/iframer", () => ({
  createIFramerJob: vi.fn(),
  IFramerError: class IFramerError extends Error {},
}));
vi.mock("@/lib/base-url", () => ({
  getPlatformBaseUrl: () => "https://platform.test",
  getTenantUrl: () => "https://tenant.test",
}));
vi.mock("@/lib/slack", () => ({
  sendBillingAlertSlackNotification: vi.fn().mockResolvedValue({ ok: true }),
}));

// ── Real DB — the whole point of this integration test ───────────────────────
import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// ── Routes under test — imported after all mocks are registered ───────────────
import { POST as webhookPOST } from "@/app/api/stripe/webhook/route";
import { POST as checkoutPOST } from "@/app/api/stripe/checkout/route";

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid() {
  return randomUUID();
}

/**
 * Insert a tenant row that starts with stripeChargesEnabled = true, simulating
 * a gallery that was fully ready when the buyer loaded the artwork page.
 */
async function createReadyTenant(): Promise<{
  id: string;
  slug: string;
  stripeAccountId: string;
}> {
  const id = uid();
  const slug = `test-mid-session-deauth-${id}`;
  const stripeAccountId = `acct_test_${id.slice(0, 8)}`;
  await db.insert(tenantsTable).values({
    id,
    type: "ARTIST",
    businessName: `Deauth Test Gallery ${id}`,
    slug,
    stripeAccountId,
    stripeChargesEnabled: true,
    stripePayoutsEnabled: true,
  } as any);
  return { id, slug, stripeAccountId };
}

/** POST a synthetic Stripe account.updated event using the dev-bypass path. */
function postDeauthWebhook(stripeAccountId: string) {
  return webhookPOST(
    new Request("http://localhost/api/stripe/webhook", {
      method: "POST",
      body: JSON.stringify({
        type: "account.updated",
        data: {
          object: {
            id: stripeAccountId,
            charges_enabled: false,
            payouts_enabled: false,
          },
        },
      }),
    }),
  );
}

/** POST a synthetic Stripe account.updated event re-enabling charges. */
function postReauthWebhook(stripeAccountId: string) {
  return webhookPOST(
    new Request("http://localhost/api/stripe/webhook", {
      method: "POST",
      body: JSON.stringify({
        type: "account.updated",
        data: {
          object: {
            id: stripeAccountId,
            charges_enabled: true,
            payouts_enabled: true,
          },
        },
      }),
    }),
  );
}

/** Build a checkout POST request for the given slug. */
function checkoutRequest(slug: string) {
  return new Request("http://localhost/api/stripe/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      artworkId: uid(), // intentionally unknown — no artwork row created
      slug,
      fulfillmentType: "SHIP",
    }),
  });
}

// ── Cleanup tracking ──────────────────────────────────────────────────────────

const createdTenantIds: string[] = [];

beforeEach(() => {
  createdTenantIds.length = 0;
  sessionsCreate.mockResolvedValue({ url: "https://stripe.test/session" });
  process.env.STRIPE_WEBHOOK_DEV_BYPASS = "true";
});

afterEach(async () => {
  delete process.env.STRIPE_WEBHOOK_DEV_BYPASS;
  for (const id of createdTenantIds) {
    await db
      .delete(tenantsTable)
      .where(eq(tenantsTable.id, id))
      .catch(() => {});
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describeIntegration(
  "checkout mid-session deauthorization — buyer sees not-ready message",
  () => {
    it(
      "returns 503 with a user-visible message after the account is deauthorized between page load and buy",
      async () => {
        // Step 1: gallery was ready when the buyer loaded the page.
        const { id, slug, stripeAccountId } = await createReadyTenant();
        createdTenantIds.push(id);

        // Step 2: Stripe deauthorizes the account while the buyer has the page
        // open — account.updated webhook fires and flips the DB column to false.
        const webhookRes = await postDeauthWebhook(stripeAccountId);
        expect(webhookRes.status).toBe(200);

        // Step 3: buyer clicks "Buy" — checkout POST arrives.
        const checkoutRes = await checkoutPOST(checkoutRequest(slug));

        // Must be 503 (a handled, user-visible response), not a 500.
        expect(checkoutRes.status).toBe(503);
        const json = await checkoutRes.json();
        expect(json.error).toMatch(/not yet ready to accept payments/i);
      },
    );

    it(
      "does NOT return a 500 (unhandled error) after mid-session deauthorization",
      async () => {
        const { id, slug, stripeAccountId } = await createReadyTenant();
        createdTenantIds.push(id);

        await postDeauthWebhook(stripeAccountId);

        const checkoutRes = await checkoutPOST(checkoutRequest(slug));

        // Any unhandled error would surface as 500; the gate must handle it cleanly.
        expect(checkoutRes.status).not.toBe(500);
      },
    );

    it(
      "does NOT call Stripe after mid-session deauthorization (fast-path reject)",
      async () => {
        const { id, slug, stripeAccountId } = await createReadyTenant();
        createdTenantIds.push(id);

        await postDeauthWebhook(stripeAccountId);
        await checkoutPOST(checkoutRequest(slug));

        // The readiness gate short-circuits before ever contacting Stripe.
        expect(sessionsCreate).not.toHaveBeenCalled();
      },
    );

    it(
      "confirms the webhook correctly flipped stripeChargesEnabled to false in the DB",
      async () => {
        const { id, stripeAccountId } = await createReadyTenant();
        createdTenantIds.push(id);

        // Verify the row starts as true.
        const before = await db.query.tenantsTable.findFirst({
          where: eq(tenantsTable.id, id),
          columns: { stripeChargesEnabled: true },
        });
        expect(before?.stripeChargesEnabled).toBe(true);

        // Fire the deauth webhook.
        await postDeauthWebhook(stripeAccountId);

        // The row must now be false — the checkout gate reads from this column.
        const after = await db.query.tenantsTable.findFirst({
          where: eq(tenantsTable.id, id),
          columns: { stripeChargesEnabled: true },
        });
        expect(after?.stripeChargesEnabled).toBe(false);
      },
    );

    it(
      "allows checkout again after re-authorization (second account.updated with charges_enabled=true)",
      async () => {
        // Step 1: gallery starts ready.
        const { id, slug, stripeAccountId } = await createReadyTenant();
        createdTenantIds.push(id);

        // Step 2: deauthorize — checkout must now return 503.
        const deauthWebhookRes = await postDeauthWebhook(stripeAccountId);
        expect(deauthWebhookRes.status).toBe(200);

        const afterDeauth = await checkoutPOST(checkoutRequest(slug));
        expect(afterDeauth.status).toBe(503);

        // Step 3: re-authorize — a second account.updated fires with
        // charges_enabled=true (e.g. the gallery reconnects their Stripe account).
        const reauthWebhookRes = await postReauthWebhook(stripeAccountId);
        expect(reauthWebhookRes.status).toBe(200);

        // Step 4: confirm the DB column was restored to true.
        const row = await db.query.tenantsTable.findFirst({
          where: eq(tenantsTable.id, id),
          columns: { stripeChargesEnabled: true },
        });
        expect(row?.stripeChargesEnabled).toBe(true);

        // Step 5: buyer attempts checkout again — must NOT get a stale 503.
        // The route proceeds past the readiness gate and fails at the artwork
        // lookup (no artwork row was created), returning 400 rather than 503.
        const afterReauth = await checkoutPOST(checkoutRequest(slug));
        expect(afterReauth.status).not.toBe(503);
        expect(afterReauth.status).not.toBe(500);
        // 400 confirms the route passed the readiness gate and hit the next
        // validation layer (artwork not found / not available).
        expect(afterReauth.status).toBe(400);
      },
    );
  },
);
