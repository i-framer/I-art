/**
 * No-transport guard tests — Task #345
 *
 * Verifies that inquiry emails fail loudly (not silently) when no email
 * transport is configured:
 *   - sendArtworkInquiry returns false (not true)
 *   - sendInquiryReply throws EmailSendError (not a generic Error)
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

// ── Environment setup — no transport configured ────────────────────────────────
const TRANSPORT_KEYS = ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "SMTP_PORT", "RESEND_API_KEY"];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of TRANSPORT_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
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
  sendArtworkInquiry,
  sendInquiryReply,
  EmailSendError,
} from "@/lib/email";

// ── Fixtures ───────────────────────────────────────────────────────────────────

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

const REPLY_BASE = {
  buyerEmail: "buyer@example.com",
  buyerName: "Alice",
  replyMessage: "Thank you for your interest!",
  originalMessage: "I would like to know more about this piece.",
  artworkTitle: "Sunset",
  tenantName: "Good Gallery",
  galleryEmail: "gallery@example.com",
};

// ── sendArtworkInquiry ─────────────────────────────────────────────────────────

describe("sendArtworkInquiry — no transport configured", () => {
  it("returns false (not true) when SMTP_HOST is absent", async () => {
    const result = await sendArtworkInquiry(INQUIRY_BASE);
    expect(result).toBe(false);
  });

  it("does not throw even when transport is missing", async () => {
    await expect(sendArtworkInquiry(INQUIRY_BASE)).resolves.not.toThrow();
  });

  it("does not call nodemailer when transport is missing", async () => {
    const nodemailer = await import("nodemailer");
    await sendArtworkInquiry(INQUIRY_BASE);
    expect(vi.mocked(nodemailer.default.createTransport)).not.toHaveBeenCalled();
  });
});

// ── sendInquiryReply ───────────────────────────────────────────────────────────

describe("sendInquiryReply — no transport configured", () => {
  it("throws EmailSendError (not a generic Error) when transport is missing", async () => {
    await expect(sendInquiryReply(REPLY_BASE)).rejects.toBeInstanceOf(EmailSendError);
  });

  it("throws with a message mentioning the missing transport", async () => {
    await expect(sendInquiryReply(REPLY_BASE)).rejects.toThrow(/no.*transport|transport.*not|not.*configured/i);
  });

  it("does not call nodemailer when transport is missing", async () => {
    const nodemailer = await import("nodemailer");
    await sendInquiryReply(REPLY_BASE).catch(() => {});
    expect(vi.mocked(nodemailer.default.createTransport)).not.toHaveBeenCalled();
  });
});
