/**
 * Integration tests: checkout route readiness gate — real DB.
 *
 * Three scenarios under test:
 *
 *  1. Tenant with stripeChargesEnabled = false → 503 with a user-visible
 *     "not yet ready" message, never a 500.  The artwork must not be reserved
 *     and Stripe must not be contacted.
 *
 *  2. Tenant with stripeChargesEnabled = null (no account.updated webhook ever
 *     received) → benefit of the doubt: the gate is passed and the route
 *     advances to the artwork-reservation step.  With no matching artwork it
 *     returns 400 "not available for purchase", confirming the gate did not
 *     block checkout.  Stripe's account_invalid error is the safety net if the
 *     account is genuinely not charge-ready.
 *
 *  3. Tenant with stripeChargesEnabled = true → the readiness check is passed;
 *     the route advances to the artwork-reservation step.  With no matching
 *     artwork in the DB it returns 400 "not available for purchase", which
 *     confirms the gate did not block checkout.
 *
 * Uses the real PostgreSQL database so the full
 *   POST body → getTenantBySlug (real DB query) → readiness gate
 * path is exercised without any DB mocking.
 *
 * Non-DB dependencies (Stripe client, rate-limit, object-storage, email,
 * iFramer) are mocked because the readiness path either rejects before
 * touching them (false scenario) or is simply not the focus of this test
 * (null/true scenarios).
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

// ── Mock Stripe — we only care about the readiness gate, not real payments ───
const sessionsCreate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn().mockResolvedValue({
    checkout: { sessions: { create: sessionsCreate } },
  }),
  getStripeWebhookSecret: vi.fn().mockResolvedValue(null),
  calcApplicationFee: (cents: number) => Math.round(cents * 0.05),
  StripeNotConfiguredError: class StripeNotConfiguredError extends Error {},
  PLATFORM_FEE_PERCENT: 5,
}));

// ── Mock email / iFramer — not involved in the readiness path ─────────────────
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
import { db, tenantsTable, artworksTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// ── Route under test — imported after all mocks are registered ───────────────
import { POST as checkoutPOST } from "@/app/api/stripe/checkout/route";

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid() {
  return randomUUID();
}

/**
 * Insert a minimal tenant row.  storefrontEnabled defaults to true in the
 * schema; stripeAccountId is required for the checkout route to reach the
 * readiness gate.
 */
async function createTenant(opts: {
  stripeChargesEnabled: boolean | null;
}): Promise<{ id: string; slug: string }> {
  const id = uid();
  const slug = `test-checkout-readiness-${id}`;
  await db.insert(tenantsTable).values({
    id,
    type: "ARTIST",
    businessName: `Readiness Test Gallery ${id}`,
    slug,
    stripeAccountId: `acct_test_${id.slice(0, 8)}`,
    stripeChargesEnabled: opts.stripeChargesEnabled,
    stripePayoutsEnabled: opts.stripeChargesEnabled, // keep consistent with charges
  } as any);
  return { id, slug };
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
const createdArtworkIds: string[] = [];

beforeEach(() => {
  createdTenantIds.length = 0;
  createdArtworkIds.length = 0;
  sessionsCreate.mockResolvedValue({ url: "https://stripe.test/session" });
});

afterEach(async () => {
  // Delete artworks first (FK references tenants).
  for (const id of createdArtworkIds) {
    await db
      .delete(artworksTable)
      .where(eq(artworksTable.id, id))
      .catch(() => {});
  }
  for (const id of createdTenantIds) {
    await db
      .delete(tenantsTable)
      .where(eq(tenantsTable.id, id))
      .catch(() => {});
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describeIntegration(
  "checkout readiness gate — real DB row with stripeChargesEnabled",
  () => {
    it(
      "returns 503 with a user-visible message when stripeChargesEnabled is false",
      async () => {
        const { id, slug } = await createTenant({
          stripeChargesEnabled: false,
        });
        createdTenantIds.push(id);

        const res = await checkoutPOST(checkoutRequest(slug));

        // Must be a 503, not a 500 (i.e. a handled, user-visible response).
        expect(res.status).toBe(503);
        const json = await res.json();
        expect(json.error).toMatch(/not yet ready to accept payments/i);
      },
    );

    it(
      "does NOT call Stripe when stripeChargesEnabled is false (fast-path reject)",
      async () => {
        const { id, slug } = await createTenant({
          stripeChargesEnabled: false,
        });
        createdTenantIds.push(id);

        await checkoutPOST(checkoutRequest(slug));

        // The route must short-circuit before ever contacting Stripe.
        expect(sessionsCreate).not.toHaveBeenCalled();
      },
    );

    it(
      "leaves the artwork AVAILABLE in the DB when stripeChargesEnabled is false",
      async () => {
        const { id: tenantId, slug } = await createTenant({
          stripeChargesEnabled: false,
        });
        createdTenantIds.push(tenantId);

        // Insert a real artwork so the route could theoretically reserve it.
        const artworkId = uid();
        await db.insert(artworksTable).values({
          id: artworkId,
          tenantId,
          title: "Test Artwork",
          sku: `sku-${artworkId}`,
          status: "AVAILABLE",
          showInGallery: true,
        } as any);
        createdArtworkIds.push(artworkId);

        const res = await checkoutPOST(
          new Request("http://localhost/api/stripe/checkout", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ artworkId, slug, fulfillmentType: "SHIP" }),
          }),
        );

        // The readiness gate must reject before attempting to reserve the artwork.
        expect(res.status).toBe(503);

        // Directly query the DB to confirm the artwork was never RESERVED.
        const [row] = await db
          .select({ status: artworksTable.status })
          .from(artworksTable)
          .where(eq(artworksTable.id, artworkId));
        expect(row?.status).toBe("AVAILABLE");
      },
    );

    it(
      "proceeds past the readiness check when stripeChargesEnabled is null (benefit of the doubt)",
      async () => {
        const { id, slug } = await createTenant({
          stripeChargesEnabled: null,
        });
        createdTenantIds.push(id);

        const res = await checkoutPOST(checkoutRequest(slug));

        // The gate must NOT fast-reject with 503.  The unknown artworkId means
        // the route returns 400 "not available for purchase" — confirming the
        // readiness gate was passed and the route proceeded to the reservation step.
        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.error).toMatch(/not available for purchase/i);
        // Critically: must NOT be the readiness-gate message.
        expect(json.error).not.toMatch(/not yet ready to accept payments/i);
      },
    );

    it(
      "does NOT fast-reject Stripe contact when stripeChargesEnabled is null",
      async () => {
        const { id, slug } = await createTenant({
          stripeChargesEnabled: null,
        });
        createdTenantIds.push(id);

        // The reservation will fail (no matching artwork), so Stripe is never
        // reached in this specific call — but the important thing is that the
        // route did NOT return 503 before even attempting reservation.
        const res = await checkoutPOST(checkoutRequest(slug));
        expect(res.status).not.toBe(503);
      },
    );

    it(
      "proceeds past the readiness check when stripeChargesEnabled is true",
      async () => {
        const { id, slug } = await createTenant({
          stripeChargesEnabled: true,
        });
        createdTenantIds.push(id);

        const res = await checkoutPOST(checkoutRequest(slug));

        // The readiness gate passed.  The unknown artworkId means the route
        // returns 400 "not available for purchase" — not the 503 that the
        // readiness gate returns — confirming the gate did not block checkout.
        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.error).toMatch(/not available for purchase/i);
        // Critically: this must NOT be the readiness-gate message.
        expect(json.error).not.toMatch(/not yet ready to accept payments/i);
      },
    );
  },
);
