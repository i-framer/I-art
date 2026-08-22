"use client";

import { useActionState } from "react";
import { saveFreightSettings, type FreightSettingsState } from "../actions";

const initial: FreightSettingsState = { error: null, success: false };

export function FreightSettingsForm({
  smallMaxMm,
  mediumMaxMm,
  originAddressLine1,
  originAddressLine2,
  originSuburb,
  originState,
  originPostcode,
}: {
  smallMaxMm: number;
  mediumMaxMm: number;
  originAddressLine1?: string | null;
  originAddressLine2?: string | null;
  originSuburb?: string | null;
  originState?: string | null;
  originPostcode?: string | null;
}) {
  const [state, formAction, isPending] = useActionState<
    FreightSettingsState,
    FormData
  >(saveFreightSettings, initial);

  return (
    <form action={formAction}>
      {state.error && (
        <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {state.error}
        </div>
      )}
      {state.success && (
        <div className="mb-4 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-700">
          Freight settings saved.
        </div>
      )}
      <div className="grid grid-cols-2 gap-4 mb-4">
        <div>
          <label
            htmlFor="smallMaxMm"
            className="block text-sm font-medium text-stone-700 mb-1.5"
          >
            Small max (mm)
          </label>
          <input
            id="smallMaxMm"
            name="smallMaxMm"
            type="number"
            min={1}
            max={9999}
            required
            defaultValue={smallMaxMm}
            className="w-full rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-stone-900 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10 transition-colors"
          />
          <p className="mt-1 text-xs text-stone-400">
            Longest dimension ≤ this → Small parcel
          </p>
        </div>
        <div>
          <label
            htmlFor="mediumMaxMm"
            className="block text-sm font-medium text-stone-700 mb-1.5"
          >
            Medium max (mm)
          </label>
          <input
            id="mediumMaxMm"
            name="mediumMaxMm"
            type="number"
            min={1}
            max={9999}
            required
            defaultValue={mediumMaxMm}
            className="w-full rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-stone-900 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10 transition-colors"
          />
          <p className="mt-1 text-xs text-stone-400">
            Longest dimension ≤ this → Medium parcel
          </p>
        </div>
      </div>
      <p className="text-xs text-stone-400 mb-4">
        Anything larger than the medium threshold is classified as Large.
        Artworks shipped as a rolled tube are always classified as Tube.
      </p>
      <div className="border-t border-stone-100 pt-5 mb-5 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-stone-900">Dispatch address</h3>
          <p className="mt-1 text-xs text-stone-500">
            Used as the shipping origin for live Australia Post and Aramex quotes.
            This address is never shown on the public artwork page.
          </p>
        </div>
        <div>
          <label htmlFor="originAddressLine1" className="block text-sm font-medium text-stone-700 mb-1.5">
            Address line 1
          </label>
          <input
            id="originAddressLine1"
            name="originAddressLine1"
            required
            defaultValue={originAddressLine1 ?? ""}
            className="w-full rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-stone-900 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10"
          />
        </div>
        <div>
          <label htmlFor="originAddressLine2" className="block text-sm font-medium text-stone-700 mb-1.5">
            Address line 2 <span className="font-normal text-stone-400">(optional)</span>
          </label>
          <input
            id="originAddressLine2"
            name="originAddressLine2"
            defaultValue={originAddressLine2 ?? ""}
            className="w-full rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-stone-900 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10"
          />
        </div>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label htmlFor="originSuburb" className="block text-sm font-medium text-stone-700 mb-1.5">
              Suburb
            </label>
            <input id="originSuburb" name="originSuburb" required defaultValue={originSuburb ?? ""} className="w-full rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-stone-900 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10" />
          </div>
          <div>
            <label htmlFor="originState" className="block text-sm font-medium text-stone-700 mb-1.5">
              State
            </label>
            <input id="originState" name="originState" required maxLength={3} defaultValue={originState ?? ""} placeholder="VIC" className="w-full rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm uppercase text-stone-900 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10" />
          </div>
          <div>
            <label htmlFor="originPostcode" className="block text-sm font-medium text-stone-700 mb-1.5">
              Postcode
            </label>
            <input id="originPostcode" name="originPostcode" required inputMode="numeric" pattern="[0-9]{4}" maxLength={4} defaultValue={originPostcode ?? ""} className="w-full rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-stone-900 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10" />
          </div>
        </div>
      </div>
      <button
        type="submit"
        disabled={isPending}
        className="rounded-lg bg-stone-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-stone-800 focus:outline-none focus:ring-2 focus:ring-stone-900 focus:ring-offset-2 transition-colors disabled:opacity-60"
      >
        {isPending ? "Saving…" : "Save freight settings"}
      </button>
    </form>
  );
}
