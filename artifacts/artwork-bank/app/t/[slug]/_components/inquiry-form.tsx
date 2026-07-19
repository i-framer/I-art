"use client";

import { useActionState } from "react";
import { submitInquiry, type InquiryState } from "../[artworkId]/actions";

const initialState: InquiryState = { status: "idle", error: "" };

export function InquiryForm({
  slug,
  artworkId,
  themeColor,
}: {
  slug: string;
  artworkId: string;
  themeColor: string;
}) {
  const [state, formAction, isPending] = useActionState<InquiryState, FormData>(
    submitInquiry.bind(null, slug, artworkId),
    initialState,
  );

  if (state.status === "sent") {
    return (
      <div className="rounded-xl bg-green-50 border border-green-200 px-4 py-4 text-center">
        <p className="text-sm font-medium text-green-800">
          Your inquiry has been sent ✓
        </p>
        <p className="mt-1 text-xs text-green-700">
          The gallery will get back to you by email.
        </p>
      </div>
    );
  }

  const inputClass =
    "w-full rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10 transition-colors";

  return (
    <form action={formAction} className="mt-4 space-y-3 text-left">
      {/* Honeypot field — hidden from real users, catches bots that fill every input. */}
      <div aria-hidden="true" className="absolute -left-[9999px] top-auto h-px w-px overflow-hidden">
        <label>
          Website
          <input
            name="website"
            type="text"
            tabIndex={-1}
            autoComplete="off"
            defaultValue=""
          />
        </label>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <input
          name="name"
          type="text"
          required
          placeholder="Your name"
          aria-label="Your name"
          className={inputClass}
        />
        <input
          name="email"
          type="email"
          required
          placeholder="Your email"
          aria-label="Your email"
          className={inputClass}
        />
      </div>
      <textarea
        name="message"
        required
        rows={3}
        placeholder="I'm interested in this piece…"
        aria-label="Your message"
        className={`${inputClass} resize-y`}
      />
      {state.status === "error" && (
        <p className="text-xs text-red-600">{state.error}</p>
      )}
      <button
        type="submit"
        disabled={isPending}
        className="w-full rounded-xl py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
        style={{ backgroundColor: themeColor }}
      >
        {isPending ? "Sending…" : "Send inquiry"}
      </button>
    </form>
  );
}
