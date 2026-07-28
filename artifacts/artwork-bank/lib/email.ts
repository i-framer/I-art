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

/**
 * Sender addresses come from configuration so the platform can run on any
 * domain without failing DMARC/SPF:
 * - EMAIL_FROM_INQUIRIES / EMAIL_FROM_ORDERS — per-purpose overrides
 * - EMAIL_FROM — shared fallback for both
 * - "onboarding@resend.dev" — Resend's sandbox sender (dev/testing only)
 */
function getInquiriesFrom(): string {
  return (
    process.env.EMAIL_FROM_INQUIRIES ??
    process.env.EMAIL_FROM ??
    "onboarding@resend.dev"
  );
}

function getOrdersFrom(): string {
  return (
    process.env.EMAIL_FROM_ORDERS ??
    process.env.EMAIL_FROM ??
    "onboarding@resend.dev"
  );
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
        from: getInquiriesFrom(),
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
        from: getInquiriesFrom(),
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
        from: getOrdersFrom(),
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

/**
 * Notify the gallery that a buyer's confirmation email could not be delivered
 * after all automatic retries. Throws EmailSendError on failure so callers
 * can leave the "notified" flag unset and try again next sweep.
 */
export async function sendConfirmationFailureNotice({
  galleryEmail,
  buyerEmail,
  buyerName,
  artworkTitle,
  orderRef,
  tenantName,
  lastError,
}: {
  galleryEmail: string;
  buyerEmail: string;
  buyerName: string | null;
  artworkTitle: string;
  orderRef: string;
  tenantName: string;
  /** The last delivery error recorded, if available. */
  lastError?: string | null;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    throw new EmailSendError(
      "RESEND_API_KEY is not configured — failure notice not sent.",
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
        from: getOrdersFrom(),
        to: galleryEmail,
        subject: `Action needed — buyer confirmation email failed (order ${orderRef})`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
            <h2 style="color:#1c1917;">Buyer confirmation email could not be delivered</h2>
            <p>We tried several times to send the order confirmation for <strong>${escapeHtml(artworkTitle)}</strong> on your ${escapeHtml(tenantName)} storefront, but every attempt failed. Automatic retries have stopped.</p>
            <div style="margin:24px 0;padding:16px;background:#f5f5f4;border-radius:8px;">
              <p style="margin:0 0 8px;"><strong>Order reference:</strong> <code style="font-family:monospace;">${escapeHtml(orderRef)}</code></p>
              <p style="margin:0 0 8px;"><strong>Buyer:</strong> ${escapeHtml(buyerName ?? "Unknown")} &lt;${escapeHtml(buyerEmail)}&gt;</p>
              ${
                lastError
                  ? `<p style="margin:0;color:#78716c;font-size:13px;"><strong>Last error:</strong> ${escapeHtml(lastError.slice(0, 300))}</p>`
                  : ""
              }
            </div>
            <p>Please contact the buyer directly to confirm their order, or re-send the confirmation from your admin order page.</p>
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
      `Failed to send failure notice email: ${(err as any)?.message ?? String(err)}`,
    );
  }
}

/**
 * Notify the platform operator when an unmatched Stripe event is saved as a
 * billing alert. Failures are logged but must not affect the webhook response —
 * the alert row is already committed before this is called.
 *
 * Uses EMAIL_FROM_ORDERS (or EMAIL_FROM) as the sender address so it shares
 * the same validated domain as other platform emails.
 */
export async function sendBillingAlertNotification({
  stripeEventId,
  eventType,
  customerId,
  subscriptionId,
  reason,
}: {
  stripeEventId: string;
  eventType: string;
  customerId?: string | null;
  subscriptionId?: string | null;
  reason: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const adminEmail = process.env.PLATFORM_ADMIN_EMAIL;

  if (!apiKey || !adminEmail) {
    console.log(
      `[Billing alert email skipped — ${!apiKey ? "RESEND_API_KEY" : "PLATFORM_ADMIN_EMAIL"} not set] ` +
        `eventId=${stripeEventId}`,
    );
    return;
  }

  // Import lazily to avoid circular deps and to keep the module lightweight.
  const { getPlatformBaseUrl } = await import("@/lib/base-url");
  const baseUrl = getPlatformBaseUrl();
  const billingAlertsUrl = baseUrl ? `${baseUrl}/platform` : null;

  const stripeDashboardUrl = `https://dashboard.stripe.com/events/${stripeEventId}`;

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
        from: getOrdersFrom(),
        to: adminEmail,
        subject: `Billing alert — unmatched Stripe event (${eventType})`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
            <h2 style="color:#1c1917;">Unmatched Stripe billing event</h2>
            <p>A Stripe webhook event could not be matched to any tenant and has been saved as a billing alert.</p>
            <div style="margin:24px 0;padding:16px;background:#f5f5f4;border-radius:8px;">
              <p style="margin:0 0 8px;"><strong>Event ID:</strong> <code style="font-family:monospace;">${escapeHtml(stripeEventId)}</code></p>
              <p style="margin:0 0 8px;"><strong>Event type:</strong> ${escapeHtml(eventType)}</p>
              ${customerId ? `<p style="margin:0 0 8px;"><strong>Customer ID:</strong> <code style="font-family:monospace;">${escapeHtml(customerId)}</code></p>` : ""}
              ${subscriptionId ? `<p style="margin:0 0 8px;"><strong>Subscription ID:</strong> <code style="font-family:monospace;">${escapeHtml(subscriptionId)}</code></p>` : ""}
              <p style="margin:0;"><strong>Reason:</strong> ${escapeHtml(reason)}</p>
            </div>
            <p>
              <a href="${escapeHtml(stripeDashboardUrl)}" style="color:#1c1917;">
                View event in Stripe Dashboard →
              </a>
            </p>
            ${
              billingAlertsUrl
                ? `<p>
                <a href="${escapeHtml(billingAlertsUrl)}" style="color:#1c1917;">
                  Go to Billing Alerts panel →
                </a>
              </p>`
                : ""
            }
            <p style="color:#78716c;font-size:14px;margin-top:24px;">
              Dismiss this alert from the billing alerts panel once resolved.
            </p>
          </div>
        `,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(
        `[Billing alert email] Resend error ${res.status}${body ? `: ${body.slice(0, 300)}` : ""}`,
      );
    }
  } catch (err) {
    console.error(
      `[Billing alert email] Failed to send notification: ${(err as any)?.message ?? String(err)}`,
    );
  }
}

/**
 * Notify the buyer that a partial refund has been issued on their order.
 * Throws EmailSendError on failure so callers can record it for retry.
 */
export async function sendPartialRefundNotification({
  buyerEmail,
  buyerName,
  artworkTitle,
  refundedAmountCents,
  orderRef,
  tenantName,
  orderLookupUrl,
}: {
  buyerEmail: string;
  buyerName: string | null;
  artworkTitle: string;
  /** Amount refunded in this action, in cents. */
  refundedAmountCents: number;
  orderRef: string;
  tenantName: string;
  /** Absolute URL of the guest order-status lookup page, if available. */
  orderLookupUrl?: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    throw new EmailSendError(
      "RESEND_API_KEY is not configured — partial refund notification not sent.",
    );
  }

  const escapeHtml = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const refundedDollars = (refundedAmountCents / 100).toFixed(2);

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: getOrdersFrom(),
        to: buyerEmail,
        subject: `Partial refund issued — ${artworkTitle}`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
            <h2 style="color:#1c1917;">Partial refund issued</h2>
            <p>Hi ${escapeHtml(buyerName ?? "there")},</p>
            <p>A partial refund of <strong>$${escapeHtml(refundedDollars)}</strong> has been issued on your order for <strong>${escapeHtml(artworkTitle)}</strong> from <strong>${escapeHtml(tenantName)}</strong>.</p>
            <p>Your order remains active — no further action is needed on your part. The refund will appear on your original payment method within a few business days.</p>
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
      `Failed to send partial refund notification: ${(err as any)?.message ?? String(err)}`,
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
        from: getOrdersFrom(),
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
