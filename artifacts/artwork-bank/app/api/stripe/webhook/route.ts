import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { db } from "@workspace/db";
import {
  ordersTable,
  orderItemsTable,
  artworksTable,
  tenantsTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { getStripeClient, getStripeWebhookSecret } from "@/lib/stripe";
import { sendOrderConfirmation } from "@/lib/email";
import type Stripe from "stripe";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.text();
  const sig = (await headers()).get("stripe-signature");

  const stripe = await getStripeClient();
  const webhookSecret = await getStripeWebhookSecret();

  const isProd = process.env.NODE_ENV === "production";
  // Dev-mode bypass is only allowed when explicitly opted in AND not in production
  const devBypass =
    !isProd && process.env.STRIPE_WEBHOOK_DEV_BYPASS === "true";

  let event: Stripe.Event;

  if (webhookSecret && sig) {
    // Always verify when we have both a secret and a signature
    try {
      event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
    } catch (err: any) {
      console.error("Webhook signature verification failed:", err.message);
      return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
    }
  } else if (devBypass) {
    // Development only: skip verification when STRIPE_WEBHOOK_DEV_BYPASS=true
    try {
      event = JSON.parse(body) as Stripe.Event;
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
  } else {
    // Missing secret or signature — reject.
    // In production this is always enforced. In dev, set STRIPE_WEBHOOK_DEV_BYPASS=true to skip.
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
      await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
    } else if (event.type === "checkout.session.expired") {
      await handleCheckoutExpired(event.data.object as Stripe.Checkout.Session);
    }
  } catch (err: any) {
    console.error("Webhook handler error:", err);
    return NextResponse.json({ error: "Handler error" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
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

  // Create order
  const [order] = await db
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
      applicationFeeCents: null,
    })
    .returning();

  // Create order item
  await db.insert(orderItemsTable).values({
    orderId: order.id,
    artworkId,
    tenantId,
    priceCents: artwork.price ?? session.amount_total ?? 0,
    artworkTitle: artwork.title,
    artworkSku: artwork.sku,
  });

  // Mark artwork SOLD (regardless of prior status — payment is confirmed)
  await db
    .update(artworksTable)
    .set({ status: "SOLD" })
    .where(eq(artworksTable.id, artworkId));

  // Send confirmation email (non-fatal if it fails)
  const tenant = await db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.id, tenantId),
  });

  if (buyerEmail && tenant) {
    await sendOrderConfirmation({
      buyerEmail,
      buyerName,
      artworkTitle: artwork.title,
      fulfillmentType,
      orderRef: order.id.slice(0, 8).toUpperCase(),
      tenantName: tenant.businessName,
    });
  }
}

async function handleCheckoutExpired(session: Stripe.Checkout.Session) {
  // If a session expires, revert RESERVED artwork back to AVAILABLE
  const { artworkId, tenantId } = session.metadata ?? {};
  if (!artworkId || !tenantId) return;

  // Only revert if no paid order was created for this session
  const paidOrder = await db.query.ordersTable.findFirst({
    where: eq(ordersTable.stripeSessionId, session.id),
  });
  if (paidOrder) return; // webhook ordering edge case — leave SOLD

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
