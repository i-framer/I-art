/**
 * Regression tests: startStripeOnboarding must build the return_url and
 * refresh_url from the correct base URL so that Stripe lands the gallery back
 * on the right domain after Connect onboarding completes.
 *
 * getBillingBaseUrl() priority (highest → lowest):
 *   1. NEXT_PUBLIC_SITE_URL  — set on Vercel production
 *   2. VERCEL_URL            — set on Vercel preview deployments
 *   3. REPLIT_DOMAINS        — set in the Replit dev environment
 *   4. http://localhost:3000  — local fallback
 *
 * These tests also confirm that:
 * - stripeAccountId is saved to the DB before the Stripe redirect so the
 *   connected_account_id is persisted even if the user never returns.
 * - An existing stripeAccountId is reused (no duplicate account creation).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Hoisted state ────────────────────────────────────────────────────────────
const state = vi.hoisted(() => ({
  updates: [] as { table: any; vals: any; where: any }[],
  inserts: [] as { table: any; vals: any }[],
  tenantFindWhere: null as any,
  stripeAccountsCreate: vi.fn(),
  stripeAccountLinksCreate: vi.fn(),
}));

const tables = vi.hoisted(() => ({
  tenantsTable: { id: "tenants.id" },
}));

const tenantFindFirst = vi.hoisted(() => vi.fn());

// ── Mocks ────────────────────────────────────────────────────────────────────
vi.mock("@workspace/db", () => ({
  db: {
    query: {
      tenantsTable: {
        findFirst: (opts: any) => {
          state.tenantFindWhere = opts?.where;
          return tenantFindFirst(opts);
        },
      },
    },
    insert: vi.fn((table: any) => ({
      values: (vals: any) => {
        state.inserts.push({ table, vals });
        return Promise.resolve();
      },
    })),
    update: vi.fn((table: any) => ({
      set: (vals: any) => ({
        where: (where: any) => {
          state.updates.push({ table, vals, where });
          return Promise.resolve();
        },
      }),
    })),
  },
  tenantsTable: tables.tenantsTable,
  staffInvitesTable: {},
  tenantUsersTable: {},
}));

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({
    userId: "user-1",
    tenantId: "tenant-A",
    role: "owner",
  })),
  generateToken: () => "tok-123",
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(async () => ({
    accounts: { create: state.stripeAccountsCreate },
    accountLinks: { create: state.stripeAccountLinksCreate },
  })),
}));

// ── Saved env keys ───────────────────────────────────────────────────────────
const ENV_KEYS = [
  "NEXT_PUBLIC_SITE_URL",
  "VERCEL_URL",
  "REPLIT_DOMAINS",
] as const;

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  state.updates.length = 0;
  state.inserts.length = 0;
  state.tenantFindWhere = null;

  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  // Default Stripe stubs
  state.stripeAccountsCreate.mockResolvedValue({ id: "acct_new" });
  state.stripeAccountLinksCreate.mockResolvedValue({
    url: "https://connect.stripe.com/setup/e/xxx",
  });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

import { startStripeOnboarding } from "@/app/(admin)/settings/actions";

// ── getBillingBaseUrl: URL priority ──────────────────────────────────────────

describe("startStripeOnboarding — return_url base URL priority", () => {
  it("uses NEXT_PUBLIC_SITE_URL when set (Vercel production)", async () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://i-art.com.au";
    process.env.VERCEL_URL = "artwork-bank-abc.vercel.app"; // should be ignored
    process.env.REPLIT_DOMAINS = "abc.replit.dev";          // should be ignored

    tenantFindFirst.mockResolvedValue({
      id: "tenant-A",
      stripeAccountId: "acct_existing",
    });

    await expect(startStripeOnboarding()).rejects.toThrow("REDIRECT:");

    const linkCall = state.stripeAccountLinksCreate.mock.calls[0][0];
    expect(linkCall.return_url).toBe(
      "https://i-art.com.au/settings?stripe=connected",
    );
    expect(linkCall.refresh_url).toBe(
      "https://i-art.com.au/settings?stripe=refresh",
    );
  });

  it("uses https://VERCEL_URL when NEXT_PUBLIC_SITE_URL is absent (Vercel preview)", async () => {
    process.env.VERCEL_URL = "artwork-bank-preview-abc123.vercel.app";
    process.env.REPLIT_DOMAINS = "abc.replit.dev"; // should be ignored

    tenantFindFirst.mockResolvedValue({
      id: "tenant-A",
      stripeAccountId: "acct_existing",
    });

    await expect(startStripeOnboarding()).rejects.toThrow("REDIRECT:");

    const linkCall = state.stripeAccountLinksCreate.mock.calls[0][0];
    expect(linkCall.return_url).toBe(
      "https://artwork-bank-preview-abc123.vercel.app/settings?stripe=connected",
    );
    expect(linkCall.refresh_url).toBe(
      "https://artwork-bank-preview-abc123.vercel.app/settings?stripe=refresh",
    );
  });

  it("uses https://first-REPLIT_DOMAIN when only REPLIT_DOMAINS is set (Replit dev)", async () => {
    process.env.REPLIT_DOMAINS = "abc.replit.dev,def.replit.dev";

    tenantFindFirst.mockResolvedValue({
      id: "tenant-A",
      stripeAccountId: "acct_existing",
    });

    await expect(startStripeOnboarding()).rejects.toThrow("REDIRECT:");

    const linkCall = state.stripeAccountLinksCreate.mock.calls[0][0];
    expect(linkCall.return_url).toBe(
      "https://abc.replit.dev/settings?stripe=connected",
    );
    expect(linkCall.refresh_url).toBe(
      "https://abc.replit.dev/settings?stripe=refresh",
    );
  });

  it("falls back to http://localhost:3000 when no env vars are set", async () => {
    tenantFindFirst.mockResolvedValue({
      id: "tenant-A",
      stripeAccountId: "acct_existing",
    });

    await expect(startStripeOnboarding()).rejects.toThrow("REDIRECT:");

    const linkCall = state.stripeAccountLinksCreate.mock.calls[0][0];
    expect(linkCall.return_url).toBe(
      "http://localhost:3000/settings?stripe=connected",
    );
    expect(linkCall.refresh_url).toBe(
      "http://localhost:3000/settings?stripe=refresh",
    );
  });
});

// ── Account creation & persistence ──────────────────────────────────────────

describe("startStripeOnboarding — stripeAccountId persistence", () => {
  it("creates a new Express account and saves it to the DB before redirecting", async () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://i-art.com.au";
    state.stripeAccountsCreate.mockResolvedValue({ id: "acct_brand_new" });

    tenantFindFirst.mockResolvedValue({
      id: "tenant-A",
      stripeAccountId: null, // no existing account
    });

    await expect(startStripeOnboarding()).rejects.toThrow("REDIRECT:");

    // Account was created
    expect(state.stripeAccountsCreate).toHaveBeenCalledOnce();
    expect(state.stripeAccountsCreate.mock.calls[0][0]).toMatchObject({
      type: "express",
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
    });

    // stripeAccountId was persisted to DB
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].vals).toMatchObject({
      stripeAccountId: "acct_brand_new",
    });
    expect(JSON.stringify(state.updates[0].table)).toContain("tenants");

    // Redirect target is Stripe's onboarding URL
    const err = await startStripeOnboarding().catch((e: Error) => e);
    expect((err as Error).message).toMatch(
      /REDIRECT:https:\/\/connect\.stripe\.com/,
    );
  });

  it("reuses an existing stripeAccountId and does NOT create a new Stripe account", async () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://i-art.com.au";

    tenantFindFirst.mockResolvedValue({
      id: "tenant-A",
      stripeAccountId: "acct_already_exists",
    });

    await expect(startStripeOnboarding()).rejects.toThrow("REDIRECT:");

    // No new account created
    expect(state.stripeAccountsCreate).not.toHaveBeenCalled();

    // No DB update needed (account ID already saved)
    expect(state.updates).toHaveLength(0);

    // accountLinks.create was still called with the existing account
    expect(state.stripeAccountLinksCreate).toHaveBeenCalledOnce();
    expect(state.stripeAccountLinksCreate.mock.calls[0][0].account).toBe(
      "acct_already_exists",
    );
  });
});

// ── Redirect target ──────────────────────────────────────────────────────────

describe("startStripeOnboarding — redirect behaviour", () => {
  it("redirects to the Stripe accountLink URL, not back to settings", async () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://i-art.com.au";
    state.stripeAccountLinksCreate.mockResolvedValue({
      url: "https://connect.stripe.com/setup/e/unique123",
    });

    tenantFindFirst.mockResolvedValue({
      id: "tenant-A",
      stripeAccountId: "acct_existing",
    });

    const err = await startStripeOnboarding().catch((e: Error) => e);
    expect((err as Error).message).toBe(
      "REDIRECT:https://connect.stripe.com/setup/e/unique123",
    );
  });

  it("redirects to /settings?stripe=not_configured when Stripe client is unavailable", async () => {
    const { getStripeClient } = await import("@/lib/stripe");
    vi.mocked(getStripeClient).mockRejectedValueOnce(
      new Error("not configured"),
    );

    tenantFindFirst.mockResolvedValue({
      id: "tenant-A",
      stripeAccountId: null,
    });

    const err = await startStripeOnboarding().catch((e: Error) => e);
    expect((err as Error).message).toBe(
      "REDIRECT:/settings?stripe=not_configured",
    );
    expect(state.updates).toHaveLength(0);
  });
});
