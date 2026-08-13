/**
 * Race-safety tests for artwork reservation during checkout:
 *  - two concurrent buyers → exactly one Stripe session, one 400 "not available"
 *  - a buyer hitting an already-RESERVED artwork is rejected without touching Stripe
 *  - a failed Stripe session creation releases the reservation (RESERVED → AVAILABLE)
 *  - the checkout.session.expired webhook reverts RESERVED → AVAILABLE only when
 *    no paid order exists, and never touches SOLD artworks
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Fake artwork row with an atomic conditional status update ───────────────
// Mirrors the DB's atomicity: the status check-and-set happens synchronously,
// so two overlapping requests can never both win the AVAILABLE → RESERVED swap.
const state = vi.hoisted(() => ({
  artwork: {
    id: "art-1",
    tenantId: "tenant-1",
    status: "AVAILABLE",
    showInGallery: true,
    title: "Sunset",
    medium: "Oil",
    sku: "SKU-1",
    price: 12_000,
  },
  reserveAttempts: 0,
  releaseAttempts: 0,
}));

vi.mock("@workspace/db", () => {
  // Atomic compare-and-swap on the fake row, keyed off the target status —
  // exactly the semantics of the route's conditional UPDATE ... WHERE status=...
  const cas = (vals: any): boolean => {
    if (vals.status === "RESERVED") {
      state.reserveAttempts++;
      if (state.artwork.status === "AVAILABLE" && state.artwork.showInGallery) {
        state.artwork.status = "RESERVED";
        return true;
      }
      return false;
    }
    if (vals.status === "AVAILABLE") {
      state.releaseAttempts++;
      if (state.artwork.status === "RESERVED") {
        state.artwork.status = "AVAILABLE";
        return true;
      }
      return false;
    }
    return false;
  };

  return {
    db: {
      query: {
        artworkImagesTable: { findFirst: vi.fn().mockResolvedValue(undefined) },
        ordersTable: { findFirst: vi.fn() },
        artworksTable: { findFirst: vi.fn() },
        tenantsTable: { findFirst: vi.fn() },
      },
      update: (_table: any) => ({
        set: (vals: any) => ({
          where: (_cond: any) => ({
            returning: () =>
              Promise.resolve(cas(vals) ? [{ ...state.artwork }] : []),
            // release path & webhook await the where() chain directly
            then: (onF: any, onR: any) =>
              Promise.resolve(cas(vals)).then(onF, onR),
          }),
        }),
      }),
      insert: vi.fn(),
      transaction: vi.fn(),
    },
    artworksTable: {
      id: "id",
      tenantId: "tenantId",
      status: "status",
      showInGallery: "showInGallery",
    },
    artworkImagesTable: { artworkId: "artworkId", isPrimary: "isPrimary" },
    ordersTable: { stripeSessionId: "stripeSessionId", id: "id" },
    orderItemsTable: {},
    tenantsTable: { id: "id" },
  };
});

vi.mock("@/lib/tenant-cache", () => ({
  getTenantBySlug: vi.fn(),
}));

vi.mock("@/lib/object-storage", () => ({
  getServeUrl: vi.fn().mockResolvedValue("https://img.example/x"),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue(true),
}));

const sessionsCreate = vi.hoisted(() => vi.fn());
const getStripeClient = vi.hoisted(() => vi.fn());
vi.mock("@/lib/stripe", () => ({
  getStripeClient: (...a: any[]) => getStripeClient(...a),
  getStripeWebhookSecret: vi.fn().mockResolvedValue(null),
  calcApplicationFee: vi.fn().mockReturnValue(600),
  calcApplicationFeeForTenant: vi.fn().mockReturnValue({ feeCents: 600, commissionBasisPoints: 500 }),
  StripeNotConfiguredError: class StripeNotConfiguredError extends Error {},
}));

vi.mock("@/lib/email", () => ({ sendOrderConfirmation: vi.fn() }));
vi.mock("@/lib/base-url", () => ({ getTenantUrl: vi.fn() }));
vi.mock("@/lib/iframer", () => ({
  createIFramerJob: vi.fn(),
  IFramerError: class IFramerError extends Error {},
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

import { db } from "@workspace/db";
import { getTenantBySlug } from "@/lib/tenant-cache";
import { POST as checkoutPOST } from "@/app/api/stripe/checkout/route";
import { POST as webhookPOST } from "@/app/api/stripe/webhook/route";

const tenant = {
  id: "tenant-1",
  storefrontEnabled: true,
  stripeAccountId: "acct_1",
  stripeChargesEnabled: true,
  type: "GALLERY",
  customDomain: null,
  customDomainVerified: false,
};

function checkoutRequest() {
  return new Request("http://localhost/api/stripe/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      artworkId: "art-1",
      slug: "gallery",
      fulfillmentType: "SHIP",
    }),
  });
}

function expiredWebhook() {
  return webhookPOST(
    new Request("http://localhost/api/stripe/webhook", {
      method: "POST",
      body: JSON.stringify({
        type: "checkout.session.expired",
        data: {
          object: {
            id: "cs_exp_1",
            metadata: { artworkId: "art-1", tenantId: "tenant-1" },
          },
        },
      }),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.artwork.status = "AVAILABLE";
  state.artwork.showInGallery = true;
  state.reserveAttempts = 0;
  state.releaseAttempts = 0;
  process.env.STRIPE_WEBHOOK_DEV_BYPASS = "true";
  vi.mocked(getTenantBySlug).mockResolvedValue(tenant as any);
  sessionsCreate.mockResolvedValue({ url: "https://stripe.test/session" });
  getStripeClient.mockResolvedValue({
    checkout: { sessions: { create: sessionsCreate } },
  });
  vi.mocked(db.query.ordersTable.findFirst).mockResolvedValue(undefined as any);
});

afterEach(() => {
  delete process.env.STRIPE_WEBHOOK_DEV_BYPASS;
});

describe("concurrent checkout reservation", () => {
  it("two simultaneous buyers → exactly one Stripe session and one 400", async () => {
    const [res1, res2] = await Promise.all([
      checkoutPOST(checkoutRequest()),
      checkoutPOST(checkoutRequest()),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([200, 400]);
    expect(sessionsCreate).toHaveBeenCalledTimes(1);

    const winner = res1.status === 200 ? res1 : res2;
    const loser = res1.status === 200 ? res2 : res1;
    expect((await winner.json()).url).toBe("https://stripe.test/session");
    expect((await loser.json()).error).toMatch(/not available/i);

    // Winner's session succeeded, so the artwork stays RESERVED for them.
    expect(state.artwork.status).toBe("RESERVED");
    expect(state.reserveAttempts).toBe(2); // both tried, only one won
  });

  it("rejects a buyer with 400 when the artwork is already RESERVED, without calling Stripe", async () => {
    state.artwork.status = "RESERVED";

    const res = await checkoutPOST(checkoutRequest());

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not available/i);
    expect(getStripeClient).not.toHaveBeenCalled();
    expect(sessionsCreate).not.toHaveBeenCalled();
    expect(state.artwork.status).toBe("RESERVED");
  });

  it("releases the reservation when Stripe session creation fails", async () => {
    sessionsCreate.mockRejectedValue(new Error("stripe exploded"));

    const res = await checkoutPOST(checkoutRequest());

    expect(res.status).toBe(500);
    expect(state.artwork.status).toBe("AVAILABLE");
    expect(state.releaseAttempts).toBe(1);
  });

  it("releases the reservation when the Stripe client cannot be created", async () => {
    const { StripeNotConfiguredError } = await import("@/lib/stripe");
    getStripeClient.mockRejectedValue(
      new (StripeNotConfiguredError as any)("no key"),
    );

    const res = await checkoutPOST(checkoutRequest());

    expect(res.status).toBe(503);
    expect(state.artwork.status).toBe("AVAILABLE");
  });
});

describe("checkout.session.expired webhook", () => {
  it("reverts RESERVED → AVAILABLE when no paid order exists", async () => {
    state.artwork.status = "RESERVED";

    const res = await expiredWebhook();

    expect(res.status).toBe(200);
    expect(state.artwork.status).toBe("AVAILABLE");
  });

  it("does NOT release the artwork when a paid order exists for the session", async () => {
    state.artwork.status = "RESERVED";
    vi.mocked(db.query.ordersTable.findFirst).mockResolvedValue({
      id: "order-1",
    } as any);

    const res = await expiredWebhook();

    expect(res.status).toBe(200);
    expect(state.artwork.status).toBe("RESERVED");
    expect(state.releaseAttempts).toBe(0);
  });

  it("never flips a SOLD artwork back to AVAILABLE", async () => {
    state.artwork.status = "SOLD";

    const res = await expiredWebhook();

    expect(res.status).toBe(200);
    expect(state.artwork.status).toBe("SOLD");
  });
});
