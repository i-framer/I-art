"use client";

import { useState } from "react";
import { formatPrice } from "@/lib/format";

type Props = {
  artworkId: string;
  slug: string;
  tenantType: "ARTIST" | "FRAMER";
  price: number;
  themeColor: string;
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
  canShip = false,
  shippingNotice = "Delivery is not available for this artwork.",
}: Props) {
  const [fulfillment, setFulfillment] = useState(canShip ? "SHIP" : "PICKUP");
  const [address, setAddress] = useState({
    line1: "",
    line2: "",
    suburb: "",
    state: "",
    postcode: "",
  });
  const [quotes, setQuotes] = useState<
    Array<{
      id: string;
      provider: string;
      providerName: string;
      serviceCode: string | null;
      serviceName: string;
      source: "LIVE" | "MANUAL";
      freightCents: number;
      expiresAt: string;
    }>
  >([]);
  const [freightQuoteId, setFreightQuoteId] = useState("");
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options = [
    ...(canShip ? [FULFILLMENT_OPTIONS[0]] : []),
    tenantType === "FRAMER"
      ? [FULFILLMENT_OPTIONS[1], FRAMER_OPTION]
      : [FULFILLMENT_OPTIONS[1]],
  ].flat();
  const selectedFreight = quotes.find((quote) => quote.id === freightQuoteId);
  const checkoutTotal = price + (selectedFreight?.freightCents ?? 0);

  function updateAddress(name: keyof typeof address, value: string) {
    setAddress((current) => ({ ...current, [name]: value }));
    setQuotes([]);
    setFreightQuoteId("");
  }

  async function getQuotes() {
    setQuoteLoading(true);
    setError(null);
    setQuotes([]);
    setFreightQuoteId("");
    try {
      const res = await fetch("/api/freight/quotes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          artworkId,
          slug,
          address: { ...address, countryCode: "AU" },
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        quotes?: typeof quotes;
      };
      if (!res.ok || !data.quotes?.length) {
        setError(data.error ?? "We could not find a delivery service for this address.");
        return;
      }
      setQuotes(data.quotes);
      setFreightQuoteId(data.quotes[0]!.id);
    } catch {
      setError("We could not calculate delivery right now. Please try again.");
    } finally {
      setQuoteLoading(false);
    }
  }

  async function handleCheckout() {
    if (fulfillment === "SHIP" && !freightQuoteId) {
      setError("Enter your delivery address and select a freight quote before checkout.");
      return;
    }
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
          freightQuoteId: fulfillment === "SHIP" ? freightQuoteId : undefined,
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

      {fulfillment === "SHIP" && (
        <div className="space-y-4 rounded-xl border border-stone-200 bg-stone-50 p-4">
          <div>
            <h3 className="text-sm font-semibold text-stone-800">Delivery address</h3>
            <p className="mt-1 text-xs text-stone-500">
              Australian addresses only. We use this address to request the current carrier price.
            </p>
          </div>
          <div>
            <label htmlFor="delivery-line1" className="mb-1 block text-xs font-medium text-stone-600">Address line 1</label>
            <input id="delivery-line1" value={address.line1} onChange={(event) => updateAddress("line1", event.target.value)} className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 focus:border-stone-900 focus:outline-none" />
          </div>
          <div>
            <label htmlFor="delivery-line2" className="mb-1 block text-xs font-medium text-stone-600">Address line 2 <span className="font-normal text-stone-400">(optional)</span></label>
            <input id="delivery-line2" value={address.line2} onChange={(event) => updateAddress("line2", event.target.value)} className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 focus:border-stone-900 focus:outline-none" />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label htmlFor="delivery-suburb" className="mb-1 block text-xs font-medium text-stone-600">Suburb</label>
              <input id="delivery-suburb" value={address.suburb} onChange={(event) => updateAddress("suburb", event.target.value)} className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 focus:border-stone-900 focus:outline-none" />
            </div>
            <div>
              <label htmlFor="delivery-state" className="mb-1 block text-xs font-medium text-stone-600">State</label>
              <input id="delivery-state" value={address.state} onChange={(event) => updateAddress("state", event.target.value.toUpperCase())} maxLength={3} placeholder="VIC" className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm uppercase text-stone-900 focus:border-stone-900 focus:outline-none" />
            </div>
            <div>
              <label htmlFor="delivery-postcode" className="mb-1 block text-xs font-medium text-stone-600">Postcode</label>
              <input id="delivery-postcode" value={address.postcode} onChange={(event) => updateAddress("postcode", event.target.value.replace(/\D/g, "").slice(0, 4))} inputMode="numeric" maxLength={4} className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 focus:border-stone-900 focus:outline-none" />
            </div>
          </div>
          <button type="button" onClick={getQuotes} disabled={quoteLoading} className="w-full rounded-lg border border-stone-300 bg-white px-4 py-2.5 text-sm font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-60">
            {quoteLoading ? "Calculating delivery…" : "Get delivery quotes"}
          </button>

          {quotes.length > 0 && (
            <div>
              <label htmlFor="freight-quote" className="mb-1.5 block text-xs font-medium text-stone-600">
                Available delivery services
              </label>
              <select id="freight-quote" value={freightQuoteId} onChange={(event) => setFreightQuoteId(event.target.value)} className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-sm text-stone-900 focus:border-stone-900 focus:outline-none">
                {quotes.map((quote) => (
                  <option key={quote.id} value={quote.id}>
                    {quote.serviceName} — {formatPrice(quote.freightCents)}
                  </option>
                ))}
              </select>
              {selectedFreight?.source === "MANUAL" && (
                <p className="mt-1.5 text-xs text-amber-700">
                  Live carrier pricing is unavailable; this gallery&apos;s manual fallback rate is shown.
                </p>
              )}
              <div className="mt-2 flex items-center justify-between text-sm">
                <span className="text-stone-500">Total today</span>
                <span className="font-semibold text-stone-900">{formatPrice(checkoutTotal)}</span>
              </div>
              <p className="mt-1 text-xs text-stone-400">Quotes expire after 10 minutes. Request a new quote if checkout takes longer.</p>
            </div>
          )}
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
        disabled={loading || (fulfillment === "SHIP" && !freightQuoteId)}
        className="w-full rounded-xl py-4 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60 disabled:cursor-wait"
        style={{ backgroundColor: themeColor }}
      >
        {loading
          ? "Redirecting to checkout…"
          : fulfillment === "SHIP" && !freightQuoteId
            ? "Get a delivery quote to continue"
            : `Buy Now — ${formatPrice(checkoutTotal)}`}
      </button>

      <p className="text-center text-xs text-stone-400">
        Secure checkout via Stripe
      </p>
    </div>
  );
}
