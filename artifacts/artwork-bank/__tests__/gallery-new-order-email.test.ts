import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(),
  },
}));

import nodemailer from "nodemailer";
import {
  EmailSendError,
  sendGalleryNewOrderNotification,
} from "@/lib/email";

const savedEnv: Record<string, string | undefined> = {};

const BASE_PARAMS = {
  galleryEmail: "orders@gallery.example",
  buyerEmail: "buyer@example.com",
  buyerName: "Alex Buyer",
  artworkTitle: "Harbour Light",
  artworkSku: "HL-101",
  totalCents: 42500,
  fulfillmentType: "SHIP",
  orderRef: "A1B2C3D4",
  tenantName: "Harbour Gallery",
  orderAdminUrl: "https://artwork-bank.example/orders/order-123",
};

beforeEach(() => {
  for (const key of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "SMTP_PORT"]) {
    savedEnv[key] = process.env[key];
  }
  process.env.SMTP_HOST = "smtp.test.local";
  process.env.SMTP_USER = "orders@test.local";
  process.env.SMTP_PASS = "testpass";
  process.env.SMTP_PORT = "587";
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const key of Object.keys(savedEnv)) delete savedEnv[key];
  vi.clearAllMocks();
});

async function captureDelivery() {
  const sendMail = vi.fn().mockResolvedValue({ messageId: "test-message" });
  vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail } as any);
  await sendGalleryNewOrderNotification(BASE_PARAMS);
  return sendMail.mock.calls[0]![0] as {
    to: string;
    replyTo?: string;
    subject: string;
    html: string;
  };
}

describe("sendGalleryNewOrderNotification", () => {
  it("sends fulfilment-safe order context to the gallery contact email", async () => {
    const delivery = await captureDelivery();

    expect(delivery.to).toBe("orders@gallery.example");
    expect(delivery.replyTo).toBe("buyer@example.com");
    expect(delivery.subject).toContain("New order");
    expect(delivery.html).toContain("Harbour Light");
    expect(delivery.html).toContain("HL-101");
    expect(delivery.html).toContain("Alex Buyer");
    expect(delivery.html).toContain("buyer@example.com");
    expect(delivery.html).toContain("A1B2C3D4");
    expect(delivery.html).toContain("425.00");
    expect(delivery.html).toContain("Ship to buyer");
    expect(delivery.html).toContain(BASE_PARAMS.orderAdminUrl);
    expect(delivery.html).not.toContain("payment_intent");
    expect(delivery.html).not.toContain("stripe");
  });

  it("escapes gallery-visible customer and artwork content", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "test-message" });
    vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail } as any);

    await sendGalleryNewOrderNotification({
      ...BASE_PARAMS,
      buyerName: "<img src=x onerror=alert(1)>",
      artworkTitle: "<script>alert(1)</script>",
    });

    const html = sendMail.mock.calls[0]![0].html as string;
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
  });

  it("removes line breaks from subject content", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "test-message" });
    vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail } as any);

    await sendGalleryNewOrderNotification({
      ...BASE_PARAMS,
      artworkTitle: "Harbour Light\r\nBcc: attacker@example.com",
    });

    const subject = sendMail.mock.calls[0]![0].subject as string;
    expect(subject).not.toContain("\r");
    expect(subject).not.toContain("\n");
    expect(subject).toContain("Harbour Light Bcc: attacker@example.com");
  });

  it("throws a recordable error when no transport is configured", async () => {
    delete process.env.SMTP_HOST;
    delete process.env.RESEND_API_KEY;

    await expect(
      sendGalleryNewOrderNotification(BASE_PARAMS),
    ).rejects.toBeInstanceOf(EmailSendError);
  });
});