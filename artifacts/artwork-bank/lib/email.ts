/**
 * Simple email helper using Resend API.
 * Gracefully skips sending if RESEND_API_KEY is not set (dev / testing).
 */

const FULFILLMENT_TEXT: Record<string, string> = {
  SHIP: "Your artwork will be shipped to you. The gallery will be in touch with tracking details.",
  PICKUP: "You've chosen to collect in person. The gallery will contact you to arrange pickup.",
  FRAMING_JOB: "Your framing job has been received. The framer will contact you with next steps.",
};

export async function sendOrderConfirmation({
  buyerEmail,
  buyerName,
  artworkTitle,
  fulfillmentType,
  orderRef,
  tenantName,
}: {
  buyerEmail: string;
  buyerName: string | null;
  artworkTitle: string;
  fulfillmentType: string;
  orderRef: string;
  tenantName: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    console.log(
      `[Email skipped — RESEND_API_KEY not set] Order ${orderRef} for ${buyerEmail}`,
    );
    return;
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
            <p style="color:#78716c;font-size:14px;margin-top:24px;">
              Thank you for supporting ${tenantName}.
            </p>
          </div>
        `,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`Resend error ${res.status}:`, body);
    }
  } catch (err) {
    // Non-fatal — log and continue
    console.error("Failed to send confirmation email:", err);
  }
}
