"use server";
import { requireActiveBillingAccess } from "@/lib/billing";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@workspace/db";
import { ordersTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { orderItemsTable, tenantsTable } from "@workspace/db";
import { sendOrderConfirmation, sendOrderStatusUpdate } from "@/lib/email";
import { getTenantUrl } from "@/lib/base-url";

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
