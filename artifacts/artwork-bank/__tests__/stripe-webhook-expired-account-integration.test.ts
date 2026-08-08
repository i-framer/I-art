/**
 * Stripe webhook — checkout.session.expired + account.updated — real-DB integration.
 *
 * Uses STRIPE_WEBHOOK_DEV_BYPASS=true so the route accepts raw JSON bodies.
 *
 * checkout.session.expired (handleCheckoutExpired):
 *  1. RESERVED artwork → reverted to AVAILABLE when checkout expires.
 *  2. Artwork NOT in RESERVED status → unchanged (no accidental un-SOLD).
 *  3. Missing metadata → no DB write.
 *  4. A paid order already exists for the session → no revert (idempotent guard).
 *  5. Tenant mismatch → artwork unchanged (WHERE clause includes tenantId).
 *
 * account.updated (handleAccountUpdated):
 *  6. Known stripeAccountId → stripeChargesEnabled/stripePayoutsEnabled updated.
 *  7. Unknown account ID → 200 OK but no DB rows modified.
 *  8. charges_enabled=true payouts_enabled=false → persisted correctly.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  ordersTable,
  orderItemsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// Enable dev bypass (no Stripe signature required).
vi.stubEnv("STRIPE_WEBHOOK_DEV_BYPASS", "true");

vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return { ...actual, sendOrderConfirmation: vi.fn(), sendBillingAlertNotification: vi.fn() };
});
vi.mock("@/lib/slack", () => ({
  sendBillingAlertSlackNotification: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/base-url", () => ({
  getTenantUrl: vi.fn(() => "https://gallery.test/orders"),
}));
vi.mock("@/lib/iframer", () => ({
  createIFramerJob: vi.fn(async () => ({ ok: true })),
  IFramerError: class IFramerError extends Error {},
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (_key: string) => null, // no stripe-signature → dev-bypass path
  })),
}));

import { POST } from "@/app/api/stripe/webhook/route";

// ── DB helpers ────────────────────────────────────────────────────────────────
const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdOrderIds: string[] = [];

function uid() { return `${randomUUID()}-exp-${RUN}-${++seq}`; }

async function createTenant(opts: { stripeAccountId?: string } = {}) {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Expired Checkout Test Gallery",
    type: "ARTIST", billingExempt: true,
    stripeAccountId: opts.stripeAccountId ?? null,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string, status: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Expired Artwork", sku: `sku-${id}`, status,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createOrder(tenantId: string, artworkId: string, sessionId: string) {
  const id = uid();
  await db.insert(ordersTable).values({
    id, tenantId,
    buyerEmail: "buyer@example.com", buyerName: "Buyer",
    totalCents: 5000, status: "PAID", fulfillmentType: "PICKUP",
    stripeSessionId: sessionId,
  } as any);
  await db.insert(orderItemsTable).values({
    id: uid(), orderId: id, artworkId, tenantId,
    artworkTitle: "Expired Artwork", priceCents: 5000,
  } as any);
  createdOrderIds.push(id);
  return id;
}

async function cleanup() {
  for (const id of createdOrderIds.splice(0)) {
    await db.delete(orderItemsTable).where(eq(orderItemsTable.orderId, id)).catch(() => {});
    await db.delete(ordersTable).where(eq(ordersTable.id, id)).catch(() => {});
  }
  for (const id of createdArtworkIds.splice(0)) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

function expiredEvent(sessionId: string, artworkId: string, tenantId: string): object {
  return {
    id: `evt-${sessionId}`,
    type: "checkout.session.expired",
    data: {
      object: {
        id: sessionId,
        mode: "payment",
        metadata: { artworkId, tenantId },
      },
    },
  };
}

function makeRequest(event: object): Request {
  return new Request("http://localhost/api/stripe/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });
}

// ── checkout.session.expired tests ────────────────────────────────────────────

describeIntegration("checkout.session.expired — real-DB integration", () => {
  it("RESERVED artwork → reverted to AVAILABLE", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId, "RESERVED");
    const sessionId = `cs_exp_${uid()}`;

    const res = await POST(makeRequest(expiredEvent(sessionId, artworkId, tenantId)));
    expect(res.status).toBe(200);

    const art = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, artworkId) });
    expect(art?.status).toBe("AVAILABLE");
  });

  it("SOLD artwork → NOT reverted to AVAILABLE (status preserved)", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId, "SOLD");
    const sessionId = `cs_exp_${uid()}`;

    await POST(makeRequest(expiredEvent(sessionId, artworkId, tenantId)));

    const art = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, artworkId) });
    expect(art?.status).toBe("SOLD"); // unchanged
  });

  it("AVAILABLE artwork → unchanged", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId, "AVAILABLE");
    const sessionId = `cs_exp_${uid()}`;

    await POST(makeRequest(expiredEvent(sessionId, artworkId, tenantId)));

    const art = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, artworkId) });
    expect(art?.status).toBe("AVAILABLE"); // unchanged
  });

  it("paid order exists for the session → no revert (idempotent guard)", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId, "SOLD");
    const sessionId = `cs_exp_${uid()}`;
    await createOrder(tenantId, artworkId, sessionId);

    await POST(makeRequest(expiredEvent(sessionId, artworkId, tenantId)));

    const art = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, artworkId) });
    expect(art?.status).toBe("SOLD"); // not reverted
  });

  it("missing metadata → 200 OK; no DB write", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId, "RESERVED");
    const sessionId = `cs_exp_${uid()}`;
    const noMetaEvent = {
      id: `evt-${sessionId}`,
      type: "checkout.session.expired",
      data: { object: { id: sessionId, mode: "payment", metadata: {} } },
    };

    const res = await POST(makeRequest(noMetaEvent));
    expect(res.status).toBe(200);

    const art = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, artworkId) });
    expect(art?.status).toBe("RESERVED"); // unchanged
  });

  it("tenant mismatch → artwork unchanged", async () => {
    const tenantA = await createTenant();
    const tenantB = await createTenant();
    const artworkId = await createArtwork(tenantA, "RESERVED"); // belongs to tenantA
    const sessionId = `cs_exp_${uid()}`;
    // Event claims artwork belongs to tenantB — WHERE clause should exclude it.
    await POST(makeRequest(expiredEvent(sessionId, artworkId, tenantB)));

    const art = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, artworkId) });
    expect(art?.status).toBe("RESERVED"); // unchanged
  });
});

// ── account.updated tests ─────────────────────────────────────────────────────

describeIntegration("account.updated — real-DB integration", () => {
  function accountUpdatedEvent(
    stripeAccountId: string,
    chargesEnabled: boolean,
    payoutsEnabled: boolean,
  ): object {
    return {
      id: `evt-acct-${stripeAccountId}`,
      type: "account.updated",
      data: {
        object: {
          id: stripeAccountId,
          charges_enabled: chargesEnabled,
          payouts_enabled: payoutsEnabled,
        },
      },
    };
  }

  it("known stripeAccountId → stripeChargesEnabled/stripePayoutsEnabled updated", async () => {
    const acctId = `acct_test_${uid()}`;
    const tenantId = await createTenant({ stripeAccountId: acctId });

    const res = await POST(makeRequest(accountUpdatedEvent(acctId, true, true)));
    expect(res.status).toBe(200);

    const tenant = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, tenantId) });
    expect(tenant?.stripeChargesEnabled).toBe(true);
    expect(tenant?.stripePayoutsEnabled).toBe(true);
  });

  it("charges_enabled=true payouts_enabled=false → persisted correctly", async () => {
    const acctId = `acct_test_${uid()}`;
    const tenantId = await createTenant({ stripeAccountId: acctId });

    await POST(makeRequest(accountUpdatedEvent(acctId, true, false)));

    const tenant = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, tenantId) });
    expect(tenant?.stripeChargesEnabled).toBe(true);
    expect(tenant?.stripePayoutsEnabled).toBe(false);
  });

  it("unknown account ID → 200 OK; no DB rows modified", async () => {
    const knownTenantId = await createTenant({ stripeAccountId: `acct_known_${uid()}` });

    // Send an event for an account not in the DB.
    const res = await POST(makeRequest(accountUpdatedEvent(`acct_unknown_${uid()}`, true, true)));
    expect(res.status).toBe(200);

    // The known tenant's flags should remain at their defaults (false).
    const tenant = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, knownTenantId) });
    expect(tenant?.stripeChargesEnabled).toBeFalsy();
    expect(tenant?.stripePayoutsEnabled).toBeFalsy();
  });
});
