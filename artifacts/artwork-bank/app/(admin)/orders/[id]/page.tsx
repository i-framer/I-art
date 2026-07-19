import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { db } from "@workspace/db";
import { ordersTable, orderItemsTable, tenantsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { formatPrice } from "@/lib/tenant-cache";
import {
  markFulfilled,
  markCancelled,
  saveTrackingNote,
  resendConfirmationEmail,
} from "./actions";
import { ArrowLeft, CheckCircle2, AlertCircle, Clock, Mail, AlertTriangle } from "lucide-react";
import { MAX_EMAIL_ATTEMPTS } from "@/lib/email-sweep";

export const metadata: Metadata = { title: "Order Detail" };

const STATUS_STYLES: Record<string, { label: string; cls: string }> = {
  PENDING: { label: "Pending", cls: "bg-amber-100 text-amber-700" },
  PAID: { label: "Paid", cls: "bg-blue-100 text-blue-700" },
  FULFILLED: { label: "Fulfilled", cls: "bg-emerald-100 text-emerald-700" },
  CANCELLED: { label: "Cancelled", cls: "bg-red-100 text-red-700" },
};

const FULFILLMENT_LABELS: Record<string, string> = {
  SHIP: "Ship to buyer",
  PICKUP: "Buyer collects in person",
  FRAMING_JOB: "Custom framing job",
};

export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session.userId) redirect("/login");

  const { id } = await params;

  const [order, items, tenant] = await Promise.all([
    db.query.ordersTable.findFirst({
      where: and(
        eq(ordersTable.id, id),
        eq(ordersTable.tenantId, session.tenantId),
      ),
    }),
    db.query.orderItemsTable.findMany({
      where: eq(orderItemsTable.orderId, id),
    }),
    db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, session.tenantId),
      columns: { iframerAccountId: true },
    }),
  ]);

  if (!order) notFound();

  const badge = STATUS_STYLES[order.status];
  const canFulfil = order.status === "PAID";
  const canCancel = order.status === "PAID" || order.status === "PENDING";
  const isFramingJob = order.fulfillmentType === "FRAMING_JOB";
  const hasIFramer = Boolean(tenant?.iframerAccountId);

  return (
    <div className="px-8 py-8 max-w-3xl">
      {/* Back */}
      <Link
        href="/orders"
        className="flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-900 transition-colors mb-6"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Orders
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <p className="text-xs text-stone-400 font-mono mb-1">{order.id}</p>
          <h1 className="text-2xl font-semibold text-stone-900">
            Order{" "}
            <span className="font-mono">{order.id.slice(0, 8).toUpperCase()}</span>
          </h1>
          <p className="text-stone-500 text-sm mt-1">
            {order.createdAt.toLocaleString("en-AU", {
              day: "numeric",
              month: "long",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
        </div>
        {badge && (
          <span className={`rounded-full px-3 py-1 text-sm font-semibold ${badge.cls}`}>
            {badge.label}
          </span>
        )}
      </div>

      <div className="space-y-6">
        {/* Customer */}
        <div className="rounded-xl border border-stone-200 bg-white p-6">
          <h2 className="text-sm font-semibold text-stone-900 mb-4">Customer</h2>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
            <dt className="text-stone-500">Name</dt>
            <dd className="text-stone-900 font-medium">{order.buyerName ?? "—"}</dd>
            <dt className="text-stone-500">Email</dt>
            <dd className="text-stone-900">{order.buyerEmail}</dd>
            <dt className="text-stone-500">Fulfilment</dt>
            <dd className="text-stone-900">
              {FULFILLMENT_LABELS[order.fulfillmentType] ?? order.fulfillmentType}
            </dd>
          </dl>
        </div>

        {/* Items */}
        <div className="rounded-xl border border-stone-200 bg-white p-6">
          <h2 className="text-sm font-semibold text-stone-900 mb-4">Items</h2>
          <div className="divide-y divide-stone-100">
            {items.map((item) => (
              <div key={item.id} className="flex items-center justify-between py-3">
                <div>
                  <p className="font-medium text-stone-900">{item.artworkTitle}</p>
                  {item.artworkSku && (
                    <p className="text-xs text-stone-400 font-mono mt-0.5">
                      SKU: {item.artworkSku}
                    </p>
                  )}
                </div>
                <p className="font-semibold text-stone-900">
                  {formatPrice(item.priceCents)} × {item.quantity}
                </p>
              </div>
            ))}
          </div>
          <div className="mt-4 flex items-center justify-between pt-4 border-t border-stone-200">
            <span className="text-sm font-semibold text-stone-700">Total</span>
            <span className="text-lg font-semibold text-stone-900">
              {formatPrice(order.totalCents)}
            </span>
          </div>
          {order.applicationFeeCents != null && (
            <p className="text-xs text-stone-400 mt-1 text-right">
              Platform fee: {formatPrice(order.applicationFeeCents)}
            </p>
          )}
        </div>

        {/* ── Confirmation email status ────────────────────────────────────── */}
        <div className="rounded-xl border border-stone-200 bg-white p-6">
          <h2 className="text-sm font-semibold text-stone-900 mb-4">
            Confirmation email
          </h2>
          {order.emailSentAt ? (
            <div className="flex items-start gap-3">
              <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-emerald-700">
                  Sent to {order.buyerEmail}
                </p>
                <p className="text-xs text-stone-500 mt-0.5">
                  {order.emailSentAt.toLocaleString("en-AU", {
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </p>
              </div>
            </div>
          ) : order.emailAttempts >= MAX_EMAIL_ATTEMPTS ? (
            <div className="space-y-3">
              <div className="rounded-lg border border-red-200 bg-red-50 p-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="h-5 w-5 text-red-600 shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-red-800">
                      Delivery permanently failed
                    </p>
                    <p className="text-xs text-red-700 mt-1 leading-relaxed">
                      All {MAX_EMAIL_ATTEMPTS} automatic attempts to email{" "}
                      <span className="font-medium">{order.buyerEmail}</span>{" "}
                      failed. The buyer never received their order
                      confirmation — consider contacting them directly, or try
                      resending below.
                    </p>
                    {order.emailError && (
                      <p className="text-xs text-red-600/80 mt-2 leading-relaxed break-words">
                        Last error: {order.emailError}
                      </p>
                    )}
                    {order.emailLastAttemptAt && (
                      <p className="text-xs text-red-600/80 mt-1">
                        Last attempt:{" "}
                        {order.emailLastAttemptAt.toLocaleString("en-AU", {
                          day: "numeric",
                          month: "long",
                          year: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </p>
                    )}
                  </div>
                </div>
              </div>
              <form action={resendConfirmationEmail} className="pl-8">
                <input type="hidden" name="orderId" value={order.id} />
                <button
                  type="submit"
                  className="inline-flex items-center gap-2 rounded-lg border border-stone-300 px-4 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50 transition-colors"
                >
                  <Mail className="h-4 w-4" />
                  Resend confirmation email
                </button>
              </form>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-start gap-3">
                {order.emailError ? (
                  <AlertCircle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
                ) : (
                  <Clock className="h-5 w-5 text-stone-400 shrink-0 mt-0.5" />
                )}
                <div className="min-w-0">
                  <p
                    className={`text-sm font-medium ${order.emailError ? "text-red-700" : "text-stone-500"}`}
                  >
                    {order.emailError
                      ? "Sending failed"
                      : "Not sent yet"}
                  </p>
                  {order.emailError && (
                    <p className="text-xs text-stone-500 mt-1 leading-relaxed break-words">
                      {order.emailError}
                    </p>
                  )}
                  {order.emailAttempts > 0 && order.emailError && (
                    <p className="text-xs text-stone-400 mt-1">
                      Attempt {order.emailAttempts} of {MAX_EMAIL_ATTEMPTS} —
                      automatic retries continue in the background.
                    </p>
                  )}
                </div>
              </div>
              <form action={resendConfirmationEmail} className="pl-8">
                <input type="hidden" name="orderId" value={order.id} />
                <button
                  type="submit"
                  className="inline-flex items-center gap-2 rounded-lg border border-stone-300 px-4 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50 transition-colors"
                >
                  <Mail className="h-4 w-4" />
                  Resend confirmation email
                </button>
              </form>
            </div>
          )}
        </div>

        {/* ── iFramer job status (FRAMING_JOB orders only) ─────────────────── */}
        {isFramingJob && hasIFramer && (
          <div className="rounded-xl border border-stone-200 bg-white p-6">
            <h2 className="text-sm font-semibold text-stone-900 mb-4">
              iFramer job
            </h2>

            {order.iframerJobId ? (
              <div className="flex items-start gap-3">
                <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-emerald-700">
                    Job created successfully
                  </p>
                  <p className="text-xs text-stone-500 mt-0.5">
                    iFramer job ID:{" "}
                    <span className="font-mono text-stone-700">
                      {order.iframerJobId}
                    </span>
                  </p>
                </div>
              </div>
            ) : order.iframerJobError ? (
              <div className="space-y-3">
                <div className="flex items-start gap-3">
                  <AlertCircle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-red-700">
                      Job creation failed
                    </p>
                    <p className="text-xs text-stone-500 mt-1 leading-relaxed break-words">
                      {order.iframerJobError}
                    </p>
                  </div>
                </div>
                <p className="text-xs text-stone-400 pl-8">
                  Check that{" "}
                  <span className="font-mono">IFRAMER_API_BASE_URL</span> and{" "}
                  <span className="font-mono">IFRAMER_API_KEY</span> are
                  configured and retry by manually creating the job in iFramer.
                </p>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <Clock className="h-5 w-5 text-stone-400 shrink-0" />
                <p className="text-sm text-stone-500">
                  Job creation pending — this updates automatically when the order
                  webhook is processed.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Tracking note */}
        <div className="rounded-xl border border-stone-200 bg-white p-6">
          <h2 className="text-sm font-semibold text-stone-900 mb-4">
            Tracking / notes
          </h2>
          <form action={saveTrackingNote}>
            <input type="hidden" name="orderId" value={order.id} />
            <textarea
              name="note"
              rows={3}
              defaultValue={order.trackingNote ?? ""}
              placeholder="Add a tracking number, courier name, or any internal note…"
              className="w-full rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10 transition-colors resize-y"
            />
            <button
              type="submit"
              className="mt-3 rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 transition-colors"
            >
              Save note
            </button>
          </form>
        </div>

        {/* Status actions */}
        {(canFulfil || canCancel) && (
          <div className="rounded-xl border border-stone-200 bg-white p-6">
            <h2 className="text-sm font-semibold text-stone-900 mb-4">
              Update status
            </h2>
            <div className="flex gap-3">
              {canFulfil && (
                <form action={markFulfilled}>
                  <input type="hidden" name="orderId" value={order.id} />
                  <button
                    type="submit"
                    className="rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 transition-colors"
                  >
                    Mark as Fulfilled
                  </button>
                </form>
              )}
              {canCancel && (
                <form action={markCancelled}>
                  <input type="hidden" name="orderId" value={order.id} />
                  <button
                    type="submit"
                    className="rounded-lg border border-red-300 px-5 py-2.5 text-sm font-medium text-red-700 hover:bg-red-50 transition-colors"
                  >
                    Cancel Order
                  </button>
                </form>
              )}
            </div>
          </div>
        )}

        {/* Stripe link */}
        {order.stripePaymentIntentId && (
          <p className="text-xs text-stone-400">
            Stripe payment:{" "}
            <a
              href={`https://dashboard.stripe.com/payments/${order.stripePaymentIntentId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono hover:text-stone-700 underline underline-offset-2"
            >
              {order.stripePaymentIntentId}
            </a>
          </p>
        )}
      </div>
    </div>
  );
}
