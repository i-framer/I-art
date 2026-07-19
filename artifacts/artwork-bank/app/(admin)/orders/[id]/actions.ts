"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@workspace/db";
import { ordersTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { orderItemsTable, tenantsTable } from "@workspace/db";
import { sendOrderConfirmation } from "@/lib/email";

async function requireOwnership(orderId: string) {
  const session = await getSession();
  if (!session.userId) redirect("/login");
  const order = await db.query.ordersTable.findFirst({
    where: and(
      eq(ordersTable.id, orderId),
      eq(ordersTable.tenantId, session.tenantId),
    ),
  });
  if (!order) throw new Error("Order not found.");
  return order;
}

export async function markFulfilled(formData: FormData): Promise<void> {
  const orderId = formData.get("orderId") as string;
  await requireOwnership(orderId);
  await db
    .update(ordersTable)
    .set({ status: "FULFILLED" })
    .where(eq(ordersTable.id, orderId));
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
      .set({ emailSentAt: new Date(), emailError: null })
      .where(eq(ordersTable.id, orderId));
  } catch (err) {
    await db
      .update(ordersTable)
      .set({ emailError: (err as any)?.message ?? String(err) })
      .where(eq(ordersTable.id, orderId));
  }

  revalidatePath(`/orders/${orderId}`);
}

export async function saveTrackingNote(formData: FormData): Promise<void> {
  const orderId = formData.get("orderId") as string;
  const note = (formData.get("note") as string | null) ?? "";
  await requireOwnership(orderId);
  await db
    .update(ordersTable)
    .set({ trackingNote: note || null })
    .where(eq(ordersTable.id, orderId));
  revalidatePath(`/orders/${orderId}`);
}
