/**
 * Simple email helper using Resend API.
 * Gracefully skips sending if RESEND_API_KEY is not set (dev / testing).
 */

/** Thrown when a confirmation email cannot be sent; callers should persist the failure so it can be retried. */
export class EmailSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailSendError";
  }
}

const FULFILLMENT_TEXT: Record<string, string> = {
  SHIP: "Your artwork will be shipped to you. The gallery will be in touch with tracking details.",
  PICKUP: "You've chosen to collect in person. The gallery will contact you to arrange pickup.",
  FRAMING_JOB: "Your framing job has been received. The framer will contact you with next steps.",
};

/**
 * Send a buyer inquiry about an artwork to the gallery's contact email.
 * Returns true if the email was accepted by Resend, false otherwise.
 */
export async function sendArtworkInquiry({
  galleryEmail,
  buyerName,
  buyerEmail,
  message,
  artworkTitle,
  artworkSku,
  artworkUrl,
  tenantName,
}: {
  galleryEmail: string;
  buyerName: string;
  buyerEmail: string;
  message: string;
  artworkTitle: string;
  artworkSku: string;
  artworkUrl: string;
  tenantName: string;
}): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    console.log(
      `[Email skipped — RESEND_API_KEY not set] Inquiry about "${artworkTitle}" from ${buyerEmail} to ${galleryEmail}`,
    );
    return false;
  }

  const escapeHtml = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "inquiries@i-art.com.au",
        to: galleryEmail,
        reply_to: buyerEmail,
        subject: `Inquiry about "${artworkTitle}" (${artworkSku})`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
            <h2 style="color:#1c1917;">New artwork inquiry</h2>
            <p>A buyer has asked about <strong>${escapeHtml(artworkTitle)}</strong> (SKU ${escapeHtml(artworkSku)}) on your ${escapeHtml(tenantName)} storefront.</p>
            <div style="margin:24px 0;padding:16px;background:#f5f5f4;border-radius:8px;">
              <p style="margin:0 0 8px;"><strong>From:</strong> ${escapeHtml(buyerName)} &lt;${escapeHtml(buyerEmail)}&gt;</p>
              <p style="margin:0;white-space:pre-line;">${escapeHtml(message)}</p>
            </div>
            <p><a href="${escapeHtml(artworkUrl)}" style="color:#1c1917;">View the artwork</a></p>
            <p style="color:#78716c;font-size:14px;margin-top:24px;">
              Reply to this email to respond to the buyer directly.
            </p>
          </div>
        `,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`Resend error ${res.status}:`, body);
      return false;
    }
    return true;
  } catch (err) {
    console.error("Failed to send inquiry email:", err);
    return false;
  }
}

/**
 * Send a gallery's reply to a buyer inquiry.
 * Throws EmailSendError on failure so callers can surface it.
 */
export async function sendInquiryReply({
  buyerEmail,
  buyerName,
  replyMessage,
  originalMessage,
  artworkTitle,
  tenantName,
  galleryEmail,
}: {
  buyerEmail: string;
  buyerName: string;
  replyMessage: string;
  originalMessage: string;
  artworkTitle: string;
  tenantName: string;
  /** Gallery contact email used as reply-to, if available. */
  galleryEmail?: string | null;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    throw new EmailSendError(
      "RESEND_API_KEY is not configured — reply not sent.",
    );
  }

  const escapeHtml = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "inquiries@i-art.com.au",
        to: buyerEmail,
        ...(galleryEmail ? { reply_to: galleryEmail } : {}),
        subject: `Re: Inquiry about "${artworkTitle}" — ${tenantName}`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
            <p>Hi ${escapeHtml(buyerName)},</p>
            <p><strong>${escapeHtml(tenantName)}</strong> has replied to your inquiry about <strong>${escapeHtml(artworkTitle)}</strong>:</p>
            <div style="margin:24px 0;padding:16px;background:#f5f5f4;border-radius:8px;">
              <p style="margin:0;white-space:pre-line;">${escapeHtml(replyMessage)}</p>
            </div>
            <p style="color:#78716c;font-size:13px;">Your original message:</p>
            <blockquote style="margin:0 0 24px;padding:12px 16px;border-left:3px solid #e7e5e4;color:#78716c;font-size:13px;white-space:pre-line;">${escapeHtml(originalMessage)}</blockquote>
            <p style="color:#78716c;font-size:14px;">
              Reply to this email to continue the conversation with ${escapeHtml(tenantName)}.
            </p>
          </div>
        `,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new EmailSendError(
        `Resend error ${res.status}${body ? `: ${body.slice(0, 300)}` : ""}`,
      );
    }
  } catch (err) {
    if (err instanceof EmailSendError) throw err;
    throw new EmailSendError(
      `Failed to send reply email: ${(err as any)?.message ?? String(err)}`,
    );
  }
}

/**
 * Send a buyer an order status update (fulfilled and/or tracking note changed).
 * Throws EmailSendError on failure so callers can record it for the retry sweep.
 */
export async function sendOrderStatusUpdate({
  buyerEmail,
  buyerName,
  artworkTitle,
  status,
  trackingNote,
  orderRef,
  tenantName,
  orderLookupUrl,
}: {
  buyerEmail: string;
  buyerName: string | null;
  artworkTitle: string;
  status: string;
  trackingNote?: string | null;
  orderRef: string;
  tenantName: string;
  /** Absolute URL of the guest order-status lookup page, if available. */
  orderLookupUrl?: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    throw new EmailSendError(
      "RESEND_API_KEY is not configured — status update email not sent.",
    );
  }

  const escapeHtml = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const isFulfilled = status === "FULFILLED";
  const heading = isFulfilled ? "Your order is on its way" : "Order update";
  const statusLine = isFulfilled
    ? `Good news — your order for <strong>${escapeHtml(artworkTitle)}</strong> from <strong>${escapeHtml(tenantName)}</strong> has been marked as fulfilled.`
    : `There's an update on your order for <strong>${escapeHtml(artworkTitle)}</strong> from <strong>${escapeHtml(tenantName)}</strong>.`;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "orders@i-art.com.au",
        to: buyerEmail,
        subject: `Order update — ${artworkTitle}`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
            <h2 style="color:#1c1917;">${heading}</h2>
            <p>Hi ${escapeHtml(buyerName ?? "there")},</p>
            <p>${statusLine}</p>
            ${
              trackingNote
                ? `<div style="margin:24px 0;padding:16px;background:#f5f5f4;border-radius:8px;">
                     <p style="margin:0 0 8px;"><strong>Tracking / delivery note</strong></p>
                     <p style="margin:0;white-space:pre-line;">${escapeHtml(trackingNote)}</p>
                   </div>`
                : ""
            }
            <p style="margin-top:24px;padding:16px;background:#f5f5f4;border-radius:8px;">
              Order reference: <code style="font-family:monospace;">${escapeHtml(orderRef)}</code>
            </p>
            ${
              orderLookupUrl
                ? `<p>You can check your order status any time — no account needed: <a href="${escapeHtml(orderLookupUrl)}" style="color:#1c1917;">Check order status</a> (use this email address and your order reference).</p>`
                : ""
            }
            <p style="color:#78716c;font-size:14px;margin-top:24px;">
              Thank you for supporting ${escapeHtml(tenantName)}.
            </p>
          </div>
        `,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new EmailSendError(
        `Resend error ${res.status}${body ? `: ${body.slice(0, 300)}` : ""}`,
      );
    }
  } catch (err) {
    if (err instanceof EmailSendError) throw err;
    throw new EmailSendError(
      `Failed to send status update email: ${(err as any)?.message ?? String(err)}`,
    );
  }
}

export async function sendOrderConfirmation({
  buyerEmail,
  buyerName,
  artworkTitle,
  fulfillmentType,
  orderRef,
  tenantName,
  orderLookupUrl,
}: {
  buyerEmail: string;
  buyerName: string | null;
  artworkTitle: string;
  fulfillmentType: string;
  orderRef: string;
  tenantName: string;
  /** Absolute URL of the guest order-status lookup page, if available. */
  orderLookupUrl?: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    // Throw so callers record the miss (emailError) instead of silently
    // dropping the buyer's confirmation — it can be re-sent once configured.
    throw new EmailSendError(
      "RESEND_API_KEY is not configured — confirmation email not sent.",
    );
  }

  const fulfillmentText =
    FULFILLMENT_TEXT[fulfillmentType] ?? "The gallery will be in touch with next steps.";

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "orders@i-art.com.au",
        to: buyerEmail,
        subject: `Order confirmed — ${artworkTitle}`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
            <h2 style="color:#1c1917;">Order Confirmed ✓</h2>
            <p>Hi ${buyerName ?? "there"},</p>
            <p>Your order for <strong>${artworkTitle}</strong> from <strong>${tenantName}</strong> has been confirmed.</p>
            <p>${fulfillmentText}</p>
            <p style="margin-top:24px;padding:16px;background:#f5f5f4;border-radius:8px;">
              Order reference: <code style="font-family:monospace;">${orderRef}</code>
            </p>
            ${
              orderLookupUrl
                ? `<p>You can check your order status any time — no account needed: <a href="${orderLookupUrl}" style="color:#1c1917;">Check order status</a> (use this email address and your order reference).</p>`
                : ""
            }
            <p style="color:#78716c;font-size:14px;margin-top:24px;">
              Thank you for supporting ${tenantName}.
            </p>
          </div>
        `,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new EmailSendError(
        `Resend error ${res.status}${body ? `: ${body.slice(0, 300)}` : ""}`,
      );
    }
  } catch (err) {
    if (err instanceof EmailSendError) throw err;
    throw new EmailSendError(
      `Failed to send confirmation email: ${(err as any)?.message ?? String(err)}`,
    );
  }
}
