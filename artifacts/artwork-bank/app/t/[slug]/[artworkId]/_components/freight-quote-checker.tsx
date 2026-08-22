"use client";

import Link from "next/link";
import { useState } from "react";
import { formatPrice } from "@/lib/format";
import type { DeliveryAddress, FreightQuote } from "../freight-quote-types";

type Props = {
  artworkId: string;
  artworkTitle: string;
  artworkPrice: number | null;
  slug: string;
  themeColor: string;
};

const EMPTY_ADDRESS: DeliveryAddress = {
  line1: "",
  line2: "",
  suburb: "",
  state: "",
  postcode: "",
};

export function FreightQuoteChecker({
  artworkId,
  artworkTitle,
  artworkPrice,
  slug,
  themeColor,
}: Props) {
  const [address, setAddress] = useState<DeliveryAddress>(EMPTY_ADDRESS);
  const [quotes, setQuotes] = useState<FreightQuote[]>([]);
  const [selectedQuoteId, setSelectedQuoteId] = useState("");
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedQuote = quotes.find((quote) => quote.id === selectedQuoteId);
  const artworkPath = `/t/${slug}/${artworkId}`;
  const continueHref = selectedQuote
    ? `${artworkPath}?freightQuoteId=${encodeURIComponent(selectedQuote.id)}`
    : artworkPath;

  function updateAddress(field: keyof DeliveryAddress, value: string) {
    setAddress((current) => ({ ...current, [field]: value }));
    setQuotes([]);
    setSelectedQuoteId("");
    setError(null);
  }

  async function getQuotes() {
    const requiredFields: Array<[keyof DeliveryAddress, string]> = [
      ["line1", "address line 1"],
      ["suburb", "suburb"],
      ["state", "state or territory"],
      ["postcode", "postcode"],
    ];
    const missingField = requiredFields.find(([field]) => !address[field].trim());
    if (missingField) {
      setError(`Enter your ${missingField[1]} to check delivery.`);
      return;
    }

    setQuoteLoading(true);
    setError(null);
    setQuotes([]);
    setSelectedQuoteId("");

    try {
      const response = await fetch("/api/freight/quotes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          artworkId,
          slug,
          address: { ...address, countryCode: "AU" },
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        quotes?: FreightQuote[];
      };

      if (!response.ok || !data.quotes?.length) {
        setError(
          data.error ??
            "No delivery services are available for this address. Please contact the gallery.",
        );
        return;
      }

      setQuotes(data.quotes);
      setSelectedQuoteId(data.quotes[0]!.id);
    } catch {
      setError("We could not calculate delivery right now. Please try again.");
    } finally {
      setQuoteLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-stone-200 bg-stone-50 p-5">
        <div className="mb-5">
          <h2 className="text-lg font-semibold text-stone-900">
            Check freight to your address
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-stone-500">
            Enter an Australian delivery address to see current carrier pricing.
            The gallery&apos;s dispatch address and this artwork&apos;s packed
            parcel details are used to request the quote.
          </p>
        </div>

        <div className="space-y-4">
          <div>
            <label
              htmlFor="freight-address-line1"
              className="mb-1 block text-xs font-medium text-stone-600"
            >
              Address line 1
            </label>
            <input
              id="freight-address-line1"
              value={address.line1}
              onChange={(event) => updateAddress("line1", event.target.value)}
              autoComplete="address-line1"
              required
              className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-sm text-stone-900 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10"
            />
          </div>

          <div>
            <label
              htmlFor="freight-address-line2"
              className="mb-1 block text-xs font-medium text-stone-600"
            >
              Address line 2{" "}
              <span className="font-normal text-stone-400">(optional)</span>
            </label>
            <input
              id="freight-address-line2"
              value={address.line2}
              onChange={(event) => updateAddress("line2", event.target.value)}
              autoComplete="address-line2"
              className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-sm text-stone-900 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="sm:col-span-1">
              <label
                htmlFor="freight-address-suburb"
                className="mb-1 block text-xs font-medium text-stone-600"
              >
                Suburb
              </label>
              <input
                id="freight-address-suburb"
                value={address.suburb}
                onChange={(event) => updateAddress("suburb", event.target.value)}
                autoComplete="address-level2"
                required
                className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-sm text-stone-900 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10"
              />
            </div>

            <div>
              <label
                htmlFor="freight-address-state"
                className="mb-1 block text-xs font-medium text-stone-600"
              >
                State
              </label>
              <input
                id="freight-address-state"
                value={address.state}
                onChange={(event) =>
                  updateAddress("state", event.target.value.toUpperCase())
                }
                autoComplete="address-level1"
                maxLength={3}
                placeholder="VIC"
                required
                className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-sm uppercase text-stone-900 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10"
              />
            </div>

            <div>
              <label
                htmlFor="freight-address-postcode"
                className="mb-1 block text-xs font-medium text-stone-600"
              >
                Postcode
              </label>
              <input
                id="freight-address-postcode"
                value={address.postcode}
                onChange={(event) =>
                  updateAddress(
                    "postcode",
                    event.target.value.replace(/\D/g, "").slice(0, 4),
                  )
                }
                autoComplete="postal-code"
                inputMode="numeric"
                maxLength={4}
                required
                className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-sm text-stone-900 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10"
              />
            </div>
          </div>

          <button
            type="button"
            onClick={getQuotes}
            disabled={quoteLoading}
            className="w-full rounded-lg border border-stone-300 bg-white px-4 py-3 text-sm font-semibold text-stone-700 transition-colors hover:bg-stone-100 disabled:cursor-wait disabled:opacity-60"
          >
            {quoteLoading ? "Checking carrier prices…" : "Check freight"}
          </button>
        </div>
      </div>

      {quotes.length > 0 && (
        <section
          aria-labelledby="freight-results-heading"
          className="rounded-xl border border-stone-200 bg-white p-5"
        >
          <div className="mb-4">
            <h2
              id="freight-results-heading"
              className="text-lg font-semibold text-stone-900"
            >
              Delivery options
            </h2>
            <p className="mt-1 text-sm text-stone-500">
              Select a service to use when you continue to purchase.
            </p>
          </div>

          <div className="space-y-3">
            {quotes.map((quote) => {
              const selected = quote.id === selectedQuoteId;
              return (
                <label
                  key={quote.id}
                  className={`block cursor-pointer rounded-lg border p-4 transition-colors ${
                    selected
                      ? "border-stone-900 bg-stone-50"
                      : "border-stone-200 hover:border-stone-400"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <input
                      type="radio"
                      name="freight-quote"
                      value={quote.id}
                      checked={selected}
                      onChange={() => setSelectedQuoteId(quote.id)}
                      className="mt-1 accent-stone-900"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                        <span className="font-semibold text-stone-900">
                          {quote.serviceName}
                        </span>
                        <span className="font-semibold text-stone-900">
                          {formatPrice(quote.deliveryCents)}
                        </span>
                      </span>
                      <span className="mt-1 block text-xs text-stone-500">
                        {quote.providerName}
                        {quote.source === "MANUAL" ? " · Manual fallback" : " · Live quote"}
                      </span>
                      <span className="mt-2 block text-xs text-stone-600">
                        Freight {formatPrice(quote.freightCents)} + packaging{" "}
                        {formatPrice(quote.packagingCents)}
                      </span>
                    </span>
                  </div>
                </label>
              );
            })}
          </div>

          {selectedQuote && (
            <div className="mt-5 border-t border-stone-200 pt-4">
              <div className="flex items-center justify-between gap-4 text-sm">
                <span className="text-stone-500">
                  Delivery total
                  {artworkPrice !== null ? " with this artwork" : ""}
                </span>
                <span className="font-semibold text-stone-900">
                  {artworkPrice !== null
                    ? formatPrice(artworkPrice + selectedQuote.deliveryCents)
                    : formatPrice(selectedQuote.deliveryCents)}
                </span>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-stone-400">
                This quote is reserved for 10 minutes. Checkout will validate
                the quote again before payment.
              </p>
              <Link
                href={continueHref}
                className="mt-4 block w-full rounded-xl px-4 py-3 text-center text-sm font-semibold text-white transition-opacity hover:opacity-90"
                style={{ backgroundColor: themeColor }}
              >
                Continue to purchase
              </Link>
            </div>
          )}
        </section>
      )}

      {error && (
        <p
          role="alert"
          className="rounded-lg bg-red-50 px-3.5 py-2.5 text-sm text-red-700"
        >
          {error}
        </p>
      )}

      <div className="flex flex-col items-center justify-between gap-3 text-sm sm:flex-row">
        <Link
          href={artworkPath}
          className="text-stone-500 underline underline-offset-4 transition-colors hover:text-stone-900"
        >
          ← Back to artwork
        </Link>
        <span className="text-xs text-stone-400">
          Australian delivery addresses only
        </span>
      </div>

      <p className="text-center text-xs text-stone-400">
        Checking freight for <span className="font-medium">{artworkTitle}</span>
      </p>
    </div>
  );
}