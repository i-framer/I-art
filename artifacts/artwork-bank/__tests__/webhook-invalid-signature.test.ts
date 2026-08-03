/**
 * Stripe webhook — invalid signature and malformed payload handling.
 *
 * The webhook route must:
 *  - Return 400 when stripe-signature header is missing
 *  - Return 400 when the signature verification fails (wrong secret / tampered body)
 *  - Never propagate errors to the caller (return 4xx, not 5xx / crash)
 *  - Log the failure details for ops visibility
 *  - Return 200 for unrecognized event types (graceful ignore)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── DB mock ───────────────────────────────────────────────────────────────────
vi.mock("@workspace/db", () => ({
  db: {
    query: {
      tenantsTable: { findFirst: vi.fn().mockResolvedValue(null) },
      ordersTable: { findFirst: vi.fn().mockResolvedValue(null) },
      stripeAlertsTable: { findFirst: vi.fn().mockResolvedValue(null) },
    },
    insert: () => ({ values: vi.fn().mockResolvedValue(undefined) }),
    update: () => ({
      set: () => ({ where: vi.fn().mockResolvedValue(undefined) }),
    }),
    select: () => ({ from: () => ({ where: vi.fn().mockResolvedValue([]) }) }),
  },
  tenantsTable: {},
  ordersTable: {},
  artworksTable: {},
  orderItemsTable: {},
  stripeAlertsTable: {},
  eq: vi.fn(),
  and: vi.fn(),
  sql: vi.fn(),
}));

// ── Stripe mock ───────────────────────────────────────────────────────────────
const constructEvent = vi.hoisted(() => vi.fn());
vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn().mockResolvedValue({
    webhooks: { constructEvent },
  }),
  getStripeWebhookSecret: vi.fn().mockResolvedValue("whsec_test"),
  parsePlatformFeePercent: vi.fn().mockReturnValue(10),
  calcApplicationFee: vi.fn(),
  StripeNotConfiguredError: class extends Error {},
  isConnectNotEnabledError: vi.fn().mockReturnValue(false),
}));

// ── Email / Slack / iFramer / base-url mocks ──────────────────────────────────
vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: vi.fn().mockResolvedValue(undefined),
  sendBillingAlertNotification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/slack", () => ({
  sendBillingAlertSlackNotification: vi.fn().mockResolvedValue({ ok: true }),
  resolveSlackChannel: vi.fn().mockReturnValue(null),
}));
vi.mock("@/lib/billing", () => ({
  hasActiveAccess: vi.fn().mockReturnValue(true),
  SUBSCRIPTION_PRICE_CENTS: 4900,
}));
vi.mock("@/lib/base-url", () => ({
  getPlatformBaseUrl: vi.fn().mockReturnValue("https://platform.test"),
  getTenantUrl: vi.fn().mockReturnValue("https://tenant.test"),
}));
vi.mock("@/lib/iframer", () => ({
  createIFramerJob: vi.fn().mockResolvedValue({ jobId: "job-1" }),
  IFramerError: class extends Error {},
}));

// ── next/headers mock — follows the same pattern as webhook-routing.test.ts ───
const mockHeaders = vi.hoisted(() => vi.fn());
vi.mock("next/headers", () => ({ headers: () => mockHeaders() }));

// ── Route import ──────────────────────────────────────────────────────────────
import { POST } from "@/app/api/stripe/webhook/route";
import { getStripeWebhookSecret } from "@/lib/stripe";

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeRequest(body: string, sig?: string): Request {
  const h = new Headers({ "content-type": "application/json" });
  if (sig !== undefined) h.set("stripe-signature", sig);
  return new Request("http://localhost/api/stripe/webhook", {
    method: "POST",
    body,
    headers: h,
  });
}

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  // Ensure dev bypass is off — it may be set in the Replit workspace env
  savedEnv.DEV_BYPASS = process.env.STRIPE_WEBHOOK_DEV_BYPASS;
  delete process.env.STRIPE_WEBHOOK_DEV_BYPASS;
  // Default: valid stripe-signature header present
  mockHeaders.mockResolvedValue(new Headers({ "stripe-signature": "valid-sig" }));
  vi.mocked(getStripeWebhookSecret).mockResolvedValue("whsec_test");
});

afterEach(() => {
  if (savedEnv.DEV_BYPASS !== undefined)
    process.env.STRIPE_WEBHOOK_DEV_BYPASS = savedEnv.DEV_BYPASS;
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Stripe webhook — invalid signature / malformed payload", () => {
  it("returns 400 when stripe-signature header is missing", async () => {
    // Override: no stripe-signature header
    mockHeaders.mockResolvedValue(new Headers());

    const res = await POST(makeRequest('{"type":"checkout.session.completed"}'));

    expect(res.status).toBe(400);
  });

  it("returns 400 when signature verification throws (wrong secret)", async () => {
    const signatureError = new Error("No signatures found matching the expected signature");
    constructEvent.mockImplementationOnce(() => {
      throw signatureError;
    });

    const res = await POST(makeRequest('{"type":"checkout.session.completed"}'));

    expect(res.status).toBe(400);
  });

  it("does not expose internal error details in the response body", async () => {
    const signatureError = new Error("secret token: whsec_abc123XYZ");
    constructEvent.mockImplementationOnce(() => {
      throw signatureError;
    });

    const res = await POST(makeRequest('{"type":"checkout.session.completed"}'));
    const body = await res.json();

    expect(JSON.stringify(body)).not.toContain("whsec_abc123XYZ");
    expect(res.status).toBe(400);
  });

  it("returns 400 when both signature and webhook secret are absent", async () => {
    mockHeaders.mockResolvedValue(new Headers()); // no stripe-signature
    vi.mocked(getStripeWebhookSecret).mockResolvedValue(undefined); // no secret

    const res = await POST(makeRequest('{"type":"checkout.session.completed"}'));

    expect(res.status).toBe(400);
  });

  it("logs signature verification failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new Error("signature mismatch");
    constructEvent.mockImplementationOnce(() => { throw err; });

    await POST(makeRequest('{"type":"checkout.session.completed"}'));

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("signature"),
      expect.anything(),
    );
  });

  it("returns 200 for an unrecognized event type (unknown events are ignored)", async () => {
    constructEvent.mockReturnValueOnce({
      type: "some.unknown.event",
      id: "evt_test",
      data: { object: {} },
    });

    const res = await POST(makeRequest('{}'));

    expect([200, 204]).toContain(res.status);
  });
});
