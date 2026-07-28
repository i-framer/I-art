/**
 * Email helper with a pluggable transport:
 * - SMTP (own mail server) when SMTP_HOST is set — preferred in production
 * - Resend API when RESEND_API_KEY is set — fallback
 * Gracefully skips/fails clearly when neither is configured (dev / testing).
 *
 * SMTP configuration (all standard):
 * - SMTP_HOST (required to enable SMTP)
 * - SMTP_PORT (default 587; 465 implies TLS)
 * - SMTP_USER / SMTP_PASS (auth; omit for unauthenticated relays)
 * - SMTP_SECURE ("true"/"false"; default: true when port is 465)
 */

/** Thrown when a confirmation email cannot be sent; callers should persist the failure so it can be retried. */
export class EmailSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailSendError";
  }
}

function smtpConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST);
}

/** True when at least one email transport (SMTP or Resend) is configured. */
export function isEmailTransportConfigured(): boolean {
  return smtpConfigured() || Boolean(process.env.RESEND_API_KEY);
}

const NO_TRANSPORT_MSG =
  "No email transport configured — set SMTP_HOST (own mail server) or RESEND_API_KEY.";

type EmailPayload = {
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  html: string;
};

/**
 * Deliver an email through the configured transport.
 * Throws EmailSendError on any failure (including no transport configured).
 */
async function deliverEmail(payload: EmailPayload): Promise<void> {
  if (smtpConfigured()) {
    const nodemailer = (await import("nodemailer")).default;
    const port = parseInt(process.env.SMTP_PORT ?? "587", 10);
    const secure = process.env.SMTP_SECURE
      ? process.env.SMTP_SECURE === "true"
      : port === 465;
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure,
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    });
    try {
      await transporter.sendMail({
        from: payload.from,
        to: payload.to,
        ...(payload.replyTo ? { replyTo: payload.replyTo } : {}),
        subject: payload.subject,
        html: payload.html,
      });
    } catch (err) {
      throw new EmailSendError(
        `SMTP error: ${(err as any)?.message ?? String(err)}`,
      );
    }
    return;
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new EmailSendError(NO_TRANSPORT_MSG);
  }

  let res: Response;
  try {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: payload.from,
        to: payload.to,
        ...(payload.replyTo ? { reply_to: payload.replyTo } : {}),
        subject: payload.subject,
        html: payload.html,
      }),
    });
  } catch (err) {
    throw new EmailSendError(
      `Failed to reach Resend: ${(err as any)?.message ?? String(err)}`,
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new EmailSendError(
      `Resend error ${res.status}${body ? `: ${body.slice(0, 300)}` : ""}`,
    );
  }
}

/**
 * Sender addresses come from configuration so the platform can run on any
 * domain without failing DMARC/SPF:
 * - EMAIL_FROM_INQUIRIES / EMAIL_FROM_ORDERS — per-purpose overrides
 * - EMAIL_FROM — shared fallback for both
 * - SMTP_USER — sensible default when sending through an own mail server
 * - "onboarding@resend.dev" — Resend's sandbox sender (dev/testing only)
 */
function getInquiriesFrom(): string {
  return (
    process.env.EMAIL_FROM_INQUIRIES ??
    process.env.EMAIL_FROM ??
    process.env.SMTP_USER ??
    "onboarding@resend.dev"
  );
}

function getOrdersFrom(): string {
  return (
    process.env.EMAIL_FROM_ORDERS ??
    process.env.EMAIL_FROM ??
    process.env.SMTP_USER ??
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
  if (!isEmailTransportConfigured()) {
    console.log(
      `[Email skipped — no transport configured] Inquiry about "${artworkTitle}" from ${buyerEmail} to ${galleryEmail}`,
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
    await deliverEmail({
        from: getInquiriesFrom(),
        to: galleryEmail,
        replyTo: buyerEmail,
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
    });
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
  if (!isEmailTransportConfigured()) {
    throw new EmailSendError(`${NO_TRANSPORT_MSG} Reply not sent.`);
  }

  const escapeHtml = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  try {
    await deliverEmail({
        from: getInquiriesFrom(),
        to: buyerEmail,
        ...(galleryEmail ? { replyTo: galleryEmail } : {}),
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
    });
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
  if (!isEmailTransportConfigured()) {
    throw new EmailSendError(`${NO_TRANSPORT_MSG} Status update email not sent.`);
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
    await deliverEmail({
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
    });
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
  if (!isEmailTransportConfigured()) {
    throw new EmailSendError(`${NO_TRANSPORT_MSG} Failure notice not sent.`);
  }

  const escapeHtml = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  try {
    await deliverEmail({
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
    });
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
  slackFailure,
}: {
  stripeEventId: string;
  eventType: string;
  customerId?: string | null;
  subscriptionId?: string | null;
  reason: string;
  /**
   * When the Slack notification failed, pass the error here so the operator
   * can see at a glance that the Slack channel is broken — without needing to
   * tail server logs.
   */
  slackFailure?: string;
}): Promise<void> {
  const adminEmail = process.env.PLATFORM_ADMIN_EMAIL;

  if (!isEmailTransportConfigured() || !adminEmail) {
    console.log(
      `[Billing alert email skipped — ${!isEmailTransportConfigured() ? "email transport (SMTP_HOST or RESEND_API_KEY)" : "PLATFORM_ADMIN_EMAIL"} not set] ` +
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
    await deliverEmail({
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
            ${
              slackFailure
                ? `<div style="margin:24px 0;padding:16px;background:#fef2f2;border-left:4px solid #ef4444;border-radius:8px;">
                <p style="margin:0 0 8px;font-weight:bold;color:#991b1b;">⚠️ Slack notification failed</p>
                <p style="margin:0;color:#7f1d1d;font-size:13px;">The Slack billing-alert message could not be delivered. Your Slack connector may need to be reconnected.</p>
                <p style="margin:8px 0 0;color:#7f1d1d;font-size:12px;font-family:monospace;">${escapeHtml(slackFailure.slice(0, 300))}</p>
              </div>`
                : ""
            }
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
    });
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
  if (!isEmailTransportConfigured()) {
    throw new EmailSendError(
      `${NO_TRANSPORT_MSG} Partial refund notification not sent.`,
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
    await deliverEmail({
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
    });
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
  if (!isEmailTransportConfigured()) {
    // Throw so callers record the miss (emailError) instead of silently
    // dropping the buyer's confirmation — it can be re-sent once configured.
    throw new EmailSendError(`${NO_TRANSPORT_MSG} Confirmation email not sent.`);
  }

  const fulfillmentText =
    FULFILLMENT_TEXT[fulfillmentType] ?? "The gallery will be in touch with next steps.";

  try {
    await deliverEmail({
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
    });
  } catch (err) {
    if (err instanceof EmailSendError) throw err;
    throw new EmailSendError(
      `Failed to send confirmation email: ${(err as any)?.message ?? String(err)}`,
    );
  }
}
