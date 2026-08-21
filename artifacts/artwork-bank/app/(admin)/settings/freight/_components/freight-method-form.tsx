"use client";

import { useActionState } from "react";
import type { FreightMethod } from "@workspace/db";
import { addFreightMethod, updateFreightMethod, type FreightMethodState } from "../actions";

const initial: FreightMethodState = { error: null, success: false };

function centsToAud(cents: number): string {
  return (cents / 100).toFixed(2);
}

type Props =
  | { mode: "add"; method?: undefined }
  | { mode: "edit"; method: FreightMethod; onCancel: () => void };

export function FreightMethodForm(props: Props) {
  const action = props.mode === "add" ? addFreightMethod : updateFreightMethod;

  const [state, formAction, isPending] = useActionState<
    FreightMethodState,
    FormData
  >(action, initial);

  const m = props.mode === "edit" ? props.method : null;

  return (
    <form action={formAction} className="space-y-4">
      {state.error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {state.error}
        </div>
      )}
      {state.success && props.mode === "add" && (
        <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-700">
          Freight method added.
        </div>
      )}

      {/* Hidden method ID for edit mode */}
      {m && <input type="hidden" name="id" value={m.id} />}

      <div>
        <label className="block text-sm font-medium text-stone-700 mb-1.5">
          Method name
        </label>
        <input
          name="name"
          type="text"
          required
          maxLength={100}
          defaultValue={m?.name ?? ""}
          placeholder="e.g. Australia Post Regular"
          className="w-full rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10 transition-colors"
        />
      </div>

      {/* Rate grid */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(
          [
            { label: "Small (AUD)", field: "smallAud", cents: m?.smallCents },
            { label: "Medium (AUD)", field: "mediumAud", cents: m?.mediumCents },
            { label: "Large (AUD)", field: "largeAud", cents: m?.largeCents },
            { label: "Rolled tube (AUD)", field: "tubeAud", cents: m?.tubeCents },
          ] as const
        ).map(({ label, field, cents }) => (
          <div key={field}>
            <label className="block text-xs font-medium text-stone-600 mb-1">
              {label}
            </label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-stone-400">
                $
              </span>
              <input
                name={field}
                type="number"
                min="0"
                step="0.01"
                required
                defaultValue={cents !== undefined ? centsToAud(cents) : "0.00"}
                className="w-full rounded-lg border border-stone-300 bg-white pl-6 pr-3 py-2 text-sm text-stone-900 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10 transition-colors"
              />
            </div>
          </div>
        ))}
      </div>

      {/* Enabled toggle */}
      <div className="flex items-center gap-2">
        <input
          id={`enabled-${m?.id ?? "new"}`}
          name="enabled"
          type="checkbox"
          defaultChecked={m ? m.enabled : true}
          className="h-4 w-4 rounded border-stone-300 text-stone-900 focus:ring-stone-900"
        />
        <label
          htmlFor={`enabled-${m?.id ?? "new"}`}
          className="text-sm text-stone-700"
        >
          Enable this method (shown to buyers at checkout)
        </label>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={isPending}
          className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 focus:outline-none focus:ring-2 focus:ring-stone-900 focus:ring-offset-2 transition-colors disabled:opacity-60"
        >
          {isPending
            ? "Saving…"
            : props.mode === "add"
              ? "Add method"
              : "Save changes"}
        </button>
        {props.mode === "edit" && (
          <button
            type="button"
            onClick={props.onCancel}
            className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50 transition-colors"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
