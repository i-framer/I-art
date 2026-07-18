"use client";

import { use, useActionState } from "react";
import { acceptInvite, type InviteState } from "./actions";

const initialState: InviteState = { error: "" };

export default function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const [state, formAction, isPending] = useActionState<InviteState, FormData>(
    acceptInvite,
    initialState,
  );

  return (
    <div className="min-h-screen bg-stone-50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <span className="text-2xl font-semibold tracking-tight text-stone-900">
            Artwork Bank
          </span>
          <p className="text-sm text-stone-500 mt-1">
            You&apos;ve been invited to join a storefront
          </p>
        </div>

        <div className="bg-white rounded-xl border border-stone-200 shadow-sm p-6">
          <form action={formAction} className="space-y-4">
            <input type="hidden" name="token" value={token} />

            {state.error && (
              <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
                {state.error}
              </div>
            )}

            <div>
              <label
                htmlFor="email"
                className="block text-sm font-medium text-stone-700 mb-1.5"
              >
                Your email address
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                className="w-full rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10 transition-colors"
                placeholder="you@example.com"
              />
              <p className="mt-1 text-xs text-stone-400">
                Use the email address this invite was sent to.
              </p>
            </div>

            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-stone-700 mb-1.5"
              >
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                className="w-full rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10 transition-colors"
                placeholder="••••••••"
              />
              <p className="mt-1 text-xs text-stone-400">
                New to Artwork Bank? Create a password. Existing member? Use
                your current password.
              </p>
            </div>

            <button
              type="submit"
              disabled={isPending}
              className="w-full rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-stone-800 focus:outline-none focus:ring-2 focus:ring-stone-900 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isPending ? "Joining…" : "Accept invitation"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
