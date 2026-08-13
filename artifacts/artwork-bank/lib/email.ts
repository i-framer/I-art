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

/**
 * Escape characters that have special meaning in HTML so that user-supplied
 * strings (artwork titles, buyer names, tenant names, …) cannot inject tags
 * or break attribute values in outgoing email templates.
 *
 * Covers the five dangerous characters:  & < > " '
 */
export function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

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

  try {
    await deliverEmail({
        from: getInquiriesFrom(),
        to: galleryEmail,
        replyTo: buyerEmail,
        subject: `Inquiry about "${artworkTitle}" (${artworkSku})`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
            <h2 style="color:#1c1917;">New artwork inquiry</h2>
            <p>A buyer has asked about <strong>${htmlEscape(artworkTitle)}</strong> (SKU ${htmlEscape(artworkSku)}) on your ${htmlEscape(tenantName)} storefront.</p>
            <div style="margin:24px 0;padding:16px;background:#f5f5f4;border-radius:8px;">
              <p style="margin:0 0 8px;"><strong>From:</strong> ${htmlEscape(buyerName)} &lt;${htmlEscape(buyerEmail)}&gt;</p>
              <p style="margin:0;white-space:pre-line;">${htmlEscape(message)}</p>
            </div>
            <p><a href="${htmlEscape(artworkUrl)}" style="color:#1c1917;">View the artwork</a></p>
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

  try {
    await deliverEmail({
        from: getInquiriesFrom(),
        to: buyerEmail,
        ...(galleryEmail ? { replyTo: galleryEmail } : {}),
        subject: `Re: Inquiry about "${artworkTitle}" — ${tenantName}`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
            <p>Hi ${htmlEscape(buyerName)},</p>
            <p><strong>${htmlEscape(tenantName)}</strong> has replied to your inquiry about <strong>${htmlEscape(artworkTitle)}</strong>:</p>
            <div style="margin:24px 0;padding:16px;background:#f5f5f4;border-radius:8px;">
              <p style="margin:0;white-space:pre-line;">${htmlEscape(replyMessage)}</p>
            </div>
            <p style="color:#78716c;font-size:13px;">Your original message:</p>
            <blockquote style="margin:0 0 24px;padding:12px 16px;border-left:3px solid #e7e5e4;color:#78716c;font-size:13px;white-space:pre-line;">${htmlEscape(originalMessage)}</blockquote>
            <p style="color:#78716c;font-size:14px;">
              Reply to this email to continue the conversation with ${htmlEscape(tenantName)}.
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

  const isFulfilled = status === "FULFILLED";
  const heading = isFulfilled ? "Your order is on its way" : "Order update";
  const statusLine = isFulfilled
    ? `Good news — your order for <strong>${htmlEscape(artworkTitle)}</strong> from <strong>${htmlEscape(tenantName)}</strong> has been marked as fulfilled.`
    : `There's an update on your order for <strong>${htmlEscape(artworkTitle)}</strong> from <strong>${htmlEscape(tenantName)}</strong>.`;

  try {
    await deliverEmail({
        from: getOrdersFrom(),
        to: buyerEmail,
        subject: `Order update — ${artworkTitle}`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
            <h2 style="color:#1c1917;">${heading}</h2>
            <p>Hi ${htmlEscape(buyerName ?? "there")},</p>
            <p>${statusLine}</p>
            ${
              trackingNote
                ? `<div style="margin:24px 0;padding:16px;background:#f5f5f4;border-radius:8px;">
                     <p style="margin:0 0 8px;"><strong>Tracking / delivery note</strong></p>
                     <p style="margin:0;white-space:pre-line;">${htmlEscape(trackingNote)}</p>
                   </div>`
                : ""
            }
            <p style="margin-top:24px;padding:16px;background:#f5f5f4;border-radius:8px;">
              Order reference: <code style="font-family:monospace;">${htmlEscape(orderRef)}</code>
            </p>
            ${
              orderLookupUrl
                ? `<p>You can check your order status any time — no account needed: <a href="${htmlEscape(orderLookupUrl)}" style="color:#1c1917;">Check order status</a> (use this email address and your order reference).</p>`
                : ""
            }
            <p style="color:#78716c;font-size:14px;margin-top:24px;">
              Thank you for supporting ${htmlEscape(tenantName)}.
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


  try {
    await deliverEmail({
        from: getOrdersFrom(),
        to: galleryEmail,
        subject: `Action needed — buyer confirmation email failed (order ${orderRef})`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
            <h2 style="color:#1c1917;">Buyer confirmation email could not be delivered</h2>
            <p>We tried several times to send the order confirmation for <strong>${htmlEscape(artworkTitle)}</strong> on your ${htmlEscape(tenantName)} storefront, but every attempt failed. Automatic retries have stopped.</p>
            <div style="margin:24px 0;padding:16px;background:#f5f5f4;border-radius:8px;">
              <p style="margin:0 0 8px;"><strong>Order reference:</strong> <code style="font-family:monospace;">${htmlEscape(orderRef)}</code></p>
              <p style="margin:0 0 8px;"><strong>Buyer:</strong> ${htmlEscape(buyerName ?? "Unknown")} &lt;${htmlEscape(buyerEmail)}&gt;</p>
              ${
                lastError
                  ? `<p style="margin:0;color:#78716c;font-size:13px;"><strong>Last error:</strong> ${htmlEscape(lastError.slice(0, 300))}</p>`
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
 * Notify the platform operator when the orphan image sweep completes with
 * storage-deletion errors. Failures are logged but must not affect the sweep
 * response — the sweep result is already determined before this is called.
 *
 * Skipped silently when PLATFORM_ADMIN_EMAIL or a transport is not configured.
 */
export async function sendOrphanSweepErrorNotification({
  errors,
  failedPaths,
  slackFailure,
}: {
  errors: number;
  failedPaths: string[];
  /**
   * When the Slack notification failed, pass the error here so the operator
   * can see at a glance that the Slack channel is also broken.
   */
  slackFailure?: string;
}): Promise<void> {
  const adminEmail = process.env.PLATFORM_ADMIN_EMAIL;

  if (!isEmailTransportConfigured() || !adminEmail) {
    console.log(
      `[Orphan sweep email skipped — ${!isEmailTransportConfigured() ? "email transport (SMTP_HOST or RESEND_API_KEY)" : "PLATFORM_ADMIN_EMAIL"} not set]`,
    );
    return;
  }


  const pathListHtml =
    failedPaths.length > 0
      ? `<ul style="margin:8px 0;padding-left:20px;">${failedPaths
          .slice(0, 50)
          .map((p) => `<li><code style="font-family:monospace;">${htmlEscape(p)}</code></li>`)
          .join("")}${
          failedPaths.length > 50
            ? `<li>… and ${failedPaths.length - 50} more</li>`
            : ""
        }</ul>`
      : "<p style='margin:0;color:#78716c;'>(no paths recorded)</p>";

  try {
    await deliverEmail({
      from: getOrdersFrom(),
      to: adminEmail,
      subject: `Action needed — orphan image sweep failed to delete ${errors} file${errors === 1 ? "" : "s"}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
          <h2 style="color:#1c1917;">Orphan image sweep completed with errors</h2>
          <p>The orphan image sweep ran but could not delete <strong>${errors} storage file${errors === 1 ? "" : "s"}</strong>. These files remain in storage and will need manual investigation.</p>
          <div style="margin:24px 0;padding:16px;background:#f5f5f4;border-radius:8px;">
            <p style="margin:0 0 8px;"><strong>Failed deletions:</strong> ${errors}</p>
            <p style="margin:0 0 4px;"><strong>Paths that could not be deleted:</strong></p>
            ${pathListHtml}
          </div>
          ${
            slackFailure
              ? `<div style="margin:24px 0;padding:16px;background:#fef2f2;border-left:4px solid #ef4444;border-radius:8px;">
              <p style="margin:0 0 8px;font-weight:bold;color:#991b1b;">⚠️ Slack notification also failed</p>
              <p style="margin:0;color:#7f1d1d;font-size:13px;">The Slack alert could not be delivered. Your Slack connector may need to be reconnected.</p>
              <p style="margin:8px 0 0;color:#7f1d1d;font-size:12px;font-family:monospace;">${htmlEscape(slackFailure.slice(0, 300))}</p>
            </div>`
              : ""
          }
          <p>Check server logs for the specific errors, resolve the underlying storage issue, then re-run the sweep to clean up the remaining files.</p>
        </div>
      `,
    });
  } catch (err) {
    const errMsg = (err as any)?.message ?? String(err);
    // Log the failure so it appears in server logs and monitoring dashboards.
    console.error(
      "[Orphan sweep email] Failed to send operator notification:",
      errMsg,
    );
    // Surface the transport failure in the GitHub Actions step summary so
    // the operator sees it in the workflow run UI even when stderr is not
    // monitored.  GITHUB_STEP_SUMMARY is set automatically by GitHub Actions;
    // writing to it is a no-op outside CI.
    const summaryFile = process.env.GITHUB_STEP_SUMMARY;
    if (summaryFile) {
      try {
        const { appendFileSync } = await import("fs");
        appendFileSync(
          summaryFile,
          [
            "",
            "### ⚠️ Email transport failure — operator NOT notified by email",
            "",
            "The orphan-sweep error alert email could **not** be delivered.",
            "The operator will not receive an email notification until the transport is fixed.",
            "",
            `**Delivery error:** \`${errMsg.replace(/`/g, "'").slice(0, 300)}\``,
            "",
            "**Fix:** verify that the following GitHub Actions repository secrets are set",
            "and point to a working mail server:",
            "",
            "| Secret | Purpose |",
            "| --- | --- |",
            "| `SMTP_HOST` | Mail-server hostname |",
            "| `SMTP_PORT` | Mail-server port (default 587) |",
            "| `SMTP_USER` | SMTP username |",
            "| `SMTP_PASS` | SMTP password |",
            "",
            "Alternatively, set `RESEND_API_KEY` to use the Resend API instead.",
            "",
          ].join("\n"),
        );
      } catch {
        // Writing to the step summary failed — nothing we can do here.
      }
    }
    // Re-throw so callers know the delivery attempt failed and can handle it
    // (e.g. record the miss instead of silently swallowing it).
    throw err;
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
              <p style="margin:0 0 8px;"><strong>Event ID:</strong> <code style="font-family:monospace;">${htmlEscape(stripeEventId)}</code></p>
              <p style="margin:0 0 8px;"><strong>Event type:</strong> ${htmlEscape(eventType)}</p>
              ${customerId ? `<p style="margin:0 0 8px;"><strong>Customer ID:</strong> <code style="font-family:monospace;">${htmlEscape(customerId)}</code></p>` : ""}
              ${subscriptionId ? `<p style="margin:0 0 8px;"><strong>Subscription ID:</strong> <code style="font-family:monospace;">${htmlEscape(subscriptionId)}</code></p>` : ""}
              <p style="margin:0;"><strong>Reason:</strong> ${htmlEscape(reason)}</p>
            </div>
            ${
              slackFailure
                ? `<div style="margin:24px 0;padding:16px;background:#fef2f2;border-left:4px solid #ef4444;border-radius:8px;">
                <p style="margin:0 0 8px;font-weight:bold;color:#991b1b;">⚠️ Slack notification failed</p>
                <p style="margin:0;color:#7f1d1d;font-size:13px;">The Slack billing-alert message could not be delivered. Your Slack connector may need to be reconnected.</p>
                <p style="margin:8px 0 0;color:#7f1d1d;font-size:12px;font-family:monospace;">${htmlEscape(slackFailure.slice(0, 300))}</p>
              </div>`
                : ""
            }
            <p>
              <a href="${htmlEscape(stripeDashboardUrl)}" style="color:#1c1917;">
                View event in Stripe Dashboard →
              </a>
            </p>
            ${
              billingAlertsUrl
                ? `<p>
                <a href="${htmlEscape(billingAlertsUrl)}" style="color:#1c1917;">
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
    // Log the failure so it appears in server logs and monitoring dashboards.
    // Re-throw so callers know the delivery attempt failed and can handle it
    // (e.g. record the miss instead of silently swallowing it).
    console.error(
      `[Billing alert email] Failed to send notification: ${(err as any)?.message ?? String(err)}`,
    );
    throw err;
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


  const refundedDollars = (refundedAmountCents / 100).toFixed(2);

  try {
    await deliverEmail({
        from: getOrdersFrom(),
        to: buyerEmail,
        subject: `Partial refund issued — ${artworkTitle}`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
            <h2 style="color:#1c1917;">Partial refund issued</h2>
            <p>Hi ${htmlEscape(buyerName ?? "there")},</p>
            <p>A partial refund of <strong>$${htmlEscape(refundedDollars)}</strong> has been issued on your order for <strong>${htmlEscape(artworkTitle)}</strong> from <strong>${htmlEscape(tenantName)}</strong>.</p>
            <p>Your order remains active — no further action is needed on your part. The refund will appear on your original payment method within a few business days.</p>
            <p style="margin-top:24px;padding:16px;background:#f5f5f4;border-radius:8px;">
              Order reference: <code style="font-family:monospace;">${htmlEscape(orderRef)}</code>
            </p>
            ${
              orderLookupUrl
                ? `<p>You can check your order status any time — no account needed: <a href="${htmlEscape(orderLookupUrl)}" style="color:#1c1917;">Check order status</a> (use this email address and your order reference).</p>`
                : ""
            }
            <p style="color:#78716c;font-size:14px;margin-top:24px;">
              Thank you for supporting ${htmlEscape(tenantName)}.
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

/**
 * Notify the platform operator when the production schema push fails after a
 * merge — used as a fallback when Slack is not configured or the Slack call
 * fails.
 *
 * Skipped silently when PLATFORM_ADMIN_EMAIL or a transport is not configured.
 * Failures are logged but never re-thrown — the caller (post-merge.sh) owns
 * the non-zero exit code; this notifier must not mask it.
 */
export async function sendSchemaPushFailureEmail({
  errorText,
  slackFailure,
}: {
  /** Captured output from the failed schema push command. */
  errorText: string;
  /**
   * When the Slack notification also failed, pass the error here so the
   * operator can see at a glance that Slack is broken too.
   */
  slackFailure?: string;
}): Promise<boolean> {
  const adminEmail = process.env.PLATFORM_ADMIN_EMAIL;

  if (!isEmailTransportConfigured() || !adminEmail) {
    console.log(
      `[Schema push alert email skipped — ${!isEmailTransportConfigured() ? "email transport (SMTP_HOST or RESEND_API_KEY)" : "PLATFORM_ADMIN_EMAIL"} not set]`,
    );
    return false;
  }


  // Truncate very long output so the email stays readable.
  const MAX_CHARS = 4000;
  const truncatedError =
    errorText.length > MAX_CHARS
      ? errorText.slice(0, MAX_CHARS) + "\n… (truncated)"
      : errorText;

  try {
    await deliverEmail({
      from: getOrdersFrom(),
      to: adminEmail,
      subject: `Action needed — Production schema push FAILED after merge`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
          <h2 style="color:#b91c1c;">Production schema push FAILED</h2>
          <p>The post-merge schema push to the production database failed. The database may be out of sync with the current schema.</p>
          <div style="margin:24px 0;padding:16px;background:#fef2f2;border-left:4px solid #ef4444;border-radius:8px;">
            <p style="margin:0 0 8px;font-weight:bold;color:#991b1b;">Action required</p>
            <p style="margin:0;color:#7f1d1d;">Check the post-merge CI logs for the full output, resolve the underlying issue, then re-run:</p>
            <pre style="margin:12px 0 0;padding:12px;background:#1c1917;color:#f5f5f4;border-radius:4px;font-size:12px;overflow-x:auto;">DATABASE_URL="$PROD_DATABASE_URL" pnpm --filter @workspace/db run push-force</pre>
          </div>
          <div style="margin:24px 0;padding:16px;background:#f5f5f4;border-radius:8px;">
            <p style="margin:0 0 8px;font-weight:bold;">Error output:</p>
            <pre style="margin:0;white-space:pre-wrap;font-size:12px;font-family:monospace;overflow-x:auto;">${htmlEscape(truncatedError)}</pre>
          </div>
          ${
            slackFailure
              ? `<div style="margin:24px 0;padding:16px;background:#fef2f2;border-left:4px solid #ef4444;border-radius:8px;">
              <p style="margin:0 0 8px;font-weight:bold;color:#991b1b;">⚠️ Slack notification also failed</p>
              <p style="margin:0;color:#7f1d1d;font-size:13px;">The Slack alert could not be delivered. Your Slack connector may need to be reconnected.</p>
              <p style="margin:8px 0 0;color:#7f1d1d;font-size:12px;font-family:monospace;">${htmlEscape(slackFailure.slice(0, 300))}</p>
            </div>`
              : ""
          }
        </div>
      `,
    });
    return true;
  } catch (err) {
    // Best-effort — log but do not propagate.
    console.error(
      "[Schema push alert email] Failed to send operator notification:",
      (err as any)?.message ?? String(err),
    );
    return false;
  }
}

export async function sendDriftFailureEmail({
  errorText,
  slackFailure,
}: {
  /** Captured output from the failed check-drift command. */
  errorText: string;
  /**
   * When the Slack notification also failed, pass the error here so the
   * operator can see at a glance that Slack is broken too.
   */
  slackFailure?: string;
}): Promise<boolean> {
  const adminEmail = process.env.PLATFORM_ADMIN_EMAIL;

  if (!isEmailTransportConfigured() || !adminEmail) {
    console.log(
      `[Drift alert email skipped — ${!isEmailTransportConfigured() ? "email transport (SMTP_HOST or RESEND_API_KEY)" : "PLATFORM_ADMIN_EMAIL"} not set]`,
    );
    return false;
  }


  // Truncate very long output so the email stays readable.
  const MAX_CHARS = 4000;
  const truncatedError =
    errorText.length > MAX_CHARS
      ? errorText.slice(0, MAX_CHARS) + "\n… (truncated)"
      : errorText;

  try {
    await deliverEmail({
      from: getOrdersFrom(),
      to: adminEmail,
      subject: `Action needed — Production schema drift detected (scheduled check)`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
          <h2 style="color:#b91c1c;">Production schema drift detected</h2>
          <p>The daily scheduled drift check found that the production database schema
          no longer matches the TypeScript schema. This often means a manual change was
          applied directly to the database (e.g. via Drizzle Studio or a hotfix) without
          a corresponding schema update.</p>
          <div style="margin:24px 0;padding:16px;background:#fef2f2;border-left:4px solid #ef4444;border-radius:8px;">
            <p style="margin:0 0 8px;font-weight:bold;color:#991b1b;">Action required</p>
            <ul style="margin:0;padding-left:20px;color:#7f1d1d;">
              <li>If the DB is <strong>ahead</strong> of the schema (orphaned columns/tables):
                add a migration that DROPs them, or restore them in the schema.</li>
              <li>If the schema is <strong>ahead</strong> of the DB (missing columns/tables):
                run the push command below, then redeploy.</li>
            </ul>
            <pre style="margin:12px 0 0;padding:12px;background:#1c1917;color:#f5f5f4;border-radius:4px;font-size:12px;overflow-x:auto;">DATABASE_URL="$PROD_DATABASE_URL" pnpm --filter @workspace/db run push-force</pre>
          </div>
          <div style="margin:24px 0;padding:16px;background:#f5f5f4;border-radius:8px;">
            <p style="margin:0 0 8px;font-weight:bold;">Drift output:</p>
            <pre style="margin:0;white-space:pre-wrap;font-size:12px;font-family:monospace;overflow-x:auto;">${htmlEscape(truncatedError)}</pre>
          </div>
          ${
            slackFailure
              ? `<div style="margin:24px 0;padding:16px;background:#fef2f2;border-left:4px solid #ef4444;border-radius:8px;">
              <p style="margin:0 0 8px;font-weight:bold;color:#991b1b;">⚠️ Slack notification also failed</p>
              <p style="margin:0;color:#7f1d1d;font-size:13px;">The Slack alert could not be delivered. Your Slack connector may need to be reconnected.</p>
              <p style="margin:8px 0 0;color:#7f1d1d;font-size:12px;font-family:monospace;">${htmlEscape(slackFailure.slice(0, 300))}</p>
            </div>`
              : ""
          }
        </div>
      `,
    });
    return true;
  } catch (err) {
    // Best-effort — log but do not propagate.
    console.error(
      "[Drift alert email] Failed to send operator notification:",
      (err as any)?.message ?? String(err),
    );
    return false;
  }
}

/**
 * Sends an operator alert when the automated Slack smoke test fails.
 *
 * Called by `scripts/notify-smoke-failure.ts` which is invoked by the
 * `slack-reconnect-smoke` GitHub Actions workflow on failure.
 *
 * Skipped silently when PLATFORM_ADMIN_EMAIL or a transport is not configured.
 */
export async function sendSmokeTestFailureEmail({
  probeResponseBody,
  workflowRunUrl,
}: {
  /** Raw JSON response body from the /api/slack-smoke probe (may be empty). */
  probeResponseBody: string;
  /** Direct link to the failed GitHub Actions run. */
  workflowRunUrl: string;
}): Promise<boolean> {
  const adminEmail = process.env.PLATFORM_ADMIN_EMAIL;

  if (!isEmailTransportConfigured() || !adminEmail) {
    console.log(
      `[Smoke test email skipped — ${!isEmailTransportConfigured() ? "email transport (SMTP_HOST or RESEND_API_KEY)" : "PLATFORM_ADMIN_EMAIL"} not set]`,
    );
    return false;
  }

  // When the CI workflow's curl/Python step already confirmed a successful
  // Resend send, skip our own Resend attempt to avoid sending the operator
  // two identical failure emails.  SMTP is a separate transport — it is never
  // affected by this guard (the duplicate risk only exists when Resend is the
  // only transport and both paths run back-to-back in the same workflow job).
  if (process.env.RESEND_ALREADY_SENT === "1" && !smtpConfigured()) {
    console.error(
      "[slack-smoke notifier] Resend alert already sent by the curl step — " +
        "skipping tsx Resend attempt to prevent duplicate email.",
    );
    return true;
  }

  // Truncate very long bodies so the email stays readable.
  const MAX_CHARS = 4000;
  const truncatedBody =
    probeResponseBody.length > MAX_CHARS
      ? probeResponseBody.slice(0, MAX_CHARS) + "\n… (truncated)"
      : probeResponseBody;

  try {
    await deliverEmail({
      from: getOrdersFrom(),
      to: adminEmail,
      subject: `Action needed — Slack smoke test failed (weekly check)`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
          <h2 style="color:#b91c1c;">Slack smoke test failed</h2>
          <p>The automated weekly Slack smoke test detected that one or more Slack
          alert paths are not working. This may mean the Slack connector token has
          expired, the bot was removed from the channel, or Slack itself is
          experiencing an outage.</p>
          <div style="margin:24px 0;padding:16px;background:#fef2f2;border-left:4px solid #ef4444;border-radius:8px;">
            <p style="margin:0 0 8px;font-weight:bold;color:#991b1b;">Action required</p>
            <ul style="margin:0;padding-left:20px;color:#7f1d1d;">
              <li>Check the failed workflow run linked below for the full error output.</li>
              <li>Follow the <strong>Slack connector reconnect</strong> steps in <code>RUNBOOK.md</code>
                to restore the Slack integration.</li>
              <li>Re-run the smoke test after reconnecting to confirm delivery is restored.</li>
            </ul>
          </div>
          ${
            workflowRunUrl
              ? `<p style="margin:16px 0;">
                  <a href="${htmlEscape(workflowRunUrl)}"
                     style="display:inline-block;padding:10px 20px;background:#1c1917;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:bold;">
                    View failed workflow run →
                  </a>
                </p>`
              : ""
          }
          <div style="margin:24px 0;padding:16px;background:#f5f5f4;border-radius:8px;">
            <p style="margin:0 0 8px;font-weight:bold;">Probe response body:</p>
            <pre style="margin:0;white-space:pre-wrap;font-size:12px;font-family:monospace;overflow-x:auto;">${truncatedBody ? htmlEscape(truncatedBody) : "(no response body captured)"}</pre>
          </div>
          <p style="color:#78716c;font-size:13px;margin-top:24px;">
            This alert was sent as an email fallback because Slack itself may be
            unreachable — a Slack notification about a Slack outage cannot be
            delivered through the same broken channel.
          </p>
        </div>
      `,
    });
    return true;
  } catch (err) {
    const errMsg = (err as any)?.message ?? String(err);
    // Best-effort — log but do not propagate.
    console.error(
      "[Smoke test email] Failed to send operator notification:",
      errMsg,
    );
    // Surface the SMTP/transport failure in the GitHub Actions step summary so
    // the operator sees it in the workflow run UI even when stderr is not
    // monitored.  GITHUB_STEP_SUMMARY is set automatically by GitHub Actions;
    // writing to it is a no-op outside CI.
    const summaryFile = process.env.GITHUB_STEP_SUMMARY;
    if (summaryFile) {
      try {
        const { appendFileSync } = await import("fs");
        appendFileSync(
          summaryFile,
          [
            "",
            "### ⚠️ Email transport failure — operator NOT notified by email",
            "",
            "The smoke-test failure alert email could **not** be delivered.",
            "The operator will not receive an email notification until the transport is fixed.",
            "",
            `**Delivery error:** \`${errMsg.replace(/`/g, "'").slice(0, 300)}\``,
            "",
            "**Fix:** verify that the following GitHub Actions repository secrets are set",
            "and point to a working mail server:",
            "",
            "| Secret | Purpose |",
            "| --- | --- |",
            "| `SMTP_HOST` | Mail-server hostname |",
            "| `SMTP_PORT` | Mail-server port (default 587) |",
            "| `SMTP_USER` | SMTP username |",
            "| `SMTP_PASS` | SMTP password |",
            "",
            "Alternatively, set `RESEND_API_KEY` to use the Resend API instead.",
            "",
          ].join("\n"),
        );
      } catch {
        // Writing to the step summary failed — nothing we can do here.
      }
    }
    return false;
  }
}

/**
 * Sends an operator alert when the scheduled Stripe webhook health probe
 * detects that the endpoint is redirecting (3xx) instead of accepting the POST.
 *
 * Called by `scripts/notify-webhook-redirect.ts` which is invoked by the
 * `stripe-webhook-health` GitHub Actions workflow on failure.
 *
 * Skipped silently when PLATFORM_ADMIN_EMAIL or a transport is not configured.
 */
export async function sendWebhookRedirectEmail({
  webhookUrl,
  httpCode,
  location,
  workflowRunUrl,
  slackFailure,
}: {
  /** The probed webhook URL. */
  webhookUrl: string;
  /** The HTTP status code returned (e.g. "308"). */
  httpCode: string;
  /** The Location header value from the redirect response, if any. */
  location?: string;
  /** Direct link to the failed GitHub Actions run. */
  workflowRunUrl: string;
  /** When the Slack notification also failed, pass the error here. */
  slackFailure?: string;
}): Promise<boolean> {
  const adminEmail = process.env.PLATFORM_ADMIN_EMAIL;

  if (!isEmailTransportConfigured() || !adminEmail) {
    console.log(
      `[Webhook redirect email skipped — ${!isEmailTransportConfigured() ? "email transport (SMTP_HOST or RESEND_API_KEY)" : "PLATFORM_ADMIN_EMAIL"} not set]`,
    );
    return false;
  }

  try {
    await deliverEmail({
      from: getOrdersFrom(),
      to: adminEmail,
      subject: `🚨 Action needed — Stripe webhook endpoint is redirecting (HTTP ${httpCode})`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
          <h2 style="color:#b91c1c;">Stripe webhook endpoint is redirecting</h2>
          <p>The scheduled webhook health probe detected that your Stripe webhook
          endpoint is returning a <strong>redirect (HTTP ${htmlEscape(httpCode)})</strong>
          instead of accepting the request directly.</p>
          <p><strong>Stripe does not follow redirects.</strong> Every webhook delivery
          is being counted as a failure. Orders and subscription events are silently lost
          until this is fixed.</p>
          <div style="margin:24px 0;padding:16px;background:#fef2f2;border-left:4px solid #ef4444;border-radius:8px;">
            <p style="margin:0 0 8px;font-weight:bold;color:#991b1b;">Details</p>
            <ul style="margin:0;padding-left:20px;color:#7f1d1d;">
              <li>Probed URL: <code>${htmlEscape(webhookUrl)}</code></li>
              <li>HTTP status: <strong>${htmlEscape(httpCode)}</strong></li>
              ${location ? `<li>Redirects to: <code>${htmlEscape(location)}</code></li>` : ""}
            </ul>
          </div>
          <div style="margin:24px 0;padding:16px;background:#fef2f2;border-left:4px solid #ef4444;border-radius:8px;">
            <p style="margin:0 0 8px;font-weight:bold;color:#991b1b;">Fix (DEPLOY.md §4, Option B — webhook registered at www)</p>
            <ol style="margin:0;padding-left:20px;color:#7f1d1d;">
              <li>Stripe Dashboard → Developers → Webhooks → confirm the endpoint URL is <code>https://www.i-art.com.au/api/stripe/webhook</code>.</li>
              <li>If it points at the apex (no www), update it to the www URL — the apex 308-redirects and Stripe does not follow redirects.</li>
              <li>Confirm the probed URL matches the registered endpoint (update the workflow default if the primary domain changed).</li>
              <li>Run <code>bash scripts/check-webhook-redirect.sh</code> and confirm ✅ No redirect.</li>
              <li>Send a test event from Stripe Dashboard and confirm 200 in the delivery log.</li>
            </ol>
          </div>
          ${
            workflowRunUrl
              ? `<p style="margin:16px 0;">
                  <a href="${htmlEscape(workflowRunUrl)}"
                     style="display:inline-block;padding:10px 20px;background:#1c1917;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:bold;">
                    View failed workflow run →
                  </a>
                </p>`
              : ""
          }
          ${
            slackFailure
              ? `<div style="margin:24px 0;padding:16px;background:#fef2f2;border-left:4px solid #ef4444;border-radius:8px;">
                <p style="margin:0 0 8px;font-weight:bold;color:#991b1b;">⚠️ Slack notification also failed</p>
                <p style="margin:0;color:#7f1d1d;font-size:13px;">The Slack alert could not be delivered. Your Slack connector may need to be reconnected.</p>
                <p style="margin:8px 0 0;color:#7f1d1d;font-size:12px;font-family:monospace;">${htmlEscape(slackFailure.slice(0, 300))}</p>
              </div>`
              : ""
          }
        </div>
      `,
    });
    return true;
  } catch (err) {
    const errMsg = (err as any)?.message ?? String(err);
    console.error(
      "[Webhook redirect email] Failed to send operator notification:",
      errMsg,
    );
    // Surface the transport failure in the GitHub Actions step summary so
    // the operator sees it in the workflow run UI even when stderr is not
    // monitored.  GITHUB_STEP_SUMMARY is set automatically by GitHub Actions;
    // writing to it is a no-op outside CI.
    const summaryFile = process.env.GITHUB_STEP_SUMMARY;
    if (summaryFile) {
      try {
        const { appendFileSync } = await import("fs");
        appendFileSync(
          summaryFile,
          [
            "",
            "### ⚠️ Email transport failure — operator NOT notified by email",
            "",
            "The webhook-redirect alert email could **not** be delivered.",
            "The operator will not receive an email notification until the transport is fixed.",
            "",
            `**Delivery error:** \`${errMsg.replace(/`/g, "'").slice(0, 300)}\``,
            "",
            "**Fix:** verify that the following GitHub Actions repository secrets are set",
            "and point to a working mail server:",
            "",
            "| Secret | Purpose |",
            "| --- | --- |",
            "| `SMTP_HOST` | Mail-server hostname |",
            "| `SMTP_PORT` | Mail-server port (default 587) |",
            "| `SMTP_USER` | SMTP username |",
            "| `SMTP_PASS` | SMTP password |",
            "",
            "Alternatively, set `RESEND_API_KEY` to use the Resend API instead.",
            "",
          ].join("\n"),
        );
      } catch {
        // Writing to the step summary failed — nothing we can do here.
      }
    }
    return false;
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
            <p>Hi ${htmlEscape(buyerName ?? "there")},</p>
            <p>Your order for <strong>${htmlEscape(artworkTitle)}</strong> from <strong>${htmlEscape(tenantName)}</strong> has been confirmed.</p>
            <p>${fulfillmentText}</p>
            <p style="margin-top:24px;padding:16px;background:#f5f5f4;border-radius:8px;">
              Order reference: <code style="font-family:monospace;">${htmlEscape(orderRef)}</code>
            </p>
            ${
              orderLookupUrl
                ? `<p>You can check your order status any time — no account needed: <a href="${htmlEscape(orderLookupUrl)}" style="color:#1c1917;">Check order status</a> (use this email address and your order reference).</p>`
                : ""
            }
            <p style="color:#78716c;font-size:14px;margin-top:24px;">
              Thank you for supporting ${htmlEscape(tenantName)}.
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
