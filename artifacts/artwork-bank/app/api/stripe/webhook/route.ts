import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { db } from "@workspace/db";
import {
  ordersTable,
  orderItemsTable,
  artworksTable,
  tenantsTable,
  stripeAlertsTable,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import {
  getStripeClient,
  getStripeWebhookSecret,
  calcApplicationFee,
  StripeNotConfiguredError,
} from "@/lib/stripe";
import { sendOrderConfirmation, sendBillingAlertNotification } from "@/lib/email";
import { sendBillingAlertSlackNotification } from "@/lib/slack";
import { getTenantUrl } from "@/lib/base-url";
import { createIFramerJob, IFramerError } from "@/lib/iframer";
import type Stripe from "stripe";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.text();
  const sig = (await headers()).get("stripe-signature");

  const webhookSecret = await getStripeWebhookSecret();

  const isProd = process.env.NODE_ENV === "production";
  const devBypass =
    !isProd && process.env.STRIPE_WEBHOOK_DEV_BYPASS === "true";

  let event: Stripe.Event;

  if (webhookSecret && sig) {
    let stripe;
    try {
      stripe = await getStripeClient();
    } catch (err: any) {
      if (err instanceof StripeNotConfiguredError) {
        console.error("Webhook rejected — Stripe not configured:", err.message);
        return NextResponse.json(
          { error: "Payments are not configured." },
          { status: 503 },
        );
      }
      console.error("Webhook Stripe client error:", err?.message ?? err);
      return NextResponse.json({ error: "Stripe unavailable" }, { status: 503 });
    }
    try {
      event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
    } catch (err: any) {
      console.error("Webhook signature verification failed:", err.message);
      return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
    }
  } else if (devBypass) {
    try {
      event = JSON.parse(body) as Stripe.Event;
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
  } else {
    console.error(
      "Webhook rejected: missing signature or webhook secret. " +
        "Set STRIPE_WEBHOOK_SECRET, or set STRIPE_WEBHOOK_DEV_BYPASS=true for local dev.",
    );
    return NextResponse.json(
      {
        error:
          "Webhook signature required. Configure STRIPE_WEBHOOK_SECRET or use the Stripe CLI for local testing.",
      },
      { status: 400 },
    );
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode === "subscription") {
        await handleSubscriptionCheckoutCompleted(session);
      } else {
        await handleCheckoutCompleted(session);
      }
    } else if (event.type === "checkout.session.expired") {
      await handleCheckoutExpired(event.data.object as Stripe.Checkout.Session);
    } else if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      await handleSubscriptionEvent(
        event.data.object as Stripe.Subscription,
        event.id,
        event.type,
      );
    } else if (event.type === "invoice.payment_failed") {
      await handleInvoicePaymentFailed(
        event.data.object as Stripe.Invoice,
        event.id,
      );
    }
  } catch (err: any) {
    console.error("Webhook handler error:", err);
    return NextResponse.json({ error: "Handler error" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

// ── Platform subscription billing ─────────────────────────────────────────────

/** Tenant subscribed via Checkout — link Stripe IDs and mark active. */
async function handleSubscriptionCheckoutCompleted(
  session: Stripe.Checkout.Session,
) {
  const metaTenantId = session.metadata?.billingTenantId;

  const customerId =
    typeof session.customer === "string"
      ? session.customer
      : session.customer?.id ?? null;
  const subscriptionId =
    typeof session.subscription === "string"
      ? session.subscription
      : session.subscription?.id ?? null;

  // Resolve the tenant: prefer metadata, fall back to stripeCustomerId.
  let tenant: {
    id: string;
    subscriptionStatus: string | null;
    stripeSubscriptionId: string | null;
  } | undefined;

  if (metaTenantId) {
    tenant = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, metaTenantId),
      columns: { id: true, subscriptionStatus: true, stripeSubscriptionId: true },
    });
  } else if (customerId) {
    tenant = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.stripeCustomerId, customerId),
      columns: { id: true, subscriptionStatus: true, stripeSubscriptionId: true },
    });
  }

  if (!tenant) {
    console.error(
      "Subscription checkout — no tenant matched by metadata or customer ID:",
      session.id,
    );
    return;
  }

  const tenantId = tenant.id;

  // Order-safety: customer.subscription.* events are the source of truth for
  // status. Only mark active here when this checkout introduces a NEW
  // subscription — if a subscription event for the same subscription already
  // wrote a status (e.g. an out-of-order `deleted` → canceled), keep it.
  const isNewSubscription =
    !tenant.subscriptionStatus ||
    (subscriptionId != null && tenant.stripeSubscriptionId !== subscriptionId);

  await db
    .update(tenantsTable)
    .set({
      ...(customerId ? { stripeCustomerId: customerId } : {}),
      ...(subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
      ...(isNewSubscription ? { subscriptionStatus: "active" } : {}),
    })
    .where(eq(tenantsTable.id, tenantId));
}

/** Mirror Stripe's subscription status onto the owning tenant. */
async function handleSubscriptionEvent(
  subscription: Stripe.Subscription,
  eventId: string,
  eventType: string,
) {
  const status =
    subscription.status === "canceled" ? "canceled" : subscription.status;

  const tenantId = subscription.metadata?.billingTenantId;
  const customerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer?.id;

  // Prefer metadata (set at checkout), fall back to matching by customer/sub ID
  const where = tenantId
    ? eq(tenantsTable.id, tenantId)
    : customerId
      ? eq(tenantsTable.stripeCustomerId, customerId)
      : eq(tenantsTable.stripeSubscriptionId, subscription.id);

  // Out-of-order guard: never overwrite "canceled" with a live status for the
  // SAME subscription. A previously-canceled tenant can only transition out of
  // "canceled" if the event carries a DIFFERENT subscription ID (new checkout)
  // or the new status is itself "canceled".
  const cancelGuard = sql`(
    ${tenantsTable.subscriptionStatus} IS DISTINCT FROM 'canceled'
    OR ${tenantsTable.stripeSubscriptionId} IS DISTINCT FROM ${subscription.id}
    OR ${status} = 'canceled'
  )`;

  const updated = await db
    .update(tenantsTable)
    .set({
      subscriptionStatus: status,
      stripeSubscriptionId: subscription.id,
      ...(customerId ? { stripeCustomerId: customerId } : {}),
    })
    .where(and(where, cancelGuard))
    .returning({ id: tenantsTable.id });

  if (updated.length === 0) {
    // Distinguish two cases:
    // (a) No tenant matched the base lookup at all → genuine unmatched event.
    // (b) A tenant matched but the cancel guard intentionally blocked the write
    //     (stale out-of-order event for an already-canceled subscription) → no-op.
    const matched = await db.query.tenantsTable.findFirst({
      where,
      columns: { id: true },
    });

    if (matched) {
      // Guard blocked a stale event — expected no-op, not an error.
      console.log(
        `[webhook] Stale out-of-order event ignored (tenant already canceled). ` +
          `eventId=${eventId} eventType=${eventType} subscriptionId=${subscription.id}`,
      );
      return;
    }

    const msg =
      `[webhook] Unmatched subscription event — no tenant found. ` +
      `eventId=${eventId} eventType=${eventType} ` +
      `customerId=${customerId ?? "(none)"} subscriptionId=${subscription.id}`;
    console.error(msg);
    // Persist so the admin billing-alerts panel can surface it.
    const alertReason =
      "No tenant matched by metadata, customer ID, or subscription ID";
    try {
      const inserted = await db
        .insert(stripeAlertsTable)
        .values({
          stripeEventId: eventId,
          eventType,
          customerId: customerId ?? null,
          subscriptionId: subscription.id,
          reason: alertReason,
        })
        .onConflictDoNothing({ target: stripeAlertsTable.stripeEventId })
        .returning({ id: stripeAlertsTable.id });
      // Only notify when a genuinely new alert row was written — not on Stripe
      // redeliveries of the same event, which hit the conflict path.
      if (inserted.length > 0) {
        // Fire Slack first so we can include any failure in the email.
        let slackFailure: string | undefined;
        try {
          const slackResult = await sendBillingAlertSlackNotification({
            stripeEventId: eventId,
            eventType,
            customerId: customerId ?? null,
            subscriptionId: subscription.id,
            reason: alertReason,
          });
          if (!slackResult.ok) slackFailure = slackResult.error;
        } catch (slackErr) {
          console.error("[webhook] Failed to send billing alert Slack message:", slackErr);
          slackFailure = (slackErr as any)?.message ?? String(slackErr);
        }
        // Persist the Slack failure timestamp so operators and the smoke script
        // can detect missed deliveries without tailing server logs.
        if (slackFailure) {
          try {
            await db
              .update(stripeAlertsTable)
              .set({ slackPostFailed: new Date() })
              .where(eq(stripeAlertsTable.stripeEventId, eventId));
          } catch (updateErr) {
            console.error("[webhook] Failed to persist slackPostFailed flag:", updateErr);
          }
        }
        try {
          await sendBillingAlertNotification({
            stripeEventId: eventId,
            eventType,
            customerId: customerId ?? null,
            subscriptionId: subscription.id,
            reason: alertReason,
            ...(slackFailure ? { slackFailure } : {}),
          });
        } catch (emailErr) {
          console.error("[webhook] Failed to send billing alert email:", emailErr);
        }
      }
    } catch (dbErr) {
      console.error("[webhook] Failed to persist billing alert:", dbErr);
    }
  }
}

/** A subscription invoice failed to collect — flag the tenant as past_due.
 *
 * Guard: if the tenant is already 'canceled', do NOT overwrite that status.
 * A late invoice.payment_failed for a final unpaid invoice must not revive a
 * canceled subscription back to 'past_due'. The customer.subscription.* events
 * are the authoritative source of truth for subscription lifecycle; this event
 * only handles payment collection failures on active/trialing/past_due tenants.
 */
async function handleInvoicePaymentFailed(
  invoice: Stripe.Invoice,
  eventId: string,
) {
  const customerId =
    typeof invoice.customer === "string"
      ? invoice.customer
      : invoice.customer?.id;
  if (!customerId) return;

  // Never overwrite 'canceled' — a late payment failure on an already-canceled
  // subscription must not flip the status back to 'past_due'.
  const cancelGuard = sql`${tenantsTable.subscriptionStatus} IS DISTINCT FROM 'canceled'`;

  const updated = await db
    .update(tenantsTable)
    .set({ subscriptionStatus: "past_due" })
    .where(and(eq(tenantsTable.stripeCustomerId, customerId), cancelGuard))
    .returning({ id: tenantsTable.id });

  if (updated.length === 0) {
    // Distinguish two cases:
    // (a) No tenant matched the customer ID at all → genuine unmatched event.
    // (b) A tenant matched but is already 'canceled' → expected no-op; do not
    //     create a false billing alert for a routine late-invoice event.
    const matched = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.stripeCustomerId, customerId),
      columns: { id: true, subscriptionStatus: true },
    });

    if (matched?.subscriptionStatus === "canceled") {
      // Cancel guard blocked the write — silent no-op, not an error.
      console.log(
        `[webhook] invoice.payment_failed ignored — tenant already canceled. ` +
          `eventId=${eventId} customerId=${customerId} tenantId=${matched.id}`,
      );
      return;
    }

    const msg =
      `[webhook] Unmatched invoice.payment_failed — no tenant found for customer. ` +
      `eventId=${eventId} customerId=${customerId}`;
    console.error(msg);
    // Persist so the admin billing-alerts panel can surface it.
    const alertReason = "No tenant matched for this Stripe customer ID";
    try {
      const inserted = await db
        .insert(stripeAlertsTable)
        .values({
          stripeEventId: eventId,
          eventType: "invoice.payment_failed",
          customerId,
          subscriptionId: null,
          reason: alertReason,
        })
        .onConflictDoNothing({ target: stripeAlertsTable.stripeEventId })
        .returning({ id: stripeAlertsTable.id });
      // Only notify when a genuinely new alert row was written — not on Stripe
      // redeliveries of the same event, which hit the conflict path.
      if (inserted.length > 0) {
        // Fire Slack first so we can include any failure in the email.
        let slackFailure: string | undefined;
        try {
          const slackResult = await sendBillingAlertSlackNotification({
            stripeEventId: eventId,
            eventType: "invoice.payment_failed",
            customerId,
            subscriptionId: null,
            reason: alertReason,
          });
          if (!slackResult.ok) slackFailure = slackResult.error;
        } catch (slackErr) {
          console.error("[webhook] Failed to send billing alert Slack message:", slackErr);
          slackFailure = (slackErr as any)?.message ?? String(slackErr);
        }
        // Persist the Slack failure timestamp so operators and the smoke script
        // can detect missed deliveries without tailing server logs.
        if (slackFailure) {
          try {
            await db
              .update(stripeAlertsTable)
              .set({ slackPostFailed: new Date() })
              .where(eq(stripeAlertsTable.stripeEventId, eventId));
          } catch (updateErr) {
            console.error("[webhook] Failed to persist slackPostFailed flag:", updateErr);
          }
        }
        try {
          await sendBillingAlertNotification({
            stripeEventId: eventId,
            eventType: "invoice.payment_failed",
            customerId,
            subscriptionId: null,
            reason: alertReason,
            ...(slackFailure ? { slackFailure } : {}),
          });
        } catch (emailErr) {
          console.error("[webhook] Failed to send billing alert email:", emailErr);
        }
      }
    } catch (dbErr) {
      console.error("[webhook] Failed to persist billing alert:", dbErr);
    }
  }
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  const { artworkId, tenantId, fulfillmentType } = session.metadata ?? {};

  if (!artworkId || !tenantId || !fulfillmentType) {
    console.error("Missing metadata in session:", session.id);
    return;
  }

  // Idempotency: skip if order already created
  const existing = await db.query.ordersTable.findFirst({
    where: eq(ordersTable.stripeSessionId, session.id),
  });
  if (existing) return;

  // Validate artwork belongs to the stated tenant before mutating anything
  const artwork = await db.query.artworksTable.findFirst({
    where: and(
      eq(artworksTable.id, artworkId),
      eq(artworksTable.tenantId, tenantId),
    ),
  });
  if (!artwork) {
    console.error(
      `Webhook integrity error: artwork ${artworkId} not found for tenant ${tenantId}`,
    );
    return;
  }

  const buyerEmail =
    session.customer_details?.email ?? (session as any).customer_email ?? "";
  const buyerName = session.customer_details?.name ?? null;

  // Create order + order item + mark artwork SOLD atomically.
  // If any step fails the whole transaction rolls back, the webhook returns
  // 500, and Stripe retries — the idempotency check above makes the retry safe.
  const order = await db.transaction(async (tx) => {
    const [createdOrder] = await tx
      .insert(ordersTable)
      .values({
        tenantId,
        stripeSessionId: session.id,
        stripePaymentIntentId:
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : null,
        buyerEmail,
        buyerName,
        status: "PAID",
        fulfillmentType: fulfillmentType as "SHIP" | "PICKUP" | "FRAMING_JOB",
        totalCents: session.amount_total ?? 0,
        // Persist the platform commission actually charged on this sale.
        // Checkout sets application_fee_amount = calcApplicationFee(price),
        // and amount_total equals the artwork price, so recomputing here
        // matches the fee Stripe collected.
        applicationFeeCents:
          session.amount_total != null
            ? calcApplicationFee(session.amount_total)
            : null,
      })
      .returning();

    await tx.insert(orderItemsTable).values({
      orderId: createdOrder.id,
      artworkId,
      tenantId,
      priceCents: artwork.price ?? session.amount_total ?? 0,
      artworkTitle: artwork.title,
      artworkSku: artwork.sku,
    });

    await tx
      .update(artworksTable)
      .set({ status: "SOLD" })
      .where(eq(artworksTable.id, artworkId));

    return createdOrder;
  });

  // Fetch tenant (needed for email + iFramer)
  const tenant = await db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.id, tenantId),
  });

  // Send confirmation email (non-fatal — the order is already committed, so a
  // failed email must not turn the webhook into a 500/Stripe retry loop).
  // Success and failure are both persisted so unsent emails can be retried
  // from the admin order page.
  if (buyerEmail && tenant) {
    try {
      await sendOrderConfirmation({
        buyerEmail,
        buyerName,
        artworkTitle: artwork.title,
        fulfillmentType,
        orderRef: order.id.slice(0, 8).toUpperCase(),
        tenantName: tenant.businessName,
        orderLookupUrl: getTenantUrl(tenant, "/orders"),
      });
      await db
        .update(ordersTable)
        .set({
          emailSentAt: new Date(),
          emailError: null,
          emailAttempts: 1,
          emailLastAttemptAt: new Date(),
        })
        .where(eq(ordersTable.id, order.id));
    } catch (err) {
      const message = (err as any)?.message ?? String(err);
      console.error(
        `Order confirmation email failed for order ${order.id}:`,
        message,
      );
      try {
        await db
          .update(ordersTable)
          .set({
            emailError: message,
            emailAttempts: 1,
            emailLastAttemptAt: new Date(),
          })
          .where(eq(ordersTable.id, order.id));
      } catch (dbErr) {
        console.error(
          `Failed to record email error for order ${order.id}:`,
          (dbErr as any)?.message ?? dbErr,
        );
      }
    }
  }

  // ── iFramer job creation ───────────────────────────────────────────────────
  // Triggered only for FRAMING_JOB orders where the tenant has an iFramer account.
  if (fulfillmentType === "FRAMING_JOB" && tenant?.iframerAccountId) {
    await createIFramerJobForOrder({
      orderId: order.id,
      iframerAccountId: tenant.iframerAccountId,
      artwork: {
        title: artwork.title,
        id: artwork.id,
        dimensionsW: artwork.dimensionsW,
        dimensionsH: artwork.dimensionsH,
        condition: artwork.condition,
      },
    });
  }
}

async function createIFramerJobForOrder({
  orderId,
  iframerAccountId,
  artwork,
}: {
  orderId: string;
  iframerAccountId: string;
  artwork: {
    title: string;
    id: string;
    dimensionsW: number | null;
    dimensionsH: number | null;
    condition: string | null;
  };
}) {
  try {
    const result = await createIFramerJob({
      accountId: iframerAccountId,
      artworkTitle: artwork.title,
      // Convert mm → metres (iFramer API expects metres)
      widthM: artwork.dimensionsW != null ? artwork.dimensionsW / 1000 : null,
      heightM: artwork.dimensionsH != null ? artwork.dimensionsH / 1000 : null,
      condition: artwork.condition,
      sourceOrderId: orderId,
      sourceArtworkId: artwork.id,
    });

    await db
      .update(ordersTable)
      .set({ iframerJobId: result.jobId, iframerJobError: null })
      .where(eq(ordersTable.id, orderId));

    console.log(`iFramer job created: ${result.jobId} for order ${orderId}`);
  } catch (err) {
    const message =
      err instanceof IFramerError
        ? err.message
        : `Unexpected error: ${(err as any)?.message ?? String(err)}`;

    console.error(`iFramer job creation failed for order ${orderId}:`, message);

    await db
      .update(ordersTable)
      .set({ iframerJobError: message })
      .where(eq(ordersTable.id, orderId));
  }
}

async function handleCheckoutExpired(session: Stripe.Checkout.Session) {
  const { artworkId, tenantId } = session.metadata ?? {};
  if (!artworkId || !tenantId) return;

  const paidOrder = await db.query.ordersTable.findFirst({
    where: eq(ordersTable.stripeSessionId, session.id),
  });
  if (paidOrder) return;

  await db
    .update(artworksTable)
    .set({ status: "AVAILABLE" })
    .where(
      and(
        eq(artworksTable.id, artworkId),
        eq(artworksTable.tenantId, tenantId),
        eq(artworksTable.status, "RESERVED"),
      ),
    );
}
