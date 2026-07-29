/**
 * Asserts that every outbound email function picks up its `from` address from
 * the configured environment variables and correctly honours the precedence
 * chain, so a rotated sender domain produces a visible failure rather than a
 * silent bounce — regardless of which mail transport (Resend or SMTP) is active.
 *
 * Precedence:
 *   Inquiry emails  — EMAIL_FROM_INQUIRIES > EMAIL_FROM > "onboarding@resend.dev"
 *   Order emails    — EMAIL_FROM_ORDERS    > EMAIL_FROM > "onboarding@resend.dev"
 *
 * Functions under test (from artifacts/artwork-bank/lib/email.ts):
 *   sendArtworkInquiry        — inquiry sender
 *   sendInquiryReply          — inquiry sender
 *   sendOrderStatusUpdate     — orders sender
 *   sendOrderConfirmation     — orders sender
 *   sendConfirmationFailureNotice — orders sender
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// base-url is lazily imported inside sendBillingAlertNotification only;
// mock it so any accidental import doesn't fail in this module.
vi.mock("@/lib/base-url", () => ({
  getPlatformBaseUrl: () => "https://platform.test",
  getTenantUrl: () => "https://tenant.test",
}));

import {
  sendArtworkInquiry,
  sendInquiryReply,
  sendOrderStatusUpdate,
  sendOrderConfirmation,
  sendConfirmationFailureNotice,
  EmailSendError,
} from "@/lib/email";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetch200() {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("{}", { status: 200 }));
}

function mockFetchError(status: number, body = "") {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(body, { status }));
}

function extractFrom(fetchSpy: ReturnType<typeof vi.spyOn>): string {
  const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
  return JSON.parse(init.body as string).from;
}

// Minimal valid argument bags for each function --------------------------

const inquiryArgs = {
  galleryEmail: "gallery@example.com",
  buyerName: "Alice",
  buyerEmail: "alice@example.com",
  message: "Is this available?",
  artworkTitle: "Sunset",
  artworkSku: "SKU-001",
  artworkUrl: "https://tenant.test/artworks/1",
  tenantName: "Gallery One",
};

const replyArgs = {
  buyerEmail: "alice@example.com",
  buyerName: "Alice",
  replyMessage: "Yes, still available.",
  originalMessage: "Is this available?",
  artworkTitle: "Sunset",
  tenantName: "Gallery One",
};

const statusUpdateArgs = {
  buyerEmail: "alice@example.com",
  buyerName: "Alice",
  artworkTitle: "Sunset",
  status: "FULFILLED",
  orderRef: "ORD-123",
  tenantName: "Gallery One",
};

const confirmationArgs = {
  buyerEmail: "alice@example.com",
  buyerName: "Alice",
  artworkTitle: "Sunset",
  fulfillmentType: "SHIP",
  orderRef: "ORD-123",
  tenantName: "Gallery One",
};

const failureNoticeArgs = {
  galleryEmail: "gallery@example.com",
  buyerEmail: "alice@example.com",
  buyerName: "Alice",
  artworkTitle: "Sunset",
  orderRef: "ORD-123",
  tenantName: "Gallery One",
};

// ---------------------------------------------------------------------------
// Shared env-var cleanup
// ---------------------------------------------------------------------------

const INQUIRY_VARS = ["EMAIL_FROM_INQUIRIES", "EMAIL_FROM", "RESEND_API_KEY"] as const;
const ORDER_VARS = ["EMAIL_FROM_ORDERS", "EMAIL_FROM", "RESEND_API_KEY"] as const;

function clearInquiryVars() {
  for (const k of INQUIRY_VARS) delete process.env[k];
}
function clearOrderVars() {
  for (const k of ORDER_VARS) delete process.env[k];
}

// SMTP vars must be cleared so tests always exercise the Resend path even
// when an SMTP_HOST is configured in the developer's shell or CI environment.
const SMTP_VARS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_SECURE"] as const;
const savedSmtp: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of SMTP_VARS) {
    savedSmtp[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of SMTP_VARS) {
    if (savedSmtp[k] === undefined) delete process.env[k];
    else process.env[k] = savedSmtp[k];
  }
});

// ===========================================================================
// sendArtworkInquiry — inquiry sender
// ===========================================================================

describe("sendArtworkInquiry: sender address (domain-rotation safety)", () => {
  beforeEach(() => {
    clearInquiryVars();
    process.env.RESEND_API_KEY = "re_test_key";
  });
  afterEach(() => {
    clearInquiryVars();
    vi.restoreAllMocks();
  });

  it("uses EMAIL_FROM_INQUIRIES when set", async () => {
    process.env.EMAIL_FROM_INQUIRIES = "inquiries@custom.com";
    const spy = mockFetch200();
    await sendArtworkInquiry(inquiryArgs);
    expect(extractFrom(spy)).toBe("inquiries@custom.com");
  });

  it("falls back to EMAIL_FROM when EMAIL_FROM_INQUIRIES is absent", async () => {
    process.env.EMAIL_FROM = "no-reply@shared.com";
    const spy = mockFetch200();
    await sendArtworkInquiry(inquiryArgs);
    expect(extractFrom(spy)).toBe("no-reply@shared.com");
  });

  it("falls back to the Resend sandbox default when neither var is set", async () => {
    const spy = mockFetch200();
    await sendArtworkInquiry(inquiryArgs);
    expect(extractFrom(spy)).toBe("onboarding@resend.dev");
  });

  it("EMAIL_FROM_INQUIRIES takes precedence over EMAIL_FROM", async () => {
    process.env.EMAIL_FROM_INQUIRIES = "inquiries@primary.com";
    process.env.EMAIL_FROM = "noreply@fallback.com";
    const spy = mockFetch200();
    await sendArtworkInquiry(inquiryArgs);
    expect(extractFrom(spy)).toBe("inquiries@primary.com");
  });
});

// ===========================================================================
// sendInquiryReply — inquiry sender
// ===========================================================================

describe("sendInquiryReply: sender address (domain-rotation safety)", () => {
  beforeEach(() => {
    clearInquiryVars();
    process.env.RESEND_API_KEY = "re_test_key";
  });
  afterEach(() => {
    clearInquiryVars();
    vi.restoreAllMocks();
  });

  it("uses EMAIL_FROM_INQUIRIES when set", async () => {
    process.env.EMAIL_FROM_INQUIRIES = "inquiries@custom.com";
    const spy = mockFetch200();
    await sendInquiryReply(replyArgs);
    expect(extractFrom(spy)).toBe("inquiries@custom.com");
  });

  it("falls back to EMAIL_FROM when EMAIL_FROM_INQUIRIES is absent", async () => {
    process.env.EMAIL_FROM = "no-reply@shared.com";
    const spy = mockFetch200();
    await sendInquiryReply(replyArgs);
    expect(extractFrom(spy)).toBe("no-reply@shared.com");
  });

  it("falls back to the Resend sandbox default when neither var is set", async () => {
    const spy = mockFetch200();
    await sendInquiryReply(replyArgs);
    expect(extractFrom(spy)).toBe("onboarding@resend.dev");
  });

  it("EMAIL_FROM_INQUIRIES takes precedence over EMAIL_FROM", async () => {
    process.env.EMAIL_FROM_INQUIRIES = "inquiries@primary.com";
    process.env.EMAIL_FROM = "noreply@fallback.com";
    const spy = mockFetch200();
    await sendInquiryReply(replyArgs);
    expect(extractFrom(spy)).toBe("inquiries@primary.com");
  });
});

// ===========================================================================
// sendOrderStatusUpdate — orders sender
// ===========================================================================

describe("sendOrderStatusUpdate: sender address (domain-rotation safety)", () => {
  beforeEach(() => {
    clearOrderVars();
    process.env.RESEND_API_KEY = "re_test_key";
  });
  afterEach(() => {
    clearOrderVars();
    vi.restoreAllMocks();
  });

  it("uses EMAIL_FROM_ORDERS when set", async () => {
    process.env.EMAIL_FROM_ORDERS = "orders@custom.com";
    const spy = mockFetch200();
    await sendOrderStatusUpdate(statusUpdateArgs);
    expect(extractFrom(spy)).toBe("orders@custom.com");
  });

  it("falls back to EMAIL_FROM when EMAIL_FROM_ORDERS is absent", async () => {
    process.env.EMAIL_FROM = "no-reply@shared.com";
    const spy = mockFetch200();
    await sendOrderStatusUpdate(statusUpdateArgs);
    expect(extractFrom(spy)).toBe("no-reply@shared.com");
  });

  it("falls back to the Resend sandbox default when neither var is set", async () => {
    const spy = mockFetch200();
    await sendOrderStatusUpdate(statusUpdateArgs);
    expect(extractFrom(spy)).toBe("onboarding@resend.dev");
  });

  it("EMAIL_FROM_ORDERS takes precedence over EMAIL_FROM", async () => {
    process.env.EMAIL_FROM_ORDERS = "orders@primary.com";
    process.env.EMAIL_FROM = "noreply@fallback.com";
    const spy = mockFetch200();
    await sendOrderStatusUpdate(statusUpdateArgs);
    expect(extractFrom(spy)).toBe("orders@primary.com");
  });
});

// ===========================================================================
// sendOrderConfirmation — orders sender
// ===========================================================================

describe("sendOrderConfirmation: sender address (domain-rotation safety)", () => {
  beforeEach(() => {
    clearOrderVars();
    process.env.RESEND_API_KEY = "re_test_key";
  });
  afterEach(() => {
    clearOrderVars();
    vi.restoreAllMocks();
  });

  it("uses EMAIL_FROM_ORDERS when set", async () => {
    process.env.EMAIL_FROM_ORDERS = "orders@custom.com";
    const spy = mockFetch200();
    await sendOrderConfirmation(confirmationArgs);
    expect(extractFrom(spy)).toBe("orders@custom.com");
  });

  it("falls back to EMAIL_FROM when EMAIL_FROM_ORDERS is absent", async () => {
    process.env.EMAIL_FROM = "no-reply@shared.com";
    const spy = mockFetch200();
    await sendOrderConfirmation(confirmationArgs);
    expect(extractFrom(spy)).toBe("no-reply@shared.com");
  });

  it("falls back to the Resend sandbox default when neither var is set", async () => {
    const spy = mockFetch200();
    await sendOrderConfirmation(confirmationArgs);
    expect(extractFrom(spy)).toBe("onboarding@resend.dev");
  });

  it("EMAIL_FROM_ORDERS takes precedence over EMAIL_FROM", async () => {
    process.env.EMAIL_FROM_ORDERS = "orders@primary.com";
    process.env.EMAIL_FROM = "noreply@fallback.com";
    const spy = mockFetch200();
    await sendOrderConfirmation(confirmationArgs);
    expect(extractFrom(spy)).toBe("orders@primary.com");
  });
});

// ===========================================================================
// sendConfirmationFailureNotice — orders sender
// ===========================================================================

describe("sendConfirmationFailureNotice: sender address (domain-rotation safety)", () => {
  beforeEach(() => {
    clearOrderVars();
    process.env.RESEND_API_KEY = "re_test_key";
  });
  afterEach(() => {
    clearOrderVars();
    vi.restoreAllMocks();
  });

  it("uses EMAIL_FROM_ORDERS when set", async () => {
    process.env.EMAIL_FROM_ORDERS = "orders@custom.com";
    const spy = mockFetch200();
    await sendConfirmationFailureNotice(failureNoticeArgs);
    expect(extractFrom(spy)).toBe("orders@custom.com");
  });

  it("falls back to EMAIL_FROM when EMAIL_FROM_ORDERS is absent", async () => {
    process.env.EMAIL_FROM = "no-reply@shared.com";
    const spy = mockFetch200();
    await sendConfirmationFailureNotice(failureNoticeArgs);
    expect(extractFrom(spy)).toBe("no-reply@shared.com");
  });

  it("falls back to the Resend sandbox default when neither var is set", async () => {
    const spy = mockFetch200();
    await sendConfirmationFailureNotice(failureNoticeArgs);
    expect(extractFrom(spy)).toBe("onboarding@resend.dev");
  });

  it("EMAIL_FROM_ORDERS takes precedence over EMAIL_FROM", async () => {
    process.env.EMAIL_FROM_ORDERS = "orders@primary.com";
    process.env.EMAIL_FROM = "noreply@fallback.com";
    const spy = mockFetch200();
    await sendConfirmationFailureNotice(failureNoticeArgs);
    expect(extractFrom(spy)).toBe("orders@primary.com");
  });
});

// ===========================================================================
// sendArtworkInquiry — email-send error handling (unverified domain / server error)
// ===========================================================================

describe("sendArtworkInquiry: email-send error handling", () => {
  beforeEach(() => {
    clearInquiryVars();
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.EMAIL_FROM_INQUIRIES = "inquiries@unverified-domain.com";
  });
  afterEach(() => {
    clearInquiryVars();
    vi.restoreAllMocks();
  });

  it("returns false (not true) when Resend responds 422 (domain not verified)", async () => {
    mockFetchError(422, JSON.stringify({ message: "The domain is not verified." }));
    const result = await sendArtworkInquiry(inquiryArgs);
    expect(result).toBe(false);
  });

  it("returns false when Resend responds 403 (invalid API key)", async () => {
    mockFetchError(403, JSON.stringify({ message: "API key is invalid." }));
    const result = await sendArtworkInquiry(inquiryArgs);
    expect(result).toBe(false);
  });

  it("returns false when Resend responds 500 (server error)", async () => {
    mockFetchError(500, "Internal Server Error");
    const result = await sendArtworkInquiry(inquiryArgs);
    expect(result).toBe(false);
  });

  it("returns false when fetch itself throws a network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network failure"));
    const result = await sendArtworkInquiry(inquiryArgs);
    expect(result).toBe(false);
  });
});

// ===========================================================================
// sendInquiryReply — email-send error handling (unverified domain / server error)
// ===========================================================================

describe("sendInquiryReply: email-send error handling", () => {
  beforeEach(() => {
    clearInquiryVars();
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.EMAIL_FROM_INQUIRIES = "inquiries@unverified-domain.com";
  });
  afterEach(() => {
    clearInquiryVars();
    vi.restoreAllMocks();
  });

  it("throws EmailSendError when Resend responds 422 (domain not verified)", async () => {
    mockFetchError(422, JSON.stringify({ message: "The domain is not verified." }));
    await expect(sendInquiryReply(replyArgs)).rejects.toThrow(EmailSendError);
  });

  it("thrown EmailSendError includes the HTTP status code for 422", async () => {
    mockFetchError(422, JSON.stringify({ message: "The domain is not verified." }));
    await expect(sendInquiryReply(replyArgs)).rejects.toThrow("422");
  });

  it("throws EmailSendError when Resend responds 403 (invalid API key)", async () => {
    mockFetchError(403, JSON.stringify({ message: "API key is invalid." }));
    await expect(sendInquiryReply(replyArgs)).rejects.toThrow(EmailSendError);
  });

  it("throws EmailSendError when Resend responds 500 (server error)", async () => {
    mockFetchError(500, "Internal Server Error");
    await expect(sendInquiryReply(replyArgs)).rejects.toThrow(EmailSendError);
  });

  it("throws EmailSendError when fetch itself throws a network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network failure"));
    await expect(sendInquiryReply(replyArgs)).rejects.toThrow(EmailSendError);
  });

  it("thrown EmailSendError wraps the original network error message", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network failure"));
    await expect(sendInquiryReply(replyArgs)).rejects.toThrow("network failure");
  });
});

// ===========================================================================
// sendOrderStatusUpdate — email-send error handling (unverified domain / server error)
// ===========================================================================

describe("sendOrderStatusUpdate: email-send error handling", () => {
  beforeEach(() => {
    clearOrderVars();
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.EMAIL_FROM_ORDERS = "orders@unverified-domain.com";
  });
  afterEach(() => {
    clearOrderVars();
    vi.restoreAllMocks();
  });

  it("throws EmailSendError when Resend responds 422 (domain not verified)", async () => {
    mockFetchError(422, JSON.stringify({ message: "The domain is not verified." }));
    await expect(sendOrderStatusUpdate(statusUpdateArgs)).rejects.toThrow(EmailSendError);
  });

  it("thrown EmailSendError includes the HTTP status code for 422", async () => {
    mockFetchError(422, JSON.stringify({ message: "The domain is not verified." }));
    await expect(sendOrderStatusUpdate(statusUpdateArgs)).rejects.toThrow("422");
  });

  it("throws EmailSendError when Resend responds 403 (invalid API key)", async () => {
    mockFetchError(403, JSON.stringify({ message: "API key is invalid." }));
    await expect(sendOrderStatusUpdate(statusUpdateArgs)).rejects.toThrow(EmailSendError);
  });

  it("thrown EmailSendError includes the HTTP status code for 403", async () => {
    mockFetchError(403, JSON.stringify({ message: "API key is invalid." }));
    await expect(sendOrderStatusUpdate(statusUpdateArgs)).rejects.toThrow("403");
  });

  it("throws EmailSendError when Resend responds 500 (server error)", async () => {
    mockFetchError(500, "Internal Server Error");
    await expect(sendOrderStatusUpdate(statusUpdateArgs)).rejects.toThrow(EmailSendError);
  });

  it("thrown EmailSendError includes the HTTP status code for 500", async () => {
    mockFetchError(500, "Internal Server Error");
    await expect(sendOrderStatusUpdate(statusUpdateArgs)).rejects.toThrow("500");
  });

  it("throws EmailSendError when fetch itself throws a network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network failure"));
    await expect(sendOrderStatusUpdate(statusUpdateArgs)).rejects.toThrow(EmailSendError);
  });
});

// ===========================================================================
// sendOrderConfirmation — email-send error handling (unverified domain / server error)
// ===========================================================================

describe("sendOrderConfirmation: email-send error handling", () => {
  beforeEach(() => {
    clearOrderVars();
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.EMAIL_FROM_ORDERS = "orders@unverified-domain.com";
  });
  afterEach(() => {
    clearOrderVars();
    vi.restoreAllMocks();
  });

  it("throws EmailSendError when Resend responds 422 (domain not verified)", async () => {
    mockFetchError(422, JSON.stringify({ message: "The domain is not verified." }));
    await expect(sendOrderConfirmation(confirmationArgs)).rejects.toThrow(EmailSendError);
  });

  it("thrown EmailSendError includes the HTTP status code for 422", async () => {
    mockFetchError(422, JSON.stringify({ message: "The domain is not verified." }));
    await expect(sendOrderConfirmation(confirmationArgs)).rejects.toThrow("422");
  });

  it("throws EmailSendError when Resend responds 403 (invalid API key)", async () => {
    mockFetchError(403, JSON.stringify({ message: "API key is invalid." }));
    await expect(sendOrderConfirmation(confirmationArgs)).rejects.toThrow(EmailSendError);
  });

  it("thrown EmailSendError includes the HTTP status code for 403", async () => {
    mockFetchError(403, JSON.stringify({ message: "API key is invalid." }));
    await expect(sendOrderConfirmation(confirmationArgs)).rejects.toThrow("403");
  });

  it("throws EmailSendError when Resend responds 500 (server error)", async () => {
    mockFetchError(500, "Internal Server Error");
    await expect(sendOrderConfirmation(confirmationArgs)).rejects.toThrow(EmailSendError);
  });

  it("thrown EmailSendError includes the HTTP status code for 500", async () => {
    mockFetchError(500, "Internal Server Error");
    await expect(sendOrderConfirmation(confirmationArgs)).rejects.toThrow("500");
  });

  it("throws EmailSendError when fetch itself throws a network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network failure"));
    await expect(sendOrderConfirmation(confirmationArgs)).rejects.toThrow(EmailSendError);
  });
});

// ===========================================================================
// sendConfirmationFailureNotice — email-send error handling (unverified domain / server error)
// ===========================================================================

describe("sendConfirmationFailureNotice: email-send error handling", () => {
  beforeEach(() => {
    clearOrderVars();
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.EMAIL_FROM_ORDERS = "orders@unverified-domain.com";
  });
  afterEach(() => {
    clearOrderVars();
    vi.restoreAllMocks();
  });

  it("throws EmailSendError when Resend responds 422 (domain not verified)", async () => {
    mockFetchError(422, JSON.stringify({ message: "The domain is not verified." }));
    await expect(sendConfirmationFailureNotice(failureNoticeArgs)).rejects.toThrow(EmailSendError);
  });

  it("thrown EmailSendError includes the HTTP status code for 422", async () => {
    mockFetchError(422, JSON.stringify({ message: "The domain is not verified." }));
    await expect(sendConfirmationFailureNotice(failureNoticeArgs)).rejects.toThrow("422");
  });

  it("throws EmailSendError when Resend responds 403 (invalid API key)", async () => {
    mockFetchError(403, JSON.stringify({ message: "API key is invalid." }));
    await expect(sendConfirmationFailureNotice(failureNoticeArgs)).rejects.toThrow(EmailSendError);
  });

  it("thrown EmailSendError includes the HTTP status code for 403", async () => {
    mockFetchError(403, JSON.stringify({ message: "API key is invalid." }));
    await expect(sendConfirmationFailureNotice(failureNoticeArgs)).rejects.toThrow("403");
  });

  it("throws EmailSendError when Resend responds 500 (server error)", async () => {
    mockFetchError(500, "Internal Server Error");
    await expect(sendConfirmationFailureNotice(failureNoticeArgs)).rejects.toThrow(EmailSendError);
  });

  it("thrown EmailSendError includes the HTTP status code for 500", async () => {
    mockFetchError(500, "Internal Server Error");
    await expect(sendConfirmationFailureNotice(failureNoticeArgs)).rejects.toThrow("500");
  });

  it("throws EmailSendError when fetch itself throws a network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network failure"));
    await expect(sendConfirmationFailureNotice(failureNoticeArgs)).rejects.toThrow(EmailSendError);
  });
});
