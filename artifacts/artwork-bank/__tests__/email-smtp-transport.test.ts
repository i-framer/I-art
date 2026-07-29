/**
 * Tests for the SMTP transport branch of lib/email.ts.
 *
 * When SMTP_HOST is set, emails must be delivered via nodemailer (own mail
 * server) instead of the Resend HTTP API — including correct port/secure/auth
 * derivation, replyTo mapping, and error propagation as EmailSendError.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/base-url", () => ({
  getPlatformBaseUrl: () => "https://platform.test",
  getTenantUrl: () => "https://tenant.test",
}));

const sendMailMock = vi.fn();
const createTransportMock = vi.fn(() => ({ sendMail: sendMailMock }));

vi.mock("nodemailer", () => ({
  default: { createTransport: createTransportMock },
}));

import {
  sendArtworkInquiry,
  sendInquiryReply,
  sendOrderConfirmation,
  EmailSendError,
} from "@/lib/email";

const inquiryArgs = {
  galleryEmail: "gallery@example.com",
  buyerEmail: "buyer@example.com",
  buyerName: "Buyer",
  message: "Is this available?",
  artworkTitle: "Sunset",
  artworkSku: "SKU-1",
  artworkUrl: "https://tenant.test/artworks/sku-1",
  tenantName: "Jane's Gallery",
};

const ENV_KEYS = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_SECURE",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "EMAIL_FROM_ORDERS",
  "EMAIL_FROM_INQUIRIES",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  sendMailMock.mockReset().mockResolvedValue({ messageId: "test" });
  createTransportMock.mockClear();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.restoreAllMocks();
});

describe("SMTP transport selection", () => {
  it("uses SMTP (not Resend) when SMTP_HOST is set, even if RESEND_API_KEY exists", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.RESEND_API_KEY = "re_test";
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const ok = await sendArtworkInquiry(inquiryArgs);

    expect(ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });

  it("derives default port 587 with secure=false and no auth when unset", async () => {
    process.env.SMTP_HOST = "smtp.example.com";

    await sendArtworkInquiry(inquiryArgs);

    expect(createTransportMock).toHaveBeenCalledWith({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      auth: undefined,
    });
  });

  it("derives secure=true for port 465 and passes auth from SMTP_USER/SMTP_PASS", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_PORT = "465";
    process.env.SMTP_USER = "orders@i-art.com.au";
    process.env.SMTP_PASS = "app-password";

    await sendArtworkInquiry(inquiryArgs);

    expect(createTransportMock).toHaveBeenCalledWith({
      host: "smtp.example.com",
      port: 465,
      secure: true,
      auth: { user: "orders@i-art.com.au", pass: "app-password" },
    });
  });

  it("honours explicit SMTP_SECURE override", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_PORT = "2525";
    process.env.SMTP_SECURE = "true";

    await sendArtworkInquiry(inquiryArgs);

    expect(createTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({ port: 2525, secure: true }),
    );
  });
});

describe("SMTP payload mapping", () => {
  it("maps replyTo and falls back to SMTP_USER as from-address", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_USER = "hello@i-art.com.au";

    await sendArtworkInquiry(inquiryArgs);

    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "hello@i-art.com.au",
        to: "gallery@example.com",
        replyTo: "buyer@example.com",
        subject: expect.stringContaining("Sunset"),
        html: expect.stringContaining("Sunset"),
      }),
    );
  });

  it("omits replyTo when the sender has none (order confirmation)", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.EMAIL_FROM = "orders@i-art.com.au";

    await sendOrderConfirmation({
      buyerEmail: "buyer@example.com",
      buyerName: "Buyer",
      artworkTitle: "Sunset",
      fulfillmentType: "SHIPPING",
      orderRef: "ORD-1",
      tenantName: "Jane's Gallery",
    });

    const payload = sendMailMock.mock.calls[0][0];
    expect(payload.from).toBe("orders@i-art.com.au");
    expect("replyTo" in payload).toBe(false);
  });
});

describe("SMTP-only (no Resend) order confirmation", () => {
  it("sends order confirmation via SMTP when only SMTP vars are set and Resend is absent", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.EMAIL_FROM = "orders@i-art.com.au";
    // Deliberately leave RESEND_API_KEY unset — this is the scenario under test.
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await sendOrderConfirmation({
      buyerEmail: "buyer@example.com",
      buyerName: "Buyer",
      artworkTitle: "Sunset",
      fulfillmentType: "SHIPPING",
      orderRef: "ORD-42",
      tenantName: "Jane's Gallery",
    });

    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("SMTP failure propagation", () => {
  it("throwing senders wrap SMTP failures in EmailSendError", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    sendMailMock.mockRejectedValue(new Error("535 Auth failed"));

    await expect(
      sendInquiryReply({
        buyerEmail: "buyer@example.com",
        buyerName: "Buyer",
        replyMessage: "Yes, available.",
        originalMessage: "Is this available?",
        artworkTitle: "Sunset",
        tenantName: "Jane's Gallery",
      }),
    ).rejects.toThrowError(EmailSendError);

    await expect(
      sendInquiryReply({
        buyerEmail: "buyer@example.com",
        buyerName: "Buyer",
        replyMessage: "Yes.",
        originalMessage: "?",
        artworkTitle: "Sunset",
        tenantName: "Jane's Gallery",
      }),
    ).rejects.toThrow(/SMTP error: 535 Auth failed/);
  });

  it("boolean senders return false on SMTP failure", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    sendMailMock.mockRejectedValue(new Error("connection refused"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const ok = await sendArtworkInquiry(inquiryArgs);

    expect(ok).toBe(false);
    expect(errSpy).toHaveBeenCalled();
  });
});
