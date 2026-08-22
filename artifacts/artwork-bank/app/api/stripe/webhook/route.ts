import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { db } from "@workspace/db";
import {
  ordersTable,
  orderItemsTable,
  artworksTable,
  tenantsTable,
  stripeAlertsTable,
  freightQuotesTable,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import {
  getStripeClient,
  getStripeWebhookSecret,
  calcApplicationFee,
  StripeNotConfiguredError,
} from "@/lib/stripe";
import {
  sendBillingAlertNotification,
  sendGalleryNewOrderNotification,
  sendOrderConfirmation,
} from "@/lib/email";
import { sendBillingAlertSlackNotification } from "@/lib/slack";
import { getTenantUrl } from "@/lib/base-url";
import { createIFramerJob, IFramerError } from "@/lib/iframer";
import type Stripe from "stripe";

export const dynamic = "force-dynamic";
const NO_GALLERY_ORDER_EMAIL_ERROR = "no gallery contact email";

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
        await handleSubscriptionCheckoutCompleted(session, event.id, event.type);
      } else {
        await handleCheckoutCompleted(session, event.id);
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
    } else if (event.type === "account.updated") {
      await handleAccountUpdated(event.data.object as Stripe.Account);
    } else if (event.type === "charge.refunded") {
      await handleChargeRefunded(event.data.object as Stripe.Charge);
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
  eventId: string,
  eventType: string,
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
  // status. Only set status here when this checkout introduces a NEW
  // subscription — if a subscription event for the same subscription already
  // wrote a status (e.g. an out-of-order `deleted` → canceled), keep it.
  // Fetch the real subscription status (may be "trialing", not "active").
  const isNewSubscription =
    !tenant.subscriptionStatus ||
    (subscriptionId != null && tenant.stripeSubscriptionId !== subscriptionId);

  let newStatus: string | null = null;
  let newTrialEnd: Date | null | undefined; // undefined = don't touch the column
  if (isNewSubscription && subscriptionId) {
    try {
      const stripeClient = await getStripeClient();
      const sub = await stripeClient.subscriptions.retrieve(subscriptionId);
      newStatus = sub.status;
      newTrialEnd = sub.trial_end ? new Date(sub.trial_end * 1000) : null;
    } catch (err: any) {
      // ── Fail-open decision ────────────────────────────────────────────────
      // We grant "active" status rather than blocking access when Stripe is
      // unreachable.  Rationale: a transient network blip should never lock out
      // a paying customer — the subscription.* events will correct the status
      // once Stripe recovers.  The risk of an extended outage (key mismatch,
      // Stripe downtime) is mitigated by two mandatory operator signals:
      //   1. A durable stripe_alerts row is written immediately so the admin
      //      billing-alerts panel can surface it without tailing logs.
      //   2. A Slack + email notification is dispatched; if Slack fails, the
      //      `slackPostFailed` timestamp on the alert row is set so operators
      //      can detect a broken alert chain at a glance (and replay it).
      // If your risk tolerance is lower you can change newStatus to "trialing"
      // or "incomplete" here — just ensure the subscription.* webhook handler
      // will later promote the tenant to "active" on success.
      const retrieveFailReason =
        `subscriptions.retrieve failed (falling back to "active") — ` +
        `subscriptionId=${subscriptionId} reason=${err?.message ?? String(err)}`;
      console.error(`[webhook] ${retrieveFailReason}`);
      newStatus = "active";

      // Persist an operator-facing billing alert so this does not go unnoticed.
      // Uses the checkout event ID for deduplication — Stripe retries of the same
      // event are silently ignored via onConflictDoNothing.
      try {
        const inserted = await db
          .insert(stripeAlertsTable)
          .values({
            stripeEventId: eventId,
            eventType,
            customerId: customerId ?? null,
            subscriptionId,
            reason: retrieveFailReason,
          })
          .onConflictDoNothing({ target: stripeAlertsTable.stripeEventId })
          .returning({ id: stripeAlertsTable.id });

        if (inserted.length > 0) {
          let slackFailure: string | undefined;
          try {
            const slackResult = await sendBillingAlertSlackNotification({
              stripeEventId: eventId,
              eventType,
              customerId: customerId ?? null,
              subscriptionId,
              reason: retrieveFailReason,
            });
            if (!slackResult.ok) slackFailure = slackResult.error;
          } catch (slackErr) {
            console.error("[webhook] Failed to send billing alert Slack message:", slackErr);
            slackFailure = (slackErr as any)?.message ?? String(slackErr);
          }
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
              subscriptionId,
              reason: retrieveFailReason,
              ...(slackFailure ? { slackFailure } : {}),
            });
          } catch (emailErr) {
            console.error("[webhook] Failed to send billing alert email:", emailErr);
          }
        }
      } catch (dbErr) {
        console.error("[webhook] Failed to persist billing alert for retrieve failure:", dbErr);
      }
    }
  }

  await db
    .update(tenantsTable)
    .set({
      ...(customerId ? { stripeCustomerId: customerId } : {}),
      ...(subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
      ...(newStatus ? { subscriptionStatus: newStatus } : {}),
      ...(newTrialEnd !== undefined ? { trialEnd: newTrialEnd } : {}),
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
      trialEnd: subscription.trial_end
        ? new Date(subscription.trial_end * 1000)
        : null,
      ...(customerId ? { stripeCustomerId: customerId } : {}),
    })
    .where(and(where, cancelGuard))
    .returning({ id: tenantsTable.id, iframerAccountId: tenantsTable.iframerAccountId });

  // When a matched i-Framer-linked tenant loses billing access, persist a durable
  // stripe_alert row and notify the operator — matching the delivery pattern used
  // for unmatched events so Slack failures are recoverable via replay.
  if (updated.length > 0) {
    const { iframerAccountId } = updated[0]!;
    const BILLING_LOSS_STATUSES = new Set([
      "past_due",
      "canceled",
      "unpaid",
      "incomplete_expired",
      "paused",
    ]);
    if (iframerAccountId && BILLING_LOSS_STATUSES.has(status)) {
      const alertReason =
        `Subscription status changed to "${status}" for i-Framer Premium account \`${iframerAccountId}\``;
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
        // Only notify on the first delivery — conflict means Stripe retried the
        // same event and the alert row (with its Slack state) already exists.
        if (inserted.length > 0) {
          let slackFailure: string | undefined;
          try {
            const slackResult = await sendBillingAlertSlackNotification({
              stripeEventId: eventId,
              eventType,
              customerId: customerId ?? null,
              subscriptionId: subscription.id,
              reason: alertReason,
              iframerAccountId,
            });
            if (!slackResult.ok) slackFailure = slackResult.error;
          } catch (slackErr) {
            console.error(
              "[webhook] Failed to send i-Framer billing alert Slack message:",
              slackErr,
            );
            slackFailure = (slackErr as any)?.message ?? String(slackErr);
          }
          if (slackFailure) {
            try {
              await db
                .update(stripeAlertsTable)
                .set({ slackPostFailed: new Date() })
                .where(eq(stripeAlertsTable.stripeEventId, eventId));
            } catch (updateErr) {
              console.error(
                "[webhook] Failed to persist slackPostFailed flag for i-Framer alert:",
                updateErr,
              );
            }
          }
        }
      } catch (dbErr) {
        console.error(
          "[webhook] Failed to persist i-Framer billing alert:",
          dbErr,
        );
      }
    }
  }

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
    .returning({ id: tenantsTable.id, iframerAccountId: tenantsTable.iframerAccountId });

  // When a matched i-Framer-linked tenant's invoice payment fails, persist a durable
  // stripe_alert row and notify the operator — matching the delivery pattern used
  // for unmatched events so Slack failures are recoverable via replay.
  if (updated.length > 0) {
    const { iframerAccountId } = updated[0]!;
    if (iframerAccountId) {
      const alertReason =
        `Invoice payment failed — tenant status set to past_due (i-Framer Premium account \`${iframerAccountId}\`)`;
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
        // Only notify on the first delivery — conflict means Stripe retried the
        // same event and the alert row (with its Slack state) already exists.
        if (inserted.length > 0) {
          let slackFailure: string | undefined;
          try {
            const slackResult = await sendBillingAlertSlackNotification({
              stripeEventId: eventId,
              eventType: "invoice.payment_failed",
              customerId,
              subscriptionId: null,
              reason: alertReason,
              iframerAccountId,
            });
            if (!slackResult.ok) slackFailure = slackResult.error;
          } catch (slackErr) {
            console.error(
              "[webhook] Failed to send i-Framer billing alert Slack message:",
              slackErr,
            );
            slackFailure = (slackErr as any)?.message ?? String(slackErr);
          }
          if (slackFailure) {
            try {
              await db
                .update(stripeAlertsTable)
                .set({ slackPostFailed: new Date() })
                .where(eq(stripeAlertsTable.stripeEventId, eventId));
            } catch (updateErr) {
              console.error(
                "[webhook] Failed to persist slackPostFailed flag for i-Framer alert:",
                updateErr,
              );
            }
          }
        }
      } catch (dbErr) {
        console.error(
          "[webhook] Failed to persist i-Framer billing alert:",
          dbErr,
        );
      }
    }
  }

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

async function handleCheckoutCompleted(session: Stripe.Checkout.Session, eventId: string) {
  const {
    artworkId,
    tenantId,
    fulfillmentType,
    freightQuoteId,
    freightMethodName,
    freightClass: freightClassMetadata,
    freightCents: freightCentsMetadata,
  } = session.metadata ?? {};
  const customerId = typeof session.customer === "string" ? session.customer : null;

  if (!artworkId || !tenantId || !fulfillmentType) {
    const reason =
      `checkout.session.completed missing required metadata — ` +
      `sessionId=${session.id} ` +
      `artworkId=${artworkId ?? "(missing)"} ` +
      `tenantId=${tenantId ?? "(missing)"} ` +
      `fulfillmentType=${fulfillmentType ?? "(missing)"}`;
    console.error("[webhook]", reason);
    // Persist a durable alert so a paid session can never vanish silently.
    // Stripe treats our 200 as successful delivery and will not retry, so
    // the alert row is the only operator-visible record of this event.
    try {
      const inserted = await db
        .insert(stripeAlertsTable)
        .values({
          stripeEventId: eventId,
          eventType: "checkout.session.completed",
          customerId,
          reason,
        })
        .onConflictDoNothing({ target: stripeAlertsTable.stripeEventId })
        .returning({ id: stripeAlertsTable.id });

      if (inserted.length > 0) {
        let slackFailure: string | undefined;
        try {
          const slackResult = await sendBillingAlertSlackNotification({
            stripeEventId: eventId,
            eventType: "checkout.session.completed",
            customerId,
            subscriptionId: null,
            reason,
          });
          if (!slackResult.ok) slackFailure = slackResult.error;
        } catch (slackErr) {
          console.error("[webhook] Failed to send billing alert Slack message:", slackErr);
          slackFailure = (slackErr as any)?.message ?? String(slackErr);
        }
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
      }
    } catch (dbErr) {
      console.error("[webhook] Failed to persist metadata-missing alert:", dbErr);
    }
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
    const reason =
      `Webhook integrity error: artwork not found or tenant mismatch — ` +
      `sessionId=${session.id} artworkId=${artworkId} tenantId=${tenantId}`;
    console.error("[webhook]", reason);
    // Same durable-alert approach: 200 is intentional (Stripe delivered the event
    // successfully; the data is simply inconsistent). Returning 5xx would just
    // cause Stripe to re-deliver the same malformed event repeatedly.
    try {
      const inserted = await db
        .insert(stripeAlertsTable)
        .values({
          stripeEventId: eventId,
          eventType: "checkout.session.completed",
          customerId,
          reason,
        })
        .onConflictDoNothing({ target: stripeAlertsTable.stripeEventId })
        .returning({ id: stripeAlertsTable.id });

      if (inserted.length > 0) {
        let slackFailure: string | undefined;
        try {
          const slackResult = await sendBillingAlertSlackNotification({
            stripeEventId: eventId,
            eventType: "checkout.session.completed",
            customerId,
            subscriptionId: null,
            reason,
          });
          if (!slackResult.ok) slackFailure = slackResult.error;
        } catch (slackErr) {
          console.error("[webhook] Failed to send billing alert Slack message:", slackErr);
          slackFailure = (slackErr as any)?.message ?? String(slackErr);
        }
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
      }
    } catch (dbErr) {
      console.error("[webhook] Failed to persist artwork-mismatch alert:", dbErr);
    }
    return;
  }

  const freightCents = (() => {
    if (!freightCentsMetadata) return 0;
    const value = Number(freightCentsMetadata);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  })();
  const freightClass: "SMALL" | "MEDIUM" | "LARGE" | "TUBE" | null =
    freightClassMetadata === "SMALL" ||
    freightClassMetadata === "MEDIUM" ||
    freightClassMetadata === "LARGE" ||
    freightClassMetadata === "TUBE"
      ? (freightClassMetadata as "SMALL" | "MEDIUM" | "LARGE" | "TUBE")
      : null;
  const acceptedQuote =
    fulfillmentType === "SHIP" && freightQuoteId
      ? await db.query.freightQuotesTable.findFirst({
          where: and(
            eq(freightQuotesTable.id, freightQuoteId),
            eq(freightQuotesTable.tenantId, tenantId),
            eq(freightQuotesTable.artworkId, artworkId),
          ),
        })
      : null;
  const freightSnapshot =
    fulfillmentType === "SHIP"
      ? acceptedQuote
        ? {
            freightMethodName: acceptedQuote.serviceName,
            freightClass: acceptedQuote.freightClass,
            freightCents: acceptedQuote.freightCents,
            freightProvider: acceptedQuote.provider,
            freightServiceCode: acceptedQuote.serviceCode,
            freightQuoteId: acceptedQuote.id,
            shippingAddressJson: JSON.stringify({
              line1: acceptedQuote.destinationLine1,
              line2: acceptedQuote.destinationLine2,
              suburb: acceptedQuote.destinationSuburb,
              state: acceptedQuote.destinationState,
              postcode: acceptedQuote.destinationPostcode,
              countryCode: acceptedQuote.destinationCountryCode,
            }),
          }
        : {
            // Sessions created before quote persistence are still allowed to
            // complete. New checkouts always have an acceptedQuote.
            freightMethodName: freightMethodName?.trim() || null,
            freightClass,
            freightCents,
            freightProvider: session.metadata?.freightProvider?.trim() || null,
            freightServiceCode: session.metadata?.freightServiceCode?.trim() || null,
            freightQuoteId: freightQuoteId?.trim() || null,
            shippingAddressJson: null,
          }
      : {
          freightMethodName: null,
          freightClass: null,
          freightCents: 0,
          freightProvider: null,
          freightServiceCode: null,
          freightQuoteId: null,
          shippingAddressJson: null,
        };

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
        ...freightSnapshot,
        // Persist the platform commission actually charged on this sale.
        // The commission rate and fee were computed at checkout time and passed
        // through session.metadata so we don't need to recompute.
        applicationFeeCents:
          session.amount_total != null
            ? (() => {
                const recordedFee = session.metadata?.applicationFeeCents;
                const recordedFeeCents =
                  recordedFee != null ? Number(recordedFee) : Number.NaN;
                if (
                  Number.isSafeInteger(recordedFeeCents) &&
                  recordedFeeCents >= 0
                ) {
                  return recordedFeeCents;
                }
                const bp = session.metadata?.commissionBasisPoints;
                const bpNum = bp != null ? parseInt(bp, 10) : null;
                return bpNum != null && isFinite(bpNum)
                  ? Math.round(session.amount_total * (bpNum / 100 / 100))
                  : calcApplicationFee(session.amount_total);
              })()
            : null,
        // Record the commission rate that was in effect at checkout time.
        commissionBasisPoints: (() => {
          const bp = session.metadata?.commissionBasisPoints;
          if (!bp) return null;
          const n = parseInt(bp, 10);
          return isFinite(n) ? n : null;
        })(),
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

  // Notify the owning gallery separately from the buyer confirmation. The
  // order is already committed, so transport or bookkeeping failures are
  // logged and persisted where possible but never turn this webhook into a
  // Stripe retry loop. The stripeSessionId idempotency guard above ensures a
  // replay cannot dispatch this notification twice.
  if (tenant?.contactEmail) {
    const attemptedAt = new Date();
    let deliveryError: string | null = null;
    try {
      await sendGalleryNewOrderNotification({
        galleryEmail: tenant.contactEmail,
        buyerEmail,
        buyerName,
        artworkTitle: artwork.title,
        artworkSku: artwork.sku,
        totalCents: order.totalCents,
        fulfillmentType,
        orderRef: order.id.slice(0, 8).toUpperCase(),
        tenantName: tenant.businessName,
      });
    } catch (err) {
      deliveryError = (err as any)?.message ?? String(err);
      console.error(
        `Gallery new-order email failed for order ${order.id}:`,
        deliveryError,
      );
    }

    if (deliveryError === null) {
      // Keep bookkeeping errors separate from transport errors. If the provider
      // accepted the message but this write fails, recording it as an email
      // failure would be false and could prompt a duplicate manual retry.
      try {
        await db
          .update(ordersTable)
          .set({
            galleryOrderEmailSentAt: attemptedAt,
            galleryOrderEmailError: null,
            galleryOrderEmailAttempts: 1,
            galleryOrderEmailLastAttemptAt: attemptedAt,
          })
          .where(eq(ordersTable.id, order.id));
      } catch (dbErr) {
        console.error(
          `Failed to record successful gallery email for order ${order.id}:`,
          (dbErr as any)?.message ?? dbErr,
        );
      }
    } else {
      // A confirmed transport failure is retryable. Persist it independently;
      // failure to write this state must still remain non-fatal to Stripe.
      try {
        await db
          .update(ordersTable)
          .set({
            galleryOrderEmailError: deliveryError,
            galleryOrderEmailAttempts: 1,
            galleryOrderEmailLastAttemptAt: attemptedAt,
          })
          .where(eq(ordersTable.id, order.id));
      } catch (dbErr) {
        console.error(
          `Failed to record gallery email error for order ${order.id}:`,
          (dbErr as any)?.message ?? dbErr,
        );
      }
    }
  } else if (tenant) {
    // Keep the reason durable without consuming a delivery attempt. A future
    // retry can send once the gallery configures a contact email.
    try {
      await db
        .update(ordersTable)
        .set({ galleryOrderEmailError: NO_GALLERY_ORDER_EMAIL_ERROR })
        .where(eq(ordersTable.id, order.id));
    } catch (dbErr) {
      console.error(
        `Failed to record missing gallery contact email for order ${order.id}:`,
        (dbErr as any)?.message ?? dbErr,
      );
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

/**
 * Cache Stripe Connect account readiness onto the tenant row.
 *
 * Stripe fires account.updated whenever the account's charges_enabled,
 * payouts_enabled, or details_submitted fields change.  We persist those
 * values so the checkout route can gate on DB state instead of making a live
 * Stripe round-trip on every buyer checkout attempt.
 *
 * The event arrives on the platform account (not the connected account), so
 * we match by stripeAccountId.
 */
async function handleAccountUpdated(account: Stripe.Account) {
  const updated = await db
    .update(tenantsTable)
    .set({
      stripeChargesEnabled: account.charges_enabled ?? false,
      stripePayoutsEnabled: account.payouts_enabled ?? false,
    })
    .where(eq(tenantsTable.stripeAccountId, account.id))
    .returning({ id: tenantsTable.id });

  if (updated.length === 0) {
    // No tenant owns this account ID — could be a test account or an account
    // that was disconnected.  Log but do not error (returning 200 is correct
    // so Stripe does not keep retrying).
    console.warn(
      `[webhook] account.updated — no tenant matched stripeAccountId=${account.id}. ` +
        `charges_enabled=${account.charges_enabled} payouts_enabled=${account.payouts_enabled}`,
    );
    return;
  }

  console.log(
    `[webhook] account.updated — cached readiness for tenant ${updated[0]!.id}: ` +
      `charges_enabled=${account.charges_enabled} payouts_enabled=${account.payouts_enabled}`,
  );
}

// ── External refund sync ──────────────────────────────────────────────────────

/**
 * Stripe fires `charge.refunded` whenever any refund is created against a
 * charge — including refunds initiated directly from the Stripe dashboard.
 * Without this handler, external refunds silently return 200 and the order's
 * refundedAmountCents never updates.
 *
 * Design decisions:
 * - We use charge.amount_refunded (cumulative Stripe total) to SET the DB
 *   value, not a delta, so the result is always the authoritative Stripe total.
 * - Idempotency + out-of-order guard: only update when the new Stripe total is
 *   strictly greater than the current DB total.  This prevents a stale/duplicate
 *   webhook from overwriting a more recent value.
 * - Full refund (charge.refunded = true) also sets status = 'CANCELLED' and
 *   queues the buyer status-update email (picked up by the email sweep).
 * - Partial refunds update refundedAmountCents; buyer notification is not
 *   queued here because the sweep only sends status-change emails.  Operators
 *   should configure Stripe to send their own refund receipts for partials, or
 *   issue partial refunds via the admin UI which handles notification directly.
 */
async function handleChargeRefunded(charge: Stripe.Charge) {
  const paymentIntentId =
    typeof charge.payment_intent === "string"
      ? charge.payment_intent
      : (charge.payment_intent as Stripe.PaymentIntent | null)?.id ?? null;

  if (!paymentIntentId) {
    console.warn(
      `[webhook] charge.refunded — charge ${charge.id} has no payment_intent, skipping`,
    );
    return;
  }

  const order = await db.query.ordersTable.findFirst({
    where: eq(ordersTable.stripePaymentIntentId, paymentIntentId),
    columns: {
      id: true,
      tenantId: true,
      status: true,
      totalCents: true,
      refundedAmountCents: true,
      // Needed for the duplicate-notification guard below.
      statusEmailQueuedAt: true,
      statusEmailAttempts: true,
    },
  });

  if (!order) {
    // No order matches this payment intent — may be a subscription charge
    // or a charge on a connected account we don't track.  200 is correct so
    // Stripe does not keep retrying.
    console.warn(
      `[webhook] charge.refunded — no order for payment_intent=${paymentIntentId}, charge=${charge.id}`,
    );
    return;
  }

  const amountRefunded = charge.amount_refunded;
  const isFullRefund = charge.refunded;
  // Latest refund is first in the list (Stripe returns newest-first).
  const latestRefundId = charge.refunds?.data?.[0]?.id ?? null;

  // Idempotency + out-of-order guard: only write when the Stripe cumulative
  // total is strictly greater than what we have.  Covers:
  //   - Duplicate delivery of the same event → skip (same value)
  //   - Out-of-order partial-refund events → skip (lower total)
  const [updated] = await db
    .update(ordersTable)
    .set({
      refundedAmountCents: amountRefunded,
      // Preserve an existing refundedAt; set to now only on first refund.
      refundedAt: sql`coalesce(${ordersTable.refundedAt}, now())`,
      ...(latestRefundId ? { stripeRefundId: latestRefundId } : {}),
      ...(isFullRefund ? { status: "CANCELLED" } : {}),
    })
    .where(
      and(
        eq(ordersTable.id, order.id),
        sql`(${ordersTable.refundedAmountCents} IS NULL OR ${ordersTable.refundedAmountCents} < ${amountRefunded})`,
      ),
    )
    .returning({ id: ordersTable.id });

  if (!updated) {
    console.log(
      `[webhook] charge.refunded — order ${order.id}: already recorded >= ${amountRefunded}c, skip`,
    );
    return;
  }

  // Queue the buyer status-update email for full refunds.  The email sweep
  // reads statusEmailQueuedAt and sends the message on the next pass.
  //
  // Guard: skip if a status notification has already been sent or is already
  // pending in the sweep queue.  Without this guard, a charge.refunded event
  // fired AFTER the admin used markCancelled (which calls notifyBuyerOfUpdate
  // and clears statusEmailQueuedAt on success) would reset the queue and cause
  // the sweep to send a duplicate cancellation email to the buyer.
  //
  //   Already sent  (queuedAt = null, attempts >= 1): skip — buyer notified ✓
  //   Already queued (queuedAt != null):               skip — sweep handles it ✓
  //   Never notified (queuedAt = null, attempts = 0):  queue — buyer needs notif ✓
  const alreadySentOrPending =
    order.statusEmailQueuedAt !== null ||
    (order.statusEmailAttempts ?? 0) > 0;

  if (isFullRefund && !alreadySentOrPending) {
    await db
      .update(ordersTable)
      .set({
        statusEmailQueuedAt: new Date(),
        statusEmailError: null,
        statusEmailAttempts: 0,
      })
      .where(eq(ordersTable.id, order.id));
  }

  console.log(
    `[webhook] charge.refunded — order ${order.id}: ` +
      `refundedAmountCents=${amountRefunded}, full=${isFullRefund}, refundId=${latestRefundId}`,
  );
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
