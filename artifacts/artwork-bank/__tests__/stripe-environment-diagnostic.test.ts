/**
 * Tests for the operator-facing Stripe environment diagnostic:
 * - configured key + Connect enabled → full account metadata
 * - configured key + Connect not enabled → connectEnabled=false
 * - no credentials → not_configured with a plain-language message
 * - rejected/invalid key → invalid_key
 * Also verifies the tenant-facing connect_not_enabled banner clarifies that
 * the platform operator is handling it.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const state = vi.hoisted(() => ({
  accountsRetrieve: vi.fn(),
  accountsList: vi.fn(),
}));

vi.mock("stripe", () => ({
  default: class MockStripe {
    accounts = {
      retrieve: state.accountsRetrieve,
      list: state.accountsList,
    };
    constructor(_key: string) {}
  },
}));

import {
  getStripeEnvironmentDiagnostic,
  isConnectNotEnabledError,
} from "@/lib/stripe";

const ENV_KEYS = [
  "STRIPE_SECRET_KEY",
  "REPLIT_CONNECTORS_HOSTNAME",
  "REPL_IDENTITY",
  "WEB_REPL_RENEWAL",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  return () => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  };
});

function connectNotEnabledError() {
  return new Error(
    "You can only create new accounts if you've signed up for Connect.",
  );
}

describe("getStripeEnvironmentDiagnostic", () => {
  it("reports Connect enabled when connected accounts exist", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    state.accountsRetrieve.mockResolvedValue({
      id: "acct_platform123",
      livemode: false,
      business_profile: { name: "Artwork Bank Pty Ltd" },
    });
    state.accountsList.mockResolvedValue({ data: [{ id: "acct_child" }] });

    const diag = await getStripeEnvironmentDiagnostic();
    expect(diag).toEqual({
      status: "ok",
      accountId: "acct_platform123",
      accountName: "Artwork Bank Pty Ltd",
      livemode: false,
      connectStatus: "enabled",
    });
  });

  it("reports Connect status as unknown when the list succeeds but is empty", async () => {
    // Stripe returns an empty list for non-Connect platforms too, so an empty
    // result must NOT be asserted as "enabled".
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    state.accountsRetrieve.mockResolvedValue({
      id: "acct_platform123",
      livemode: false,
    });
    state.accountsList.mockResolvedValue({ data: [] });

    const diag = await getStripeEnvironmentDiagnostic();
    expect(diag).toMatchObject({ status: "ok", connectStatus: "unknown" });
  });

  it("reports Connect disabled when the Connect probe is rejected", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_live_dummy";
    state.accountsRetrieve.mockResolvedValue({
      id: "acct_platform123",
      livemode: true,
      business_profile: null,
      settings: { dashboard: { display_name: "artwork-bank" } },
    });
    state.accountsList.mockRejectedValue(connectNotEnabledError());

    const diag = await getStripeEnvironmentDiagnostic();
    expect(diag).toMatchObject({
      status: "ok",
      accountId: "acct_platform123",
      accountName: "artwork-bank",
      livemode: true,
      connectStatus: "disabled",
    });
  });

  it("reports Connect status as unknown when the probe fails for unrelated reasons", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    state.accountsRetrieve.mockResolvedValue({
      id: "acct_x",
      livemode: false,
    });
    state.accountsList.mockRejectedValue(new Error("Rate limit exceeded"));

    const diag = await getStripeEnvironmentDiagnostic();
    expect(diag).toMatchObject({ status: "ok", connectStatus: "unknown" });
  });

  it("returns not_configured when no credentials are available", async () => {
    const diag = await getStripeEnvironmentDiagnostic();
    expect(diag.status).toBe("not_configured");
    expect((diag as { message: string }).message).toMatch(/not configured/i);
    expect(state.accountsRetrieve).not.toHaveBeenCalled();
  });

  it("returns invalid_key when Stripe rejects the key", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_revoked";
    const authErr = Object.assign(new Error("Invalid API Key provided"), {
      type: "StripeAuthenticationError",
      statusCode: 401,
    });
    state.accountsRetrieve.mockRejectedValue(authErr);

    const diag = await getStripeEnvironmentDiagnostic();
    expect(diag.status).toBe("invalid_key");
    expect((diag as { message: string }).message).toMatch(/rejected|key/i);
  });

  it("returns unreachable (not invalid_key) on network/API failures", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_ok";
    state.accountsRetrieve.mockRejectedValue(
      Object.assign(new Error("Request timed out"), {
        type: "StripeConnectionError",
      }),
    );

    const diag = await getStripeEnvironmentDiagnostic();
    expect(diag.status).toBe("unreachable");
    expect((diag as { message: string }).message).toMatch(/reached|timed out/i);
  });

  it("never includes secret key material in the result", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_supersecret123";
    state.accountsRetrieve.mockResolvedValue({ id: "acct_x", livemode: false });
    state.accountsList.mockResolvedValue({ data: [] });

    const diag = await getStripeEnvironmentDiagnostic();
    expect(JSON.stringify(diag)).not.toContain("sk_test_supersecret123");
  });
});

describe("isConnectNotEnabledError", () => {
  it("classifies the Connect-not-enabled message", () => {
    expect(isConnectNotEnabledError(connectNotEnabledError())).toBe(true);
    expect(
      isConnectNotEnabledError(
        new Error("Connect is not enabled on this platform account"),
      ),
    ).toBe(true);
  });

  it("does not classify unrelated errors", () => {
    expect(isConnectNotEnabledError(new Error("Rate limit exceeded"))).toBe(
      false,
    );
    expect(isConnectNotEnabledError(null)).toBe(false);
  });
});

describe("tenant connect_not_enabled banner copy", () => {
  it("clarifies the issue is platform-side and needs no tenant action", () => {
    const src = readFileSync(
      join(__dirname, "..", "app", "(admin)", "settings", "page.tsx"),
      "utf8",
    );
    const bannerIdx = src.indexOf('stripe === "connect_not_enabled"');
    expect(bannerIdx).toBeGreaterThan(-1);
    const banner = src.slice(bannerIdx, bannerIdx + 800);
    expect(banner).toMatch(/platform operator/i);
    expect(banner).toMatch(/no action is needed/i);
  });
});
