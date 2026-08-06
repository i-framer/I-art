/**
 * Integration test: duplicate-order idempotency guard holds on a real database.
 *
 * The unit test (webhook-duplicate-checkout.test.ts) confirms the guard logic is
 * correct against mocked DB calls. This suite proves the same guarantee holds
 * against a real PostgreSQL instance — catching unique-constraint races or
 * transaction-isolation issues that mocks cannot simulate.
 *
 * Scenarios:
 *  1. Core idempotency: the same checkout.session.completed event delivered twice
 *     produces exactly one order row, one order-item row, and sets the artwork
 *     status to SOLD exactly once. Both HTTP responses are 200.
 *
 *  2. DB-level backstop: the unique constraint on orders.stripe_session_id
 *     independently rejects a second insert for the same session — even if the
 *     application-level guard were removed.
 *
 * Uses describeIntegration() so the suite is skipped when DATABASE_URL is absent.
 * Explicitly sets STRIPE_WEBHOOK_DEV_BYPASS=true so the suite is self-contained
 * and does not rely on ambient environment configuration.
 */
import { it, expect, beforeAll, afterAll, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { randomUUID } from "node:crypto";

// ── Mock next/headers — no stripe-signature; forces dev-bypass path ───────────
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

// ── Mock all non-DB collaborators ─────────────────────────────────────────────
vi.mock("@/lib/stripe", () => ({
  getStripeWebhookSecret: vi.fn().mockResolvedValue(null),
  getStripeClient: vi.fn(),
  calcApplicationFee: (cents: number) => Math.round(cents * 0.05),
  StripeNotConfiguredError: class StripeNotConfiguredError extends Error {},
}));

vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: vi.fn().mockResolvedValue(undefined),
  sendBillingAlertNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/slack", () => ({
  sendBillingAlertSlackNotification: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@/lib/iframer", () => ({
  createIFramerJob: vi.fn().mockResolvedValue({ jobId: "job-test" }),
  IFramerError: class IFramerError extends Error {},
}));

vi.mock("@/lib/base-url", () => ({
  getTenantUrl: vi.fn().mockReturnValue("https://test.example.com/orders"),
  getPlatformBaseUrl: vi.fn().mockReturnValue("https://test.example.com"),
}));

// ── Real DB + webhook route ───────────────────────────────────────────────────
import {
  db,
  tenantsTable,
  artworksTable,
  ordersTable,
  orderItemsTable,
} from "@workspace/db";
import { eq, count } from "drizzle-orm";
import { POST as webhookPOST } from "@/app/api/stripe/webhook/route";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a synthetic checkout.session.completed Stripe event. */
function makeCheckoutEvent(opts: { sessionId: string; artworkId: string; tenantId: string }) {
  return {
    id: `evt_dup_${opts.sessionId}`,
    type: "checkout.session.completed",
    data: {
      object: {
        id: opts.sessionId,
        mode: "payment",
        amount_total: 10_000,
        payment_intent: `pi_dup_${opts.sessionId}`,
        metadata: {
          artworkId: opts.artworkId,
          tenantId: opts.tenantId,
          fulfillmentType: "SHIP",
        },
        customer_details: {
          email: "buyer@example.com",
          name: "Test Buyer",
        },
        customer_email: null,
      },
    },
  };
}

/** POST a synthetic event via the real webhook handler (dev-bypass path). */
function postEvent(event: object) {
  return webhookPOST(
    new Request("http://localhost/api/stripe/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    }),
  );
}

// ── Suite-level env setup — explicitly set the bypass flag ────────────────────

let originalBypass: string | undefined;

beforeAll(() => {
  originalBypass = process.env.STRIPE_WEBHOOK_DEV_BYPASS;
  process.env.STRIPE_WEBHOOK_DEV_BYPASS = "true";
});

afterAll(() => {
  if (originalBypass === undefined) {
    delete process.env.STRIPE_WEBHOOK_DEV_BYPASS;
  } else {
    process.env.STRIPE_WEBHOOK_DEV_BYPASS = originalBypass;
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describeIntegration("Duplicate checkout.session.completed — real DB", () => {
  /**
   * Scenario 1 — core idempotency guard.
   *
   * Each assertion is fully self-contained: it inserts its own tenant + artwork,
   * delivers two events, and queries the DB itself.
   */
  it("creates exactly one order row, one order-item, and marks artwork SOLD once when the same session is delivered twice", async () => {
    const RUN = randomUUID().slice(0, 8);
    const tenantId = `dup-t1-${RUN}`;
    const artworkId = `dup-a1-${RUN}`;
    const sessionId = `cs_dup_${RUN}`;

    // Insert tenant + artwork.
    await db.insert(tenantsTable).values({
      id: tenantId,
      type: "ARTIST",
      businessName: "Dup Guard Test Gallery",
      slug: `dup-guard-${RUN}`,
      billingExempt: true,
      subscriptionStatus: null,
    } as any);

    await db.insert(artworksTable).values({
      id: artworkId,
      tenantId,
      title: "Idempotency Test Piece",
      sku: `SKU-DUP-${RUN}`,
      price: 10_000,
      status: "AVAILABLE",
    } as any);

    try {
      const event = makeCheckoutEvent({ sessionId, artworkId, tenantId });

      // First delivery — no order exists yet; transaction must run.
      const r1 = await postEvent(event);
      expect(r1.status).toBe(200);

      // Second delivery (Stripe retry) — order already committed; must short-circuit.
      const r2 = await postEvent(event);
      expect(r2.status).toBe(200);

      // Exactly one order row for this session ID.
      const orderRows = await db
        .select({ id: ordersTable.id })
        .from(ordersTable)
        .where(eq(ordersTable.stripeSessionId, sessionId));
      expect(orderRows).toHaveLength(1);

      // Exactly one order-item row for this artwork.
      const [{ total: itemCount }] = await db
        .select({ total: count() })
        .from(orderItemsTable)
        .where(eq(orderItemsTable.artworkId, artworkId));
      expect(itemCount).toBe(1);

      // Artwork status is SOLD exactly once (it was AVAILABLE before both events).
      const artwork = await db.query.artworksTable.findFirst({
        where: eq(artworksTable.id, artworkId),
        columns: { status: true },
      });
      expect(artwork?.status).toBe("SOLD");
    } finally {
      // Clean up in FK-safe order.
      await db.delete(orderItemsTable).where(eq(orderItemsTable.tenantId, tenantId)).catch(() => {});
      await db.delete(ordersTable).where(eq(ordersTable.tenantId, tenantId)).catch(() => {});
      await db.delete(artworksTable).where(eq(artworksTable.id, artworkId)).catch(() => {});
      await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId)).catch(() => {});
    }
  });

  /**
   * Scenario 2 — DB-level backstop.
   *
   * Belt-and-suspenders: even if the application-level idempotency guard were
   * removed, the unique constraint on orders.stripe_session_id must reject a
   * second insert for the same session. This test exercises the constraint
   * directly without going through the webhook handler, so it does not depend
   * on the first test's side effects.
   */
  it("the DB unique constraint on stripe_session_id independently blocks a duplicate order insert", async () => {
    const RUN = randomUUID().slice(0, 8);
    const tenantId = `dup-t2-${RUN}`;
    const sessionId = `cs_uniq_${RUN}`;

    await db.insert(tenantsTable).values({
      id: tenantId,
      type: "ARTIST",
      businessName: "Unique Constraint Test Gallery",
      slug: `dup-uniq-${RUN}`,
      billingExempt: true,
      subscriptionStatus: null,
    } as any);

    // Insert the first order row.
    await db.insert(ordersTable).values({
      tenantId,
      stripeSessionId: sessionId,
      stripePaymentIntentId: `pi_first_${RUN}`,
      buyerEmail: "buyer@example.com",
      status: "PAID",
      fulfillmentType: "SHIP",
      totalCents: 10_000,
    } as any);

    try {
      // A second insert with the same stripeSessionId must throw a unique violation.
      await expect(
        db.insert(ordersTable).values({
          tenantId,
          stripeSessionId: sessionId, // duplicate → must violate unique constraint
          stripePaymentIntentId: `pi_second_${RUN}`,
          buyerEmail: "buyer2@example.com",
          status: "PAID",
          fulfillmentType: "SHIP",
          totalCents: 10_000,
        } as any),
      ).rejects.toThrow();
    } finally {
      await db.delete(ordersTable).where(eq(ordersTable.tenantId, tenantId)).catch(() => {});
      await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId)).catch(() => {});
    }
  });
});
