import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { getTenantBySlug } from "@/lib/tenant-cache";
import { db } from "@workspace/db";
import { ordersTable, orderItemsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { getStripeClient } from "@/lib/stripe";

export const metadata: Metadata = { title: "Order Confirmed" };

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ session_id?: string }>;
};

export default async function OrderSuccessPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const { session_id } = await searchParams;

  const tenant = await getTenantBySlug(slug);
  if (!tenant) notFound();

  const themeColor = tenant.themeColor ?? "#1c1917";

  // Try to retrieve buyer info from Stripe session
  let buyerName: string | null = null;
  let buyerEmail: string | null = null;
  let artworkTitle: string | null = null;
  let orderRef: string | null = null;

  if (session_id) {
    // Try DB first (fast, webhook may have already fired)
    const order = await db.query.ordersTable.findFirst({
      where: and(
        eq(ordersTable.stripeSessionId, session_id),
        eq(ordersTable.tenantId, tenant.id),
      ),
    });

    if (order) {
      buyerName = order.buyerName;
      buyerEmail = order.buyerEmail;
      orderRef = order.id.slice(0, 8).toUpperCase();
      const item = await db.query.orderItemsTable.findFirst({
        where: eq(orderItemsTable.orderId, order.id),
      });
      artworkTitle = item?.artworkTitle ?? null;
    } else {
      // Fallback: retrieve from Stripe (webhook may be in-flight)
      try {
        const stripe = await getStripeClient();
        const session = await stripe.checkout.sessions.retrieve(session_id);
        buyerName = session.customer_details?.name ?? null;
        buyerEmail = session.customer_details?.email ?? null;
      } catch {
        // Stripe not configured or session expired — show generic message
      }
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-20 text-center">
      {/* Icon */}
      <CheckCircle2
        className="mx-auto mb-6 h-16 w-16"
        style={{ color: themeColor }}
      />

      {/* Heading */}
      <h1 className="text-3xl font-semibold text-stone-900 mb-3">
        Order Confirmed!
      </h1>

      <p className="text-stone-600 text-base leading-relaxed">
        {buyerName ? `Thank you, ${buyerName.split(" ")[0]}!` : "Thank you!"}{" "}
        {artworkTitle ? (
          <>
            Your purchase of{" "}
            <strong className="text-stone-800">{artworkTitle}</strong> is
            confirmed.
          </>
        ) : (
          "Your purchase is confirmed."
        )}
      </p>

      {buyerEmail && (
        <p className="mt-3 text-stone-500 text-sm">
          A confirmation has been sent to{" "}
          <span className="font-medium text-stone-700">{buyerEmail}</span>.
        </p>
      )}

      <div className="mt-4 rounded-xl bg-stone-50 border border-stone-200 px-6 py-4 text-sm text-stone-600">
        {tenant.businessName} will be in touch with fulfilment details.
      </div>

      {/* Actions */}
      <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-3">
        <Link
          href={`/t/${slug}`}
          className="rounded-xl px-6 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90"
          style={{ backgroundColor: themeColor }}
        >
          Continue Browsing
        </Link>
        <Link
          href={
            orderRef && buyerEmail
              ? `/t/${slug}/orders?email=${encodeURIComponent(buyerEmail)}&ref=${encodeURIComponent(orderRef)}`
              : `/t/${slug}/orders`
          }
          className="rounded-xl border border-stone-300 px-6 py-3 text-sm font-semibold text-stone-700 transition-colors hover:bg-stone-50"
        >
          Check Order Status
        </Link>
      </div>
    </div>
  );
}
