"use client";

import { useState } from "react";
import { formatPrice } from "@/lib/format";

type Props = {
  artworkId: string;
  slug: string;
  tenantType: "ARTIST" | "FRAMER";
  price: number;
  themeColor: string;
  freightOptions?: Array<{ id: string; name: string; cents: number }>;
  freightClass?: "SMALL" | "MEDIUM" | "LARGE" | "TUBE" | null;
  canShip?: boolean;
  shippingNotice?: string;
};

const FULFILLMENT_OPTIONS = [
  { value: "SHIP", label: "Ship to me" },
  { value: "PICKUP", label: "Collect in person" },
];

const FRAMER_OPTION = { value: "FRAMING_JOB", label: "Custom framing job" };

export function BuyNowButton({
  artworkId,
  slug,
  tenantType,
  price,
  themeColor,
  freightOptions = [],
  freightClass = null,
  canShip = true,
  shippingNotice = "Delivery is not available for this artwork because its dimensions are missing.",
}: Props) {
  const [fulfillment, setFulfillment] = useState(canShip ? "SHIP" : "PICKUP");
  const [freightMethodId, setFreightMethodId] = useState(
    freightOptions[0]?.id ?? "",
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options = [
    ...(canShip ? [FULFILLMENT_OPTIONS[0]] : []),
    tenantType === "FRAMER"
      ? [FULFILLMENT_OPTIONS[1], FRAMER_OPTION]
      : [FULFILLMENT_OPTIONS[1]],
  ].flat();
  const selectedFreight =
    fulfillment === "SHIP"
      ? freightOptions.find((option) => option.id === freightMethodId)
      : undefined;
  const checkoutTotal = price + (selectedFreight?.cents ?? 0);

  async function handleCheckout() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          artworkId,
          slug,
          fulfillmentType: fulfillment,
          freightMethodId: fulfillment === "SHIP" ? freightMethodId || undefined : undefined,
        }),
      });
      let data: { url?: string; error?: string } = {};
      try {
        data = await res.json();
      } catch {
        // Non-JSON response body — fall through to status-based message
      }
      if (res.ok && data.url) {
        window.location.href = data.url;
      } else {
        setError(
          data.error ??
            (res.status === 503
              ? "Payments are temporarily unavailable for this gallery. Please try again later or contact the gallery directly."
              : "Something went wrong. Please try again."),
        );
        setLoading(false);
      }
    } catch {
      setError("Something went wrong. Please try again.");
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      {/* Fulfilment type selector */}
      <div>
        <label className="block text-xs font-medium text-stone-500 mb-1.5">
          Delivery method
        </label>
        <select
          value={fulfillment}
          onChange={(e) => setFulfillment(e.target.value)}
          className="w-full rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-stone-900 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10 transition-colors"
        >
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        {!canShip && (
          <p className="mt-1.5 text-xs text-stone-500">
            {shippingNotice}
          </p>
        )}
      </div>

      {fulfillment === "SHIP" && freightOptions.length > 0 && (
        <div>
          <label className="block text-xs font-medium text-stone-500 mb-1.5">
            Freight service
            {freightClass && (
              <span className="font-normal"> · {freightClass === "TUBE" ? "Rolled / tube" : `${freightClass[0]}${freightClass.slice(1).toLowerCase()} parcel`}</span>
            )}
          </label>
          <select
            value={freightMethodId}
            onChange={(event) => setFreightMethodId(event.target.value)}
            className="w-full rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-stone-900 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10 transition-colors"
          >
            {freightOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name} — {formatPrice(option.cents)}
              </option>
            ))}
          </select>
          <div className="mt-2 flex items-center justify-between text-sm">
            <span className="text-stone-500">Total today</span>
            <span className="font-semibold text-stone-900">{formatPrice(checkoutTotal)}</span>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3.5 py-2.5">
          {error}
        </p>
      )}

      {/* Buy button */}
      <button
        onClick={handleCheckout}
        disabled={loading}
        className="w-full rounded-xl py-4 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60 disabled:cursor-wait"
        style={{ backgroundColor: themeColor }}
      >
        {loading
          ? "Redirecting to checkout…"
          : `Buy Now — ${formatPrice(checkoutTotal)}`}
      </button>

      <p className="text-center text-xs text-stone-400">
        Secure checkout via Stripe
      </p>
    </div>
  );
}
