/**
 * Task #63 — Checkout reservation race — real-DB integration.
 *
 * The unit test (checkout-reservation-race.test.ts) verified the conditional
 * UPDATE logic with an in-memory mock.  This integration test exercises the
 * same invariants against a real PostgreSQL database:
 *
 *  1. Two concurrent POST requests for the same AVAILABLE artwork: exactly one
 *     reserves it (status → RESERVED, Stripe session created) and the other
 *     receives 400 "not available for purchase".
 *
 *  2. A request for an already-RESERVED artwork (single buyer) is rejected
 *     with 400 before Stripe is contacted.
 *
 *  3. When the Stripe session.create call fails after the DB reservation is
 *     acquired, the artwork is released back to AVAILABLE so future buyers
 *     can try.
 *
 * Non-DB dependencies (Stripe, rate-limit, image CDN, email, iFramer) are
 * mocked.  The DB conditional UPDATE (WHERE status = 'AVAILABLE') is the
 * critical path being exercised against real Postgres concurrency semantics.
 */
import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { randomUUID } from "node:crypto";

// ── next/headers — unavailable in plain Node ──────────────────────────────────
vi.mock("next/headers", () => ({
  headers: () => new Headers(),
}));

// ── Rate-limit — always allow so concurrent requests are not blocked ──────────
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue(true),
}));

// ── Object-storage — no credentials needed in test ───────────────────────────
vi.mock("@/lib/object-storage", () => ({
  getServeUrl: vi.fn().mockResolvedValue("https://img.example/test"),
}));

// ── Stripe ────────────────────────────────────────────────────────────────────
const sessionsCreate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn().mockResolvedValue({
    checkout: { sessions: { create: sessionsCreate } },
  }),
  getStripeWebhookSecret: vi.fn().mockResolvedValue(null),
  calcApplicationFee: (cents: number) => Math.round(cents * 0.05),
  calcApplicationFeeForTenant: (cents: number) => ({ feeCents: Math.round(cents * 0.05), commissionBasisPoints: 500 }),
  StripeNotConfiguredError: class StripeNotConfiguredError extends Error {},
  PLATFORM_FEE_PERCENT: 5,
}));

// ── Email / iFramer / Slack ───────────────────────────────────────────────────
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

// ── Real DB ───────────────────────────────────────────────────────────────────
import { db, tenantsTable, artworksTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// ── Route under test ──────────────────────────────────────────────────────────
import { POST as checkoutPOST } from "@/app/api/stripe/checkout/route";

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid() {
  return randomUUID();
}

const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];

async function createTenant(): Promise<{ id: string; slug: string }> {
  const id = uid();
  const slug = `reservation-race-${id}`;
  await db.insert(tenantsTable).values({
    id,
    type: "ARTIST",
    businessName: `Race Test Gallery ${id}`,
    slug,
    stripeAccountId: `acct_test_race_${id.slice(0, 8)}`,
    stripeChargesEnabled: true,
    stripePayoutsEnabled: true,
  } as any);
  createdTenantIds.push(id);
  return { id, slug };
}

async function createArtwork(
  tenantId: string,
  status: "AVAILABLE" | "RESERVED" = "AVAILABLE",
): Promise<string> {
  const id = uid();
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Race Test Artwork",
    sku: `sku-race-${id}`,
    price: 10000, // cents
    status,
    showInGallery: true,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

function makeRequest(artworkId: string, slug: string) {
  return new Request("http://localhost/api/stripe/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ artworkId, slug, fulfillmentType: "SHIP" }),
  });
}

beforeEach(() => {
  createdTenantIds.length = 0;
  createdArtworkIds.length = 0;
  // Reset call count and set default return value for each test.
  sessionsCreate.mockClear();
  sessionsCreate.mockResolvedValue({ url: "https://stripe.test/pay/session" });
});

afterEach(async () => {
  for (const id of createdArtworkIds) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
});

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration(
  "checkout — reservation race (real DB, Task #63)",
  () => {
    it("exactly one concurrent request reserves the artwork; the other gets 400", async () => {
      const { id: tenantId, slug } = await createTenant();
      const artworkId = await createArtwork(tenantId, "AVAILABLE");

      // Fire two concurrent requests — real Postgres serialises the conditional UPDATE.
      const [res1, res2] = await Promise.all([
        checkoutPOST(makeRequest(artworkId, slug)),
        checkoutPOST(makeRequest(artworkId, slug)),
      ]);

      const statuses = [res1.status, res2.status].sort((a, b) => a - b);
      // Exactly one succeeds (200 JSON with checkout URL), one is rejected (400).
      // The route returns 200 + { url } rather than a 302; the client follows the URL.
      expect(statuses).toEqual([200, 400]);

      // Verify the DB row is RESERVED (the winner held it).
      const [artwork] = await db
        .select({ status: artworksTable.status })
        .from(artworksTable)
        .where(eq(artworksTable.id, artworkId));
      expect(artwork?.status).toBe("RESERVED");
    });

    it("a request for an already-RESERVED artwork is rejected with 400 before Stripe is called", async () => {
      const { id: tenantId, slug } = await createTenant();
      // Insert artwork already RESERVED (e.g. another buyer is mid-checkout).
      const artworkId = await createArtwork(tenantId, "RESERVED");

      const res = await checkoutPOST(makeRequest(artworkId, slug));

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error ?? body.message ?? "").toMatch(/not available/i);
      // Stripe must not have been contacted.
      expect(sessionsCreate).not.toHaveBeenCalled();
    });

    it("Stripe failure after reservation releases the artwork back to AVAILABLE", async () => {
      const { id: tenantId, slug } = await createTenant();
      const artworkId = await createArtwork(tenantId, "AVAILABLE");

      // Stripe throws — reservation must be rolled back.
      sessionsCreate.mockRejectedValueOnce(new Error("Stripe unavailable — test"));

      const res = await checkoutPOST(makeRequest(artworkId, slug));

      // Route returns a 5xx or 503 — the important thing is it's not 302.
      expect(res.status).not.toBe(302);

      // DB must have reverted to AVAILABLE.
      const [artwork] = await db
        .select({ status: artworksTable.status })
        .from(artworksTable)
        .where(eq(artworksTable.id, artworkId));
      expect(artwork?.status).toBe("AVAILABLE");
    });

    it("a request for an AVAILABLE artwork in a different tenant's slug is rejected", async () => {
      const { id: tenantA } = await createTenant();
      const { slug: slugB } = await createTenant();
      const artworkId = await createArtwork(tenantA, "AVAILABLE");

      // POST to tenantB's slug, but artworkId belongs to tenantA.
      const res = await checkoutPOST(makeRequest(artworkId, slugB));

      // The tenant lookup or artwork availability check will reject this.
      expect([400, 404, 503]).toContain(res.status);
      // The artwork must remain AVAILABLE (not reserved by the wrong tenant).
      const [artwork] = await db
        .select({ status: artworksTable.status })
        .from(artworksTable)
        .where(eq(artworksTable.id, artworkId));
      expect(artwork?.status).toBe("AVAILABLE");
    });
  },
);
