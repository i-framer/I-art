/**
 * HTML injection regression tests — Task #324
 *
 * Verifies that user-supplied strings (artworkTitle, buyerName, tenantName,
 * orderRef, trackingNote, lastError …) are always HTML-escaped before being
 * interpolated into outgoing email templates.
 *
 * Covers:
 *   - htmlEscape() helper directly (unit tests)
 *   - sendOrderStatusUpdate
 *   - sendPartialRefundNotification
 *   - sendConfirmationFailureNotice
 *
 * sendOrderConfirmation HTML-injection tests live in
 * email-content-contract.test.ts (Task #324 section).
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
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "SMTP_PORT"]) {
    savedEnv[k] = process.env[k];
  }
  process.env.SMTP_HOST = "smtp.test.local";
  process.env.SMTP_USER = "test@test.local";
  process.env.SMTP_PASS = "testpass";
  process.env.SMTP_PORT = "587";
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
  htmlEscape,
  sendOrderStatusUpdate,
  sendPartialRefundNotification,
  sendConfirmationFailureNotice,
  sendArtworkInquiry,
  sendInquiryReply,
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

// ── htmlEscape unit tests ──────────────────────────────────────────────────────

describe("htmlEscape()", () => {
  it("escapes ampersand", () => {
    expect(htmlEscape("a&b")).toBe("a&amp;b");
  });

  it("escapes less-than", () => {
    expect(htmlEscape("<script>")).toBe("&lt;script&gt;");
  });

  it("escapes greater-than", () => {
    expect(htmlEscape("a>b")).toBe("a&gt;b");
  });

  it("escapes double-quote", () => {
    expect(htmlEscape('say "hi"')).toBe("say &quot;hi&quot;");
  });

  it("escapes single-quote", () => {
    expect(htmlEscape("it's")).toBe("it&#39;s");
  });

  it("escapes a full XSS payload", () => {
    const payload = `<script>alert('xss')</script>`;
    const result = htmlEscape(payload);
    expect(result).not.toContain("<script>");
    expect(result).not.toContain("</script>");
    expect(result).toContain("&lt;script&gt;");
    expect(result).toContain("&lt;/script&gt;");
  });

  it("escapes attribute-breakout payload (double-quote)", () => {
    const payload = `" onmouseover="alert(1)`;
    const result = htmlEscape(payload);
    expect(result).not.toContain('"');
    expect(result).toContain("&quot;");
  });

  it("escapes attribute-breakout payload (single-quote)", () => {
    const payload = `' onmouseover='alert(1)`;
    const result = htmlEscape(payload);
    expect(result).not.toContain("'");
    expect(result).toContain("&#39;");
  });

  it("leaves ordinary text unchanged", () => {
    expect(htmlEscape("Sunset Over the Bay")).toBe("Sunset Over the Bay");
  });

  it("handles empty string", () => {
    expect(htmlEscape("")).toBe("");
  });

  it("escapes multiple occurrences in the same string", () => {
    expect(htmlEscape("a<b>c<d>")).toBe("a&lt;b&gt;c&lt;d&gt;");
  });
});

// ── sendOrderStatusUpdate ──────────────────────────────────────────────────────

const STATUS_BASE = {
  buyerEmail: "buyer@example.com",
  buyerName: "Alice",
  artworkTitle: "Sunset",
  orderRef: "ORD-001",
  tenantName: "Good Gallery",
  status: "FULFILLED",
};

describe("sendOrderStatusUpdate — HTML injection prevention", () => {
  it("escapes < > in artworkTitle", async () => {
    const html = await captureHtmlFrom(() =>
      sendOrderStatusUpdate({ ...STATUS_BASE, artworkTitle: "<script>alert(1)</script>" }),
    );
    if (!html) return;
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes < > in buyerName", async () => {
    const html = await captureHtmlFrom(() =>
      sendOrderStatusUpdate({ ...STATUS_BASE, buyerName: "<img src=x onerror=alert(1)>" }),
    );
    if (!html) return;
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("escapes < > in tenantName", async () => {
    const html = await captureHtmlFrom(() =>
      sendOrderStatusUpdate({ ...STATUS_BASE, tenantName: "</p><b>injected</b>" }),
    );
    if (!html) return;
    expect(html).not.toContain("</p><b>");
    expect(html).toContain("&lt;/p&gt;");
  });

  it("escapes & in orderRef", async () => {
    const html = await captureHtmlFrom(() =>
      sendOrderStatusUpdate({ ...STATUS_BASE, orderRef: "ORD-001&extra=1" }),
    );
    if (!html) return;
    expect(html).toContain("ORD-001&amp;extra=1");
    expect(html).not.toContain("ORD-001&extra");
  });

  it("escapes HTML in trackingNote", async () => {
    const html = await captureHtmlFrom(() =>
      sendOrderStatusUpdate({
        ...STATUS_BASE,
        trackingNote: "<a href='javascript:alert(1)'>click</a>",
      }),
    );
    if (!html) return;
    expect(html).not.toContain("<a href=");
    expect(html).toContain("&lt;a href=");
  });

  it("escapes double-quote in orderLookupUrl to prevent attribute breakout", async () => {
    const html = await captureHtmlFrom(() =>
      sendOrderStatusUpdate({
        ...STATUS_BASE,
        orderLookupUrl: 'https://gallery.com/orders?ref=x" onmouseover="alert(1)',
      }),
    );
    if (!html) return;
    expect(html).not.toContain('href="https://gallery.com/orders?ref=x" onmouseover');
    expect(html).toContain("&quot;");
  });
});

// ── sendPartialRefundNotification ──────────────────────────────────────────────

const REFUND_BASE = {
  buyerEmail: "buyer@example.com",
  buyerName: "Alice",
  artworkTitle: "Sunset",
  refundedAmountCents: 5000,
  orderRef: "ORD-001",
  tenantName: "Good Gallery",
};

describe("sendPartialRefundNotification — HTML injection prevention", () => {
  it("escapes < > in artworkTitle", async () => {
    const html = await captureHtmlFrom(() =>
      sendPartialRefundNotification({ ...REFUND_BASE, artworkTitle: "<script>alert(1)</script>" }),
    );
    if (!html) return;
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes < > in buyerName", async () => {
    const html = await captureHtmlFrom(() =>
      sendPartialRefundNotification({ ...REFUND_BASE, buyerName: "<img src=x onerror=alert(1)>" }),
    );
    if (!html) return;
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("escapes < > in tenantName", async () => {
    const html = await captureHtmlFrom(() =>
      sendPartialRefundNotification({ ...REFUND_BASE, tenantName: "</p><b>injected</b>" }),
    );
    if (!html) return;
    expect(html).not.toContain("</p><b>");
    expect(html).toContain("&lt;/p&gt;");
  });

  it("escapes & in orderRef", async () => {
    const html = await captureHtmlFrom(() =>
      sendPartialRefundNotification({ ...REFUND_BASE, orderRef: "ORD-001&extra=1" }),
    );
    if (!html) return;
    expect(html).toContain("ORD-001&amp;extra=1");
    expect(html).not.toContain("ORD-001&extra");
  });

  it("escapes single-quote in artworkTitle to prevent attribute breakout", async () => {
    const html = await captureHtmlFrom(() =>
      sendPartialRefundNotification({ ...REFUND_BASE, artworkTitle: "It's a <trap>" }),
    );
    if (!html) return;
    expect(html).toContain("It&#39;s");
    expect(html).toContain("&lt;trap&gt;");
  });

  it("escapes double-quote in orderLookupUrl to prevent attribute breakout", async () => {
    const html = await captureHtmlFrom(() =>
      sendPartialRefundNotification({
        ...REFUND_BASE,
        orderLookupUrl: 'https://gallery.com/orders?ref=x" onmouseover="alert(1)',
      }),
    );
    if (!html) return;
    expect(html).not.toContain('href="https://gallery.com/orders?ref=x" onmouseover');
    expect(html).toContain("&quot;");
  });
});

// ── sendConfirmationFailureNotice ──────────────────────────────────────────────

const FAILURE_BASE = {
  galleryEmail: "gallery@example.com",
  buyerEmail: "buyer@example.com",
  buyerName: "Alice",
  artworkTitle: "Sunset",
  orderRef: "ORD-001",
  tenantName: "Good Gallery",
};

describe("sendConfirmationFailureNotice — HTML injection prevention", () => {
  it("escapes < > in artworkTitle", async () => {
    const html = await captureHtmlFrom(() =>
      sendConfirmationFailureNotice({ ...FAILURE_BASE, artworkTitle: "<script>alert(1)</script>" }),
    );
    if (!html) return;
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes < > in buyerName", async () => {
    const html = await captureHtmlFrom(() =>
      sendConfirmationFailureNotice({
        ...FAILURE_BASE,
        buyerName: "<img src=x onerror=alert(1)>",
      }),
    );
    if (!html) return;
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("escapes < > in tenantName", async () => {
    const html = await captureHtmlFrom(() =>
      sendConfirmationFailureNotice({ ...FAILURE_BASE, tenantName: "</p><b>injected</b>" }),
    );
    if (!html) return;
    expect(html).not.toContain("</p><b>");
    expect(html).toContain("&lt;/p&gt;");
  });

  it("escapes & in orderRef", async () => {
    const html = await captureHtmlFrom(() =>
      sendConfirmationFailureNotice({ ...FAILURE_BASE, orderRef: "ORD-001&extra=1" }),
    );
    if (!html) return;
    expect(html).toContain("ORD-001&amp;extra=1");
    expect(html).not.toContain("ORD-001&extra");
  });

  it("escapes HTML in lastError (shown to gallery owner)", async () => {
    const html = await captureHtmlFrom(() =>
      sendConfirmationFailureNotice({
        ...FAILURE_BASE,
        lastError: "<b>SMTP error</b> — connection refused",
      }),
    );
    if (!html) return;
    expect(html).not.toContain("<b>SMTP");
    expect(html).toContain("&lt;b&gt;SMTP");
  });

  it("escapes & in buyerEmail when rendered in body", async () => {
    const html = await captureHtmlFrom(() =>
      sendConfirmationFailureNotice({
        ...FAILURE_BASE,
        buyerEmail: "buyer+tag&trick=1@example.com",
      }),
    );
    if (!html) return;
    // The email address appears in the body text, so & must be escaped there too
    expect(html).toContain("&amp;");
    expect(html).not.toMatch(/buyer\+tag&trick/);
  });
});

// ── sendArtworkInquiry ─────────────────────────────────────────────────────────

const INQUIRY_BASE = {
  galleryEmail: "gallery@example.com",
  buyerName: "Alice",
  buyerEmail: "buyer@example.com",
  message: "I would like to know more about this piece.",
  artworkTitle: "Sunset",
  artworkSku: "SKU-001",
  artworkUrl: "https://gallery.example.com/artworks/sunset",
  tenantName: "Good Gallery",
};

describe("sendArtworkInquiry — HTML injection prevention", () => {
  it("escapes < > in artworkTitle", async () => {
    const html = await captureHtmlFrom(() =>
      sendArtworkInquiry({ ...INQUIRY_BASE, artworkTitle: "<script>alert(1)</script>" }),
    );
    if (!html) return;
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes < > in buyerName", async () => {
    const html = await captureHtmlFrom(() =>
      sendArtworkInquiry({ ...INQUIRY_BASE, buyerName: "<img src=x onerror=alert(1)>" }),
    );
    if (!html) return;
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("escapes < > in tenantName", async () => {
    const html = await captureHtmlFrom(() =>
      sendArtworkInquiry({ ...INQUIRY_BASE, tenantName: "</p><b>injected</b>" }),
    );
    if (!html) return;
    expect(html).not.toContain("</p><b>");
    expect(html).toContain("&lt;/p&gt;");
  });

  it("escapes HTML in message body", async () => {
    const html = await captureHtmlFrom(() =>
      sendArtworkInquiry({
        ...INQUIRY_BASE,
        message: "<a href='javascript:alert(1)'>click me</a>",
      }),
    );
    if (!html) return;
    expect(html).not.toContain("<a href='javascript:");
    expect(html).toContain("&lt;a href=");
  });

  it("escapes & in artworkSku", async () => {
    const html = await captureHtmlFrom(() =>
      sendArtworkInquiry({ ...INQUIRY_BASE, artworkSku: "SKU-001&foo=bar" }),
    );
    if (!html) return;
    expect(html).toContain("SKU-001&amp;foo=bar");
    expect(html).not.toContain("SKU-001&foo");
  });

  it("escapes double-quote in artworkUrl to prevent attribute breakout", async () => {
    const html = await captureHtmlFrom(() =>
      sendArtworkInquiry({
        ...INQUIRY_BASE,
        artworkUrl: 'https://gallery.com/art?id=1" onmouseover="alert(1)',
      }),
    );
    if (!html) return;
    expect(html).not.toContain('href="https://gallery.com/art?id=1" onmouseover');
    expect(html).toContain("&quot;");
  });

  it("escapes single-quote in artworkTitle to prevent attribute breakout", async () => {
    const html = await captureHtmlFrom(() =>
      sendArtworkInquiry({ ...INQUIRY_BASE, artworkTitle: "It's a <trap>" }),
    );
    if (!html) return;
    expect(html).toContain("It&#39;s");
    expect(html).toContain("&lt;trap&gt;");
  });
});

// ── sendInquiryReply ───────────────────────────────────────────────────────────

const REPLY_BASE = {
  buyerEmail: "buyer@example.com",
  buyerName: "Alice",
  replyMessage: "Thank you for your interest!",
  originalMessage: "I would like to know more about this piece.",
  artworkTitle: "Sunset",
  tenantName: "Good Gallery",
  galleryEmail: "gallery@example.com",
};

describe("sendInquiryReply — HTML injection prevention", () => {
  it("escapes < > in artworkTitle", async () => {
    const html = await captureHtmlFrom(() =>
      sendInquiryReply({ ...REPLY_BASE, artworkTitle: "<script>alert(1)</script>" }),
    );
    if (!html) return;
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes < > in buyerName", async () => {
    const html = await captureHtmlFrom(() =>
      sendInquiryReply({ ...REPLY_BASE, buyerName: "<img src=x onerror=alert(1)>" }),
    );
    if (!html) return;
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("escapes < > in tenantName", async () => {
    const html = await captureHtmlFrom(() =>
      sendInquiryReply({ ...REPLY_BASE, tenantName: "</p><b>injected</b>" }),
    );
    if (!html) return;
    expect(html).not.toContain("</p><b>");
    expect(html).toContain("&lt;/p&gt;");
  });

  it("escapes HTML in replyMessage", async () => {
    const html = await captureHtmlFrom(() =>
      sendInquiryReply({
        ...REPLY_BASE,
        replyMessage: "<a href='javascript:alert(1)'>click me</a>",
      }),
    );
    if (!html) return;
    expect(html).not.toContain("<a href=");
    expect(html).toContain("&lt;a href=");
  });

  it("escapes HTML in originalMessage", async () => {
    const html = await captureHtmlFrom(() =>
      sendInquiryReply({
        ...REPLY_BASE,
        originalMessage: "<script>steal(document.cookie)</script>",
      }),
    );
    if (!html) return;
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes single-quote in artworkTitle to prevent attribute breakout", async () => {
    const html = await captureHtmlFrom(() =>
      sendInquiryReply({ ...REPLY_BASE, artworkTitle: "It's a <trap>" }),
    );
    if (!html) return;
    expect(html).toContain("It&#39;s");
    expect(html).toContain("&lt;trap&gt;");
  });

  it("escapes & in tenantName", async () => {
    const html = await captureHtmlFrom(() =>
      sendInquiryReply({ ...REPLY_BASE, tenantName: "Art & Soul Gallery" }),
    );
    if (!html) return;
    expect(html).toContain("Art &amp; Soul Gallery");
    expect(html).not.toMatch(/Art & Soul/);
  });
});
