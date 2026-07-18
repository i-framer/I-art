"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@workspace/db";
import { ordersTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { getSession } from "@/lib/auth";

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
