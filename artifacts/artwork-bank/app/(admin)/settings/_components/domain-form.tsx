"use client";

import { useActionState } from "react";
import { saveCustomDomain } from "../actions";

const initialState = { error: null as string | null };

export function DomainForm({ currentDomain }: { currentDomain?: string | null }) {
  const [state, formAction, isPending] = useActionState(saveCustomDomain, initialState);

  return (
    <form action={formAction} className="space-y-3">
      <div>
        <label
          htmlFor="customDomain"
          className="block text-xs font-medium text-stone-500 mb-1.5"
        >
          {currentDomain ? "Change domain" : "Your domain"}
        </label>
        <div className="flex gap-2">
          <input
            id="customDomain"
            name="customDomain"
            type="text"
            defaultValue={currentDomain ?? ""}
            placeholder="www.yourname.com"
            className="flex-1 rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10 transition-colors font-mono"
          />
          <button
            type="submit"
            disabled={isPending}
            className="rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-60 transition-colors whitespace-nowrap"
          >
            {isPending ? "Saving…" : currentDomain ? "Update" : "Save domain"}
          </button>
        </div>
      </div>
      {state.error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3.5 py-2.5">
          {state.error}
        </p>
      )}
    </form>
  );
}
