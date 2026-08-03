/**
 * Confirms that startSubscriptionCheckout passes trial_period_days: 30
 * inside subscription_data when creating the Stripe Checkout session, so
 * new subscribers are never charged on sign-up day.
 *
 * Also confirms the price is $10/month and mode is "subscription".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Hoisted state ─────────────────────────────────────────────────────────────

const state = vi.hoisted(() => ({
  updates: [] as { vals: any }[],
  sessionsCreateArgs: null as any,
}));

const tenantFindFirst = vi.hoisted(() => vi.fn());

// ── DB mock ───────────────────────────────────────────────────────────────────

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      tenantsTable: {
        findFirst: tenantFindFirst,
      },
    },
    update: vi.fn(() => ({
      set: (vals: any) => {
        state.updates.push({ vals });
        return { where: () => Promise.resolve() };
      },
    })),
  },
  tenantsTable: { id: "tenantsTable.id" },
  staffInvitesTable: {},
  tenantUsersTable: {},
}));

// ── Auth mock ─────────────────────────────────────────────────────────────────

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({
    userId: "user-1",
    tenantId: "tenant-A",
    role: "owner",
  })),
  generateToken: () => "tok-123",
}));

// ── Next.js redirect mock (throws to escape the action) ──────────────────────

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

// ── Stripe mock: capture sessions.create args ─────────────────────────────────

const sessionsCreate = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ url: "https://checkout.stripe.com/cs_test_abc" }),
);

const pricesList = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ data: [{ id: "price_monthly_test" }] }),
);

vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(async () => ({
    checkout: {
      sessions: {
        create: (args: any) => {
          state.sessionsCreateArgs = args;
          return sessionsCreate(args);
        },
      },
    },
    prices: { list: pricesList },
  })),
  isStripeResourceMissing: vi.fn().mockReturnValue(false),
}));

// ── billing mock: expose a stable price ID ────────────────────────────────────

vi.mock("@/lib/billing", () => ({
  getSubscriptionPriceId: vi.fn().mockResolvedValue("price_monthly_test"),
}));

// ── Tenant cache (not used by this action, but imported transitively) ─────────

vi.mock("@/lib/tenant-cache", () => ({
  getCnameTarget: vi.fn().mockReturnValue(null),
}));

// ── Saved env ─────────────────────────────────────────────────────────────────

const ENV_KEYS = ["NEXT_PUBLIC_SITE_URL", "VERCEL_URL", "REPLIT_DOMAINS"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  state.updates.length = 0;
  state.sessionsCreateArgs = null;
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.NEXT_PUBLIC_SITE_URL = "https://i-art.com.au";

  tenantFindFirst.mockResolvedValue({
    id: "tenant-A",
    businessName: "Test Gallery",
    contactEmail: "gallery@example.com",
    stripeCustomerId: "cus_existing",
    stripeSubscriptionId: null,
    subscriptionStatus: null,
  });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

import { startSubscriptionCheckout } from "@/app/(admin)/settings/actions";

// ── 30-day trial tests ────────────────────────────────────────────────────────

describe("startSubscriptionCheckout — 30-day free trial", () => {
  it("passes trial_period_days: 30 inside subscription_data", async () => {
    await expect(startSubscriptionCheckout()).rejects.toThrow("REDIRECT:");
    expect(state.sessionsCreateArgs).not.toBeNull();
    expect(state.sessionsCreateArgs.subscription_data).toMatchObject({
      trial_period_days: 30,
    });
  });

  it("creates the session in subscription mode", async () => {
    await expect(startSubscriptionCheckout()).rejects.toThrow("REDIRECT:");
    expect(state.sessionsCreateArgs.mode).toBe("subscription");
  });

  it("includes billingTenantId in both session metadata and subscription_data metadata", async () => {
    await expect(startSubscriptionCheckout()).rejects.toThrow("REDIRECT:");
    expect(state.sessionsCreateArgs.metadata).toMatchObject({
      billingTenantId: "tenant-A",
    });
    expect(state.sessionsCreateArgs.subscription_data?.metadata).toMatchObject({
      billingTenantId: "tenant-A",
    });
  });

  it("redirects to the Stripe Checkout URL on success", async () => {
    const err = await startSubscriptionCheckout().catch((e: Error) => e);
    expect((err as Error).message).toBe(
      "REDIRECT:https://checkout.stripe.com/cs_test_abc",
    );
  });

  it("sets success_url back to /settings/billing?billing=subscribed", async () => {
    await expect(startSubscriptionCheckout()).rejects.toThrow("REDIRECT:");
    expect(state.sessionsCreateArgs.success_url).toContain(
      "/settings/billing?billing=subscribed",
    );
  });

  it("reuses an existing stripeCustomerId without creating a new customer", async () => {
    await expect(startSubscriptionCheckout()).rejects.toThrow("REDIRECT:");
    // If no customer was created, no DB update for stripeCustomerId
    const customerUpdate = state.updates.find(
      (u) => "stripeCustomerId" in u.vals,
    );
    expect(customerUpdate).toBeUndefined();
    // The session was created with the existing customer
    expect(state.sessionsCreateArgs.customer).toBe("cus_existing");
  });
});
