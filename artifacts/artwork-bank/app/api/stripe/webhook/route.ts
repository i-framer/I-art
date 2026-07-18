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
    try {
      const stripe = await getStripeClient();
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

  // Mark artwork SOLD
  await db
    .update(artworksTable)
    .set({ status: "SOLD" })
    .where(eq(artworksTable.id, artworkId));

  // Fetch tenant (needed for email + iFramer)
  const tenant = await db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.id, tenantId),
  });

  // Send confirmation email (non-fatal)
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
