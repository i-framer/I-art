"use server";
import { requireActiveBillingAccess } from "@/lib/billing";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@workspace/db";
import { ordersTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { orderItemsTable, tenantsTable } from "@workspace/db";
import { sendOrderConfirmation, sendOrderStatusUpdate, sendPartialRefundNotification } from "@/lib/email";
import { getTenantUrl } from "@/lib/base-url";
import { getStripeClient, StripeNotConfiguredError } from "@/lib/stripe";

async function requireOwnership(orderId: string) {
  const session = await getSession();
  if (!session.userId) redirect("/login");
  await requireActiveBillingAccess(session.tenantId);
  const order = await db.query.ordersTable.findFirst({
    where: and(
      eq(ordersTable.id, orderId),
      eq(ordersTable.tenantId, session.tenantId),
    ),
  });
  if (!order) throw new Error("Order not found.");
  return order;
}

/**
 * Try to email the buyer about an order update right away. On failure the
 * email stays queued (statusEmailQueuedAt) so the background sweep retries it.
 */
async function notifyBuyerOfUpdate(orderId: string): Promise<void> {
  const now = new Date();
  // Queue first (resets the retry budget), then attempt an immediate send.
  await db
    .update(ordersTable)
    .set({
      statusEmailQueuedAt: now,
      statusEmailError: null,
      statusEmailAttempts: 0,
    })
    .where(eq(ordersTable.id, orderId));

  const order = await db.query.ordersTable.findFirst({
    where: eq(ordersTable.id, orderId),
  });
  if (!order || !order.buyerEmail) return;

  const [item, tenant] = await Promise.all([
    db.query.orderItemsTable.findFirst({
      where: eq(orderItemsTable.orderId, orderId),
    }),
    db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, order.tenantId),
    }),
  ]);
  if (!item || !tenant) return;

  try {
    await sendOrderStatusUpdate({
      buyerEmail: order.buyerEmail,
      buyerName: order.buyerName,
      artworkTitle: item.artworkTitle,
      status: order.status,
      trackingNote: order.trackingNote,
      orderRef: order.id.slice(0, 8).toUpperCase(),
      tenantName: tenant.businessName,
      orderLookupUrl: getTenantUrl(tenant, "/orders"),
    });
    await db
      .update(ordersTable)
      .set({
        statusEmailQueuedAt: null,
        statusEmailError: null,
        statusEmailAttempts: 1,
        statusEmailLastAttemptAt: now,
      })
      .where(eq(ordersTable.id, orderId));
  } catch (err) {
    await db
      .update(ordersTable)
      .set({
        statusEmailError: (err as any)?.message ?? String(err),
        statusEmailAttempts: 1,
        statusEmailLastAttemptAt: now,
      })
      .where(eq(ordersTable.id, orderId));
  }
}

/**
 * Send a partial refund notification to the buyer. On failure the error is
 * recorded on the order row (statusEmailError) so the operator can see it;
 * this does NOT use the retry queue because partial refunds are one-shot events.
 */
async function notifyBuyerOfPartialRefund(
  orderId: string,
  refundedAmountCents: number,
): Promise<void> {
  const now = new Date();

  const order = await db.query.ordersTable.findFirst({
    where: eq(ordersTable.id, orderId),
  });
  if (!order || !order.buyerEmail) return;

  const [item, tenant] = await Promise.all([
    db.query.orderItemsTable.findFirst({
      where: eq(orderItemsTable.orderId, orderId),
    }),
    db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, order.tenantId),
    }),
  ]);
  if (!item || !tenant) return;

  try {
    await sendPartialRefundNotification({
      buyerEmail: order.buyerEmail,
      buyerName: order.buyerName,
      artworkTitle: item.artworkTitle,
      refundedAmountCents,
      orderRef: order.id.slice(0, 8).toUpperCase(),
      tenantName: tenant.businessName,
      orderLookupUrl: getTenantUrl(tenant, "/orders"),
    });
    await db
      .update(ordersTable)
      .set({
        statusEmailError: null,
        statusEmailLastAttemptAt: now,
      })
      .where(eq(ordersTable.id, orderId));
  } catch (err) {
    await db
      .update(ordersTable)
      .set({
        statusEmailError: (err as any)?.message ?? String(err),
        statusEmailLastAttemptAt: now,
      })
      .where(eq(ordersTable.id, orderId));
  }
}

export async function markFulfilled(formData: FormData): Promise<void> {
  const orderId = formData.get("orderId") as string;
  await requireOwnership(orderId);
  await db
    .update(ordersTable)
    .set({ status: "FULFILLED" })
    .where(eq(ordersTable.id, orderId));
  await notifyBuyerOfUpdate(orderId);
  revalidatePath(`/orders/${orderId}`);
  revalidatePath("/orders");
}

export async function markCancelled(formData: FormData): Promise<void> {
  const orderId = formData.get("orderId") as string;
  await requireOwnership(orderId);
  await db
    .update(ordersTable)
    .set({ status: "CANCELLED" })
    .where(eq(ordersTable.id, orderId));
  revalidatePath(`/orders/${orderId}`);
  revalidatePath("/orders");
}

export async function refundOrder(formData: FormData): Promise<void> {
  const orderId = formData.get("orderId") as string;
  const amountDollarsStr = (
    formData.get("refundAmountDollars") as string | null
  )?.trim();
  const order = await requireOwnership(orderId);

  if (order.status !== "PAID" && order.status !== "FULFILLED") {
    redirect(
      `/orders/${orderId}?refund_error=${encodeURIComponent("Only paid or fulfilled orders can be refunded.")}`,
    );
  }
  if (!order.stripePaymentIntentId) {
    redirect(
      `/orders/${orderId}?refund_error=${encodeURIComponent("This order has no Stripe payment attached, so it can't be refunded here.")}`,
    );
  }

  const alreadyRefunded = order.refundedAmountCents ?? 0;
  const maxRefundable = order.totalCents - alreadyRefunded;

  if (maxRefundable <= 0) {
    redirect(
      `/orders/${orderId}?refund_error=${encodeURIComponent("This order has already been fully refunded.")}`,
    );
  }

  // Parse the entered amount; default to remaining balance (full refund).
  let refundCents: number;
  if (amountDollarsStr) {
    const parsed = Math.round(parseFloat(amountDollarsStr) * 100);
    if (!isFinite(parsed) || parsed <= 0) {
      redirect(
        `/orders/${orderId}?refund_error=${encodeURIComponent("Enter a valid refund amount greater than zero.")}`,
      );
    }
    if (parsed > maxRefundable) {
      redirect(
        `/orders/${orderId}?refund_error=${encodeURIComponent("Refund amount exceeds the remaining balance.")}`,
      );
    }
    refundCents = parsed;
  } else {
    refundCents = maxRefundable;
  }

  // Non-terminal Stripe refund states — money has left (or will leave) the account.
  // Treat these identically to prevent creating a duplicate charge on retry.
  const STRIPE_NON_TERMINAL = new Set(["pending", "succeeded", "requires_action"]);

  // Use a deterministic idempotency key so concurrent or retried form submissions
  // do not create a second Stripe refund for the same operation. The key encodes
  // the order, its current refunded balance, and the new amount so it remains
  // unique across genuinely different refund operations on the same order.
  const idempotencyKey = `refund-${orderId}-${alreadyRefunded}-${refundCents}`;

  // Using a discriminated union avoids calling redirect() inside a try-catch
  // (which would prevent Next.js redirect signals from propagating correctly).
  type StripeOutcome =
    | { kind: "ok"; refundId: string }
    | { kind: "stripe_error"; message: string }
    | { kind: "manual_review" };

  let stripeOutcome: StripeOutcome;
  try {
    const stripe = await getStripeClient();

    // Reconciliation: before creating a new refund, check whether Stripe already
    // holds a non-terminal refund that our DB hasn't recorded yet (can happen
    // when the previous DB write failed after Stripe already accepted the refund).
    const existingStripeRefunds = await stripe.refunds.list({
      payment_intent: order.stripePaymentIntentId,
      limit: 100,
    });

    const nonTerminalRefunds = existingStripeRefunds.data.filter((r) =>
      r.status != null && STRIPE_NON_TERMINAL.has(r.status),
    );
    const stripeNonTerminalTotal = nonTerminalRefunds.reduce(
      (sum, r) => sum + r.amount,
      0,
    );
    const unrecordedCents = stripeNonTerminalTotal - alreadyRefunded;

    if (unrecordedCents > 0) {
      // Stripe shows more refunded (or in-flight) than our DB. If the gap
      // exactly matches what we're about to refund, reuse that refund rather
      // than creating a new charge. Any other discrepancy requires manual review.
      const match =
        unrecordedCents === refundCents
          ? nonTerminalRefunds.find((r) => r.amount === refundCents)
          : undefined;

      stripeOutcome = match
        ? { kind: "ok", refundId: match.id }
        : { kind: "manual_review" };
    } else {
      const refund = await stripe.refunds.create(
        {
          payment_intent: order.stripePaymentIntentId,
          amount: refundCents,
        },
        { idempotencyKey },
      );
      stripeOutcome = { kind: "ok", refundId: refund.id };
    }
  } catch (err) {
    const message =
      err instanceof StripeNotConfiguredError
        ? "Payments are unavailable right now — Stripe is not configured."
        : ((err as any)?.message ?? String(err));
    stripeOutcome = { kind: "stripe_error", message };
  }

  if (stripeOutcome.kind === "stripe_error") {
    redirect(
      `/orders/${orderId}?refund_error=${encodeURIComponent(stripeOutcome.message)}`,
    );
  }

  if (stripeOutcome.kind === "manual_review") {
    redirect(
      `/orders/${orderId}?refund_error=${encodeURIComponent(
        "Stripe shows an unrecorded refund on this order. Review the payment in Stripe before proceeding to avoid a double refund.",
      )}`,
    );
  }

  const stripeRefundId = stripeOutcome.refundId;

  const newTotalRefunded = alreadyRefunded + refundCents;
  const isFullRefund = newTotalRefunded >= order.totalCents;

  try {
    await db
      .update(ordersTable)
      .set({
        refundedAmountCents: newTotalRefunded,
        refundedAt: new Date(),
        stripeRefundId,
        ...(isFullRefund ? { status: "CANCELLED" } : {}),
      })
      .where(eq(ordersTable.id, orderId));
  } catch (dbErr) {
    // Stripe accepted the refund but we couldn't persist it. Surface the Stripe
    // refund id so the operator can verify the refund and avoid a double-refund.
    const safeId = stripeRefundId!;
    console.error(
      `[refundOrder] DB update failed after Stripe refund ${safeId} was created:`,
      dbErr,
    );
    redirect(
      `/orders/${orderId}?refund_error=${encodeURIComponent(
        `Stripe refund ${safeId} was accepted but the order record could not be updated. Do NOT retry — check Stripe for refund ${safeId} before proceeding.`,
      )}`,
    );
  }

  if (isFullRefund) {
    await notifyBuyerOfUpdate(orderId);
  } else {
    await notifyBuyerOfPartialRefund(orderId, refundCents);
  }

  revalidatePath(`/orders/${orderId}`);
  revalidatePath("/orders");
  redirect(
    `/orders/${orderId}?refunded=${isFullRefund ? "full" : "partial"}`,
  );
}

export async function resendStatusEmail(formData: FormData): Promise<void> {
  const orderId = formData.get("orderId") as string;
  await requireOwnership(orderId);
  await notifyBuyerOfUpdate(orderId);
  revalidatePath(`/orders/${orderId}`);
}

export async function resendConfirmationEmail(
  formData: FormData,
): Promise<void> {
  const orderId = formData.get("orderId") as string;
  const order = await requireOwnership(orderId);

  const [item, tenant] = await Promise.all([
    db.query.orderItemsTable.findFirst({
      where: eq(orderItemsTable.orderId, orderId),
    }),
    db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, order.tenantId),
    }),
  ]);
  if (!item || !tenant) throw new Error("Order details incomplete.");

  try {
    await sendOrderConfirmation({
      buyerEmail: order.buyerEmail,
      buyerName: order.buyerName,
      artworkTitle: item.artworkTitle,
      fulfillmentType: order.fulfillmentType,
      orderRef: order.id.slice(0, 8).toUpperCase(),
      tenantName: tenant.businessName,
    });
    await db
      .update(ordersTable)
      .set({
        emailSentAt: new Date(),
        emailError: null,
        emailLastAttemptAt: new Date(),
      })
      .where(eq(ordersTable.id, orderId));
  } catch (err) {
    await db
      .update(ordersTable)
      .set({
        emailError: (err as any)?.message ?? String(err),
        emailLastAttemptAt: new Date(),
        // A manual resend resets the retry budget so the background sweep
        // resumes retrying even if the automatic attempts were exhausted.
        emailAttempts: 1,
      })
      .where(eq(ordersTable.id, orderId));
  }

  revalidatePath(`/orders/${orderId}`);
}

export async function saveTrackingNote(formData: FormData): Promise<void> {
  const orderId = formData.get("orderId") as string;
  const note = (formData.get("note") as string | null) ?? "";
  const existing = await requireOwnership(orderId);
  const changed = (existing.trackingNote ?? "") !== note;
  await db
    .update(ordersTable)
    .set({ trackingNote: note || null })
    .where(eq(ordersTable.id, orderId));
  if (changed) {
    await notifyBuyerOfUpdate(orderId);
  }
  revalidatePath(`/orders/${orderId}`);
}
