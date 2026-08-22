"use server";

import { db } from "@workspace/db";
import { ordersTable, orderItemsTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { headers } from "next/headers";
import { getTenantBySlug } from "@/lib/tenant-cache";
import { checkRateLimit } from "@/lib/rate-limit";

export type OrderLookupState = {
  status: "idle" | "found" | "not_found" | "error";
  error: string;
  order: {
    ref: string;
    orderStatus: string;
    fulfillmentType: string;
    freightMethodName: string | null;
    freightProvider: string | null;
    freightClass: string | null;
    freightCents: number;
    trackingNote: string | null;
    artworkTitle: string | null;
    createdAt: string;
  } | null;
};

const lookupSchema = z.object({
  email: z.string().trim().email("Please enter a valid email address."),
  ref: z
    .string()
    .trim()
    .regex(
      /^[0-9a-fA-F]{8}$/,
      "Order reference should be the 8-character code from your confirmation email.",
    ),
});

export async function lookupOrder(
  slug: string,
  _prev: OrderLookupState,
  formData: FormData,
): Promise<OrderLookupState> {
  // Per-IP rate limit so the form can't be used to enumerate orders.
  const headerList = await headers();
  const forwardedFor = headerList.get("x-forwarded-for");
  const ip =
    forwardedFor?.split(",")[0]?.trim() ||
    headerList.get("x-real-ip") ||
    "unknown";
  const allowed = await checkRateLimit(`order-lookup:${ip}`, {
    limit: 10,
    windowMs: 10 * 60_000,
  });
  if (!allowed) {
    return {
      status: "error",
      error: "Too many lookups. Please wait a few minutes and try again.",
      order: null,
    };
  }

  const parsed = lookupSchema.safeParse({
    email: formData.get("email"),
    ref: formData.get("ref"),
  });
  if (!parsed.success) {
    return {
      status: "error",
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
      order: null,
    };
  }

  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    return { status: "error", error: "Gallery not found.", order: null };
  }

  const refLower = parsed.data.ref.toLowerCase();
  const emailLower = parsed.data.email.toLowerCase();

  try {
    const order = await db.query.ordersTable.findFirst({
      where: and(
        eq(ordersTable.tenantId, tenant.id),
        sql`lower(${ordersTable.buyerEmail}) = ${emailLower}`,
        sql`lower(${ordersTable.id}) like ${refLower + "%"}`,
      ),
    });

    if (!order) {
      return { status: "not_found", error: "", order: null };
    }

    const item = await db.query.orderItemsTable.findFirst({
      where: eq(orderItemsTable.orderId, order.id),
    });

    return {
      status: "found",
      error: "",
      order: {
        ref: order.id.slice(0, 8).toUpperCase(),
        orderStatus: order.status,
        fulfillmentType: order.fulfillmentType,
        freightMethodName: order.freightMethodName,
        freightProvider: order.freightProvider,
        freightClass: order.freightClass,
        freightCents: order.freightCents,
        trackingNote: order.trackingNote,
        artworkTitle: item?.artworkTitle ?? null,
        createdAt: order.createdAt.toISOString(),
      },
    };
  } catch (err) {
    console.error("Order lookup failed", err);
    return {
      status: "error",
      error: "Something went wrong looking up your order. Please try again.",
      order: null,
    };
  }
}
