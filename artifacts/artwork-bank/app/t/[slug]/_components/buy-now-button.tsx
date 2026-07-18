"use client";

import { useState } from "react";
import { formatPrice } from "@/lib/format";

type Props = {
  artworkId: string;
  slug: string;
  tenantType: "ARTIST" | "FRAMER";
  price: number;
  themeColor: string;
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
}: Props) {
  const [fulfillment, setFulfillment] = useState("SHIP");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options =
    tenantType === "FRAMER"
      ? [...FULFILLMENT_OPTIONS, FRAMER_OPTION]
      : FULFILLMENT_OPTIONS;

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
        }),
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        setError(data.error ?? "Something went wrong. Please try again.");
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
      </div>

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
          : `Buy Now — ${formatPrice(price)}`}
      </button>

      <p className="text-center text-xs text-stone-400">
        Secure checkout via Stripe
      </p>
    </div>
  );
}
