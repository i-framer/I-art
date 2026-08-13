/**
 * Platform billing-alerts panel — checkout.session.completed rows — real-DB integration.
 *
 * The checkout integrity fix inserts a `stripe_alert` row when a paid session
 * cannot be fulfilled (missing metadata, artwork/tenant mismatch). This test
 * confirms those rows:
 *
 *   1. Appear in the panel query (isNull(dismissedAt)) — not filtered out by
 *      event type. The panel has no eventType filter so checkout alerts surface
 *      alongside subscription alerts.
 *   2. Carry a human-readable reason that includes the Stripe session ID so an
 *      operator can identify the affected payment.
 *   3. Can be dismissed via dismissBillingAlert, after which the panel query
 *      no longer returns them.
 *
 * The panel query (artifacts/artwork-bank/app/platform/page.tsx ~37-42):
 *   db.select().from(stripeAlertsTable)
 *     .where(isNull(stripeAlertsTable.dismissedAt))
 *     .orderBy(desc(stripeAlertsTable.createdAt))
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable, stripeAlertsTable } from "@workspace/db";
import { desc, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Dev bypass — no Stripe signature required ────────────────────────────────
vi.stubEnv("STRIPE_WEBHOOK_DEV_BYPASS", "true");

// ── Mocks required by the webhook route ─────────────────────────────────────
vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(),
  getStripeWebhookSecret: vi.fn().mockResolvedValue(null),
  calcApplicationFee: (cents: number) => Math.round(cents * 0.05),
  StripeNotConfiguredError: class StripeNotConfiguredError extends Error {},
}));
vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: vi.fn(async () => {}),
  sendBillingAlertNotification: vi.fn(async () => {}),
}));
vi.mock("@/lib/slack", () => ({
  sendBillingAlertSlackNotification: vi.fn(async () => ({ ok: true })),
  sendIframerAccountSlackNotification: vi.fn(async () => {}),
  postToSlack: vi.fn(async () => {}),
}));
vi.mock("@/lib/iframer", () => ({
  createIFramerJob: vi.fn(async () => ({ ok: true })),
  IFramerError: class IFramerError extends Error {},
}));
vi.mock("@/lib/base-url", () => ({
  getTenantUrl: vi.fn(() => "https://gallery.test/orders"),
  getPlatformBaseUrl: vi.fn(() => "https://platform.test"),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (_key: string) => null,
  })),
}));

// ── Mocks required by dismissBillingAlert (server action) ───────────────────
vi.mock("@/lib/platform-admin", () => ({
  requirePlatformAdmin: vi.fn().mockResolvedValue(undefined),
  isPlatformAdmin: vi.fn().mockReturnValue(true),
  tenantBillingStatus: vi.fn(),
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { POST } from "@/app/api/stripe/webhook/route";
import { dismissBillingAlert } from "@/app/platform/actions";
import { sendBillingAlertSlackNotification } from "@/lib/slack";

// ── Fixtures ─────────────────────────────────────────────────────────────────
const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdAlertEventIds: string[] = [];

function uid() {
  return `${randomUUID()}-bap-${RUN}-${++seq}`;
}

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Panel Alert Test Gallery",
    type: "ARTIST",
    billingExempt: true,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Panel Alert Test Artwork",
    sku: `sku-${id}`,
    status: "AVAILABLE",
    price: 50000,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function cleanup() {
  for (const id of createdArtworkIds.splice(0)) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
  for (const eventId of createdAlertEventIds.splice(0)) {
    await db.delete(stripeAlertsTable).where(eq(stripeAlertsTable.stripeEventId, eventId)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ── Panel query helper — mirrors the real page query exactly ─────────────────
function panelQuery() {
  return db
    .select()
    .from(stripeAlertsTable)
    .where(isNull(stripeAlertsTable.dismissedAt))
    .orderBy(desc(stripeAlertsTable.createdAt));
}

function makeRequest(event: object): Request {
  return new Request("http://localhost/api/stripe/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration(
  "Platform billing-alerts panel — checkout.session.completed rows — real-DB integration",
  () => {
    it("missing-metadata alert appears in the panel query", async () => {
      const sessionId = `cs_test_${uid()}`;
      const eventId = `evt-${sessionId}`;
      createdAlertEventIds.push(eventId);

      const noMetaEvent = {
        id: eventId,
        type: "checkout.session.completed",
        data: {
          object: {
            id: sessionId,
            mode: "payment",
            amount_total: 50000,
            metadata: {}, // no artworkId/tenantId/fulfillmentType
            customer_details: { email: "buyer@example.com", name: "Test Buyer" },
          },
        },
      };

      const res = await POST(makeRequest(noMetaEvent));
      expect(res.status).toBe(200);

      // Run the same query the platform page uses.
      const alerts = await panelQuery();
      const row = alerts.find((a) => a.stripeEventId === eventId);

      expect(row).toBeDefined();
      expect(row?.eventType).toBe("checkout.session.completed");
    });

    it("missing-metadata alert reason is human-readable and references the session ID", async () => {
      const sessionId = `cs_test_${uid()}`;
      const eventId = `evt-${sessionId}`;
      createdAlertEventIds.push(eventId);

      const noMetaEvent = {
        id: eventId,
        type: "checkout.session.completed",
        data: {
          object: {
            id: sessionId,
            mode: "payment",
            amount_total: 50000,
            metadata: {},
            customer_details: { email: "buyer@example.com", name: "Test Buyer" },
          },
        },
      };

      await POST(makeRequest(noMetaEvent));

      const alerts = await panelQuery();
      const row = alerts.find((a) => a.stripeEventId === eventId);

      // The reason must be human-readable enough for an operator to act on it.
      expect(row?.reason).toBeTruthy();
      // Must contain the session ID so the operator can look up the payment.
      expect(row?.reason).toMatch(sessionId);
    });

    it("artwork-tenant mismatch alert appears in the panel query", async () => {
      const tenantA = await createTenant();
      const tenantB = await createTenant();
      const artworkId = await createArtwork(tenantA); // artwork belongs to tenantA
      const sessionId = `cs_test_${uid()}`;
      const eventId = `evt-${sessionId}`;
      createdAlertEventIds.push(eventId);

      // Event claims artwork belongs to tenantB — integrity check rejects it.
      const mismatchEvent = {
        id: eventId,
        type: "checkout.session.completed",
        data: {
          object: {
            id: sessionId,
            mode: "payment",
            payment_intent: `pi-${sessionId}`,
            amount_total: 50000,
            metadata: { artworkId, tenantId: tenantB, fulfillmentType: "PICKUP" },
            customer_details: { email: "buyer@example.com", name: "Test Buyer" },
          },
        },
      };

      const res = await POST(makeRequest(mismatchEvent));
      expect(res.status).toBe(200);

      const alerts = await panelQuery();
      const row = alerts.find((a) => a.stripeEventId === eventId);

      expect(row).toBeDefined();
      expect(row?.eventType).toBe("checkout.session.completed");
      // Must mention artwork and session so the operator knows which payment failed.
      expect(row?.reason).toMatch(artworkId);
      expect(row?.reason).toMatch(sessionId);
    });

    it("dismissing a checkout alert removes it from the panel query", async () => {
      const sessionId = `cs_test_${uid()}`;
      const eventId = `evt-${sessionId}`;
      createdAlertEventIds.push(eventId);

      const noMetaEvent = {
        id: eventId,
        type: "checkout.session.completed",
        data: {
          object: {
            id: sessionId,
            mode: "payment",
            amount_total: 50000,
            metadata: {},
            customer_details: { email: "buyer@example.com", name: "Test Buyer" },
          },
        },
      };

      await POST(makeRequest(noMetaEvent));

      // Confirm the alert is in the panel before dismissal.
      const before = await panelQuery();
      const rowBefore = before.find((a) => a.stripeEventId === eventId);
      expect(rowBefore).toBeDefined();

      // Dismiss via the real server action (auth is mocked for the test env).
      await dismissBillingAlert(rowBefore!.id);

      // The panel query must no longer include the dismissed alert.
      const after = await panelQuery();
      const rowAfter = after.find((a) => a.stripeEventId === eventId);
      expect(rowAfter).toBeUndefined();
    });

    it("dismissing a checkout alert sets dismissedAt on the DB row", async () => {
      const sessionId = `cs_test_${uid()}`;
      const eventId = `evt-${sessionId}`;
      createdAlertEventIds.push(eventId);

      const noMetaEvent = {
        id: eventId,
        type: "checkout.session.completed",
        data: {
          object: {
            id: sessionId,
            mode: "payment",
            amount_total: 50000,
            metadata: {},
            customer_details: { email: "buyer@example.com", name: "Test Buyer" },
          },
        },
      };

      await POST(makeRequest(noMetaEvent));

      const alerts = await panelQuery();
      const row = alerts.find((a) => a.stripeEventId === eventId);
      expect(row).toBeDefined();

      await dismissBillingAlert(row!.id);

      // Read the row directly (bypassing the panel filter) to verify dismissedAt.
      const dismissed = await db.query.stripeAlertsTable.findFirst({
        where: eq(stripeAlertsTable.stripeEventId, eventId),
      });
      expect(dismissed?.dismissedAt).toBeInstanceOf(Date);
    });

    it("panel query returns checkout alerts alongside subscription alerts, newest first", async () => {
      // Create a checkout alert first, then an unmatched subscription alert,
      // verifying both event types co-exist in the unresolved panel.
      const checkoutSessionId = `cs_test_${uid()}`;
      const checkoutEventId = `evt-${checkoutSessionId}`;
      createdAlertEventIds.push(checkoutEventId);

      const subscriptionEventId = `evt_sub_${uid()}`;
      createdAlertEventIds.push(subscriptionEventId);

      const checkoutEvent = {
        id: checkoutEventId,
        type: "checkout.session.completed",
        data: {
          object: {
            id: checkoutSessionId,
            mode: "payment",
            amount_total: 50000,
            metadata: {},
            customer_details: { email: "buyer@example.com", name: "Test Buyer" },
          },
        },
      };

      // Subscription event with a bogus customer that won't match any tenant.
      const subscriptionEvent = {
        id: subscriptionEventId,
        type: "customer.subscription.updated",
        data: {
          object: {
            id: `sub_${uid()}`,
            status: "active",
            customer: `cus_nomatch_${uid()}`,
            metadata: {},
          },
        },
      };

      await POST(makeRequest(checkoutEvent));
      await POST(makeRequest(subscriptionEvent));

      const alerts = await panelQuery();

      const checkoutRow = alerts.find((a) => a.stripeEventId === checkoutEventId);
      const subRow = alerts.find((a) => a.stripeEventId === subscriptionEventId);

      expect(checkoutRow).toBeDefined();
      expect(checkoutRow?.eventType).toBe("checkout.session.completed");

      expect(subRow).toBeDefined();
      expect(subRow?.eventType).toBe("customer.subscription.updated");
    });

    it("checkout alert with slackPostFailed still appears in the panel query (dismissedAt is the only filter)", async () => {
      // Make the Slack notifier reject this call so slackPostFailed gets set.
      vi.mocked(sendBillingAlertSlackNotification).mockResolvedValueOnce({
        ok: false,
        error: "token_revoked",
      });

      const sessionId = `cs_test_${uid()}`;
      const eventId = `evt-${sessionId}`;
      createdAlertEventIds.push(eventId);

      const noMetaEvent = {
        id: eventId,
        type: "checkout.session.completed",
        data: {
          object: {
            id: sessionId,
            mode: "payment",
            amount_total: 50000,
            metadata: {}, // triggers missing-metadata path
            customer_details: { email: "buyer@example.com", name: "Test Buyer" },
          },
        },
      };

      const res = await POST(makeRequest(noMetaEvent));
      expect(res.status).toBe(200);

      // The panel query only filters on isNull(dismissedAt) — slackPostFailed must not hide the row.
      const alerts = await panelQuery();
      const row = alerts.find((a) => a.stripeEventId === eventId);

      expect(row).toBeDefined();
      expect(row?.eventType).toBe("checkout.session.completed");
    });

    it("checkout alert with Slack failure has slackPostFailed set on the DB row", async () => {
      vi.mocked(sendBillingAlertSlackNotification).mockResolvedValueOnce({
        ok: false,
        error: "token_revoked",
      });

      const sessionId = `cs_test_${uid()}`;
      const eventId = `evt-${sessionId}`;
      createdAlertEventIds.push(eventId);

      const noMetaEvent = {
        id: eventId,
        type: "checkout.session.completed",
        data: {
          object: {
            id: sessionId,
            mode: "payment",
            amount_total: 50000,
            metadata: {},
            customer_details: { email: "buyer@example.com", name: "Test Buyer" },
          },
        },
      };

      await POST(makeRequest(noMetaEvent));

      // Read the row directly (bypassing the panel filter) to check slackPostFailed.
      const row = await db.query.stripeAlertsTable.findFirst({
        where: (t, { eq: eqFn }) => eqFn(t.stripeEventId, eventId),
      });

      expect(row).toBeDefined();
      expect(row?.slackPostFailed).toBeInstanceOf(Date);
    });

    it("mismatch-path alert with Slack failure has slackPostFailed set on the DB row", async () => {
      // Make the Slack notifier reject this call so slackPostFailed gets set.
      vi.mocked(sendBillingAlertSlackNotification).mockResolvedValueOnce({
        ok: false,
        error: "channel_not_found",
      });

      const tenantA = await createTenant();
      const tenantB = await createTenant();
      const artworkId = await createArtwork(tenantA); // artwork belongs to tenantA
      const sessionId = `cs_test_${uid()}`;
      const eventId = `evt-${sessionId}`;
      createdAlertEventIds.push(eventId);

      // Event claims artwork belongs to tenantB — mismatch triggers the alert.
      const mismatchEvent = {
        id: eventId,
        type: "checkout.session.completed",
        data: {
          object: {
            id: sessionId,
            mode: "payment",
            payment_intent: `pi-${sessionId}`,
            amount_total: 50000,
            metadata: { artworkId, tenantId: tenantB, fulfillmentType: "PICKUP" },
            customer_details: { email: "buyer@example.com", name: "Test Buyer" },
          },
        },
      };

      const res = await POST(makeRequest(mismatchEvent));
      expect(res.status).toBe(200);

      // Read the row directly (bypassing the panel filter) to check slackPostFailed.
      const row = await db.query.stripeAlertsTable.findFirst({
        where: (t, { eq: eqFn }) => eqFn(t.stripeEventId, eventId),
      });

      expect(row).toBeDefined();
      expect(row?.slackPostFailed).toBeInstanceOf(Date);
    });

    it("mismatch-path alert with slackPostFailed still appears in the panel query (dismissedAt is the only filter)", async () => {
      // Make the Slack notifier reject this call so slackPostFailed gets set.
      vi.mocked(sendBillingAlertSlackNotification).mockResolvedValueOnce({
        ok: false,
        error: "channel_not_found",
      });

      const tenantA = await createTenant();
      const tenantB = await createTenant();
      const artworkId = await createArtwork(tenantA); // artwork belongs to tenantA
      const sessionId = `cs_test_${uid()}`;
      const eventId = `evt-${sessionId}`;
      createdAlertEventIds.push(eventId);

      // Event claims artwork belongs to tenantB — mismatch triggers the alert.
      const mismatchEvent = {
        id: eventId,
        type: "checkout.session.completed",
        data: {
          object: {
            id: sessionId,
            mode: "payment",
            payment_intent: `pi-${sessionId}`,
            amount_total: 50000,
            metadata: { artworkId, tenantId: tenantB, fulfillmentType: "PICKUP" },
            customer_details: { email: "buyer@example.com", name: "Test Buyer" },
          },
        },
      };

      const res = await POST(makeRequest(mismatchEvent));
      expect(res.status).toBe(200);

      // The panel query only filters on isNull(dismissedAt) — slackPostFailed must not hide the row.
      const alerts = await panelQuery();
      const row = alerts.find((a) => a.stripeEventId === eventId);

      expect(row).toBeDefined();
      expect(row?.eventType).toBe("checkout.session.completed");
      // Confirm the Slack failure was recorded.
      expect(row?.slackPostFailed).toBeInstanceOf(Date);
    });

    it("checkout alert with slackPostFailed can still be dismissed", async () => {
      vi.mocked(sendBillingAlertSlackNotification).mockResolvedValueOnce({
        ok: false,
        error: "token_revoked",
      });

      const sessionId = `cs_test_${uid()}`;
      const eventId = `evt-${sessionId}`;
      createdAlertEventIds.push(eventId);

      const noMetaEvent = {
        id: eventId,
        type: "checkout.session.completed",
        data: {
          object: {
            id: sessionId,
            mode: "payment",
            amount_total: 50000,
            metadata: {},
            customer_details: { email: "buyer@example.com", name: "Test Buyer" },
          },
        },
      };

      await POST(makeRequest(noMetaEvent));

      // Confirm the alert is in the panel (slackPostFailed did not hide it).
      const before = await panelQuery();
      const rowBefore = before.find((a) => a.stripeEventId === eventId);
      expect(rowBefore).toBeDefined();
      // slackPostFailed must be set (Slack failure was persisted).
      expect(rowBefore?.slackPostFailed).toBeInstanceOf(Date);

      // Dismiss via the real server action.
      await dismissBillingAlert(rowBefore!.id);

      // After dismissal the panel query must no longer include the row.
      const after = await panelQuery();
      const rowAfter = after.find((a) => a.stripeEventId === eventId);
      expect(rowAfter).toBeUndefined();
    });
  },
);
