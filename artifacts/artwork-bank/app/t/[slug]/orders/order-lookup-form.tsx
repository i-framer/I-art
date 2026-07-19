"use client";

import { useActionState } from "react";
import { lookupOrder, type OrderLookupState } from "./actions";

const initialState: OrderLookupState = { status: "idle", error: "", order: null };

const STATUS_LABEL: Record<string, { label: string; className: string }> = {
  PENDING: { label: "Pending payment", className: "bg-amber-100 text-amber-800" },
  PAID: { label: "Confirmed — being prepared", className: "bg-blue-100 text-blue-800" },
  FULFILLED: { label: "Fulfilled", className: "bg-green-100 text-green-800" },
  CANCELLED: { label: "Cancelled", className: "bg-stone-200 text-stone-700" },
};

const FULFILLMENT_LABEL: Record<string, string> = {
  SHIP: "Shipping",
  PICKUP: "Pickup in person",
  FRAMING_JOB: "Framing job",
};

export function OrderLookupForm({
  slug,
  themeColor,
  defaultEmail,
  defaultRef,
}: {
  slug: string;
  themeColor: string;
  defaultEmail?: string;
  defaultRef?: string;
}) {
  const [state, formAction, isPending] = useActionState<OrderLookupState, FormData>(
    lookupOrder.bind(null, slug),
    initialState,
  );

  const inputClass =
    "w-full rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10 transition-colors";

  return (
    <div>
      <form action={formAction} className="space-y-3 text-left">
        <div>
          <label htmlFor="lookup-email" className="mb-1 block text-sm font-medium text-stone-700">
            Email used at checkout
          </label>
          <input
            id="lookup-email"
            name="email"
            type="email"
            required
            defaultValue={defaultEmail}
            placeholder="you@example.com"
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="lookup-ref" className="mb-1 block text-sm font-medium text-stone-700">
            Order reference
          </label>
          <input
            id="lookup-ref"
            name="ref"
            type="text"
            required
            defaultValue={defaultRef}
            placeholder="e.g. 3F2A9B1C"
            maxLength={8}
            autoComplete="off"
            className={`${inputClass} font-mono uppercase`}
          />
          <p className="mt-1 text-xs text-stone-500">
            The 8-character code from your confirmation email.
          </p>
        </div>
        <button
          type="submit"
          disabled={isPending}
          className="w-full rounded-xl px-6 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          style={{ backgroundColor: themeColor }}
        >
          {isPending ? "Looking up…" : "Check Order Status"}
        </button>
      </form>

      {state.status === "error" && (
        <div className="mt-4 rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800">
          {state.error}
        </div>
      )}

      {state.status === "not_found" && (
        <div className="mt-4 rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
          No order found with that email and reference. Double-check both against
          your confirmation email — if you still can't find it, contact the
          gallery directly.
        </div>
      )}

      {state.status === "found" && state.order && (
        <div className="mt-6 rounded-xl border border-stone-200 bg-stone-50 p-5 text-left">
          <div className="flex items-center justify-between gap-3">
            <p className="font-mono text-sm text-stone-600">#{state.order.ref}</p>
            <span
              className={`rounded-full px-3 py-1 text-xs font-semibold ${
                STATUS_LABEL[state.order.orderStatus]?.className ?? "bg-stone-200 text-stone-700"
              }`}
            >
              {STATUS_LABEL[state.order.orderStatus]?.label ?? state.order.orderStatus}
            </span>
          </div>
          {state.order.artworkTitle && (
            <p className="mt-3 text-sm text-stone-900">
              <strong>{state.order.artworkTitle}</strong>
            </p>
          )}
          <p className="mt-1 text-sm text-stone-600">
            {FULFILLMENT_LABEL[state.order.fulfillmentType] ?? state.order.fulfillmentType}
            {" · "}
            Ordered{" "}
            {new Date(state.order.createdAt).toLocaleDateString(undefined, {
              day: "numeric",
              month: "long",
              year: "numeric",
            })}
          </p>
          {state.order.trackingNote ? (
            <div className="mt-3 rounded-lg bg-white border border-stone-200 px-4 py-3 text-sm text-stone-700 whitespace-pre-line">
              {state.order.trackingNote}
            </div>
          ) : (
            <p className="mt-3 text-sm text-stone-500">
              No tracking updates yet — the gallery will add details as your
              order progresses.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
