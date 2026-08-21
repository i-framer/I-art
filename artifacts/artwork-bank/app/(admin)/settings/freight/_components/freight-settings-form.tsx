"use client";

import { useActionState } from "react";
import { saveFreightSettings, type FreightSettingsState } from "../actions";

const initial: FreightSettingsState = { error: null, success: false };

export function FreightSettingsForm({
  smallMaxMm,
  mediumMaxMm,
}: {
  smallMaxMm: number;
  mediumMaxMm: number;
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
          Dimension thresholds saved.
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
      <button
        type="submit"
        disabled={isPending}
        className="rounded-lg bg-stone-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-stone-800 focus:outline-none focus:ring-2 focus:ring-stone-900 focus:ring-offset-2 transition-colors disabled:opacity-60"
      >
        {isPending ? "Saving…" : "Save thresholds"}
      </button>
    </form>
  );
}
