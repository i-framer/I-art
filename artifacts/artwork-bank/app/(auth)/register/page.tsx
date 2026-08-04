"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { register, type AuthState } from "@/app/(auth)/actions";

const initialState: AuthState = { error: "" };

export default function RegisterPage() {
  const [state, formAction, isPending] = useActionState<AuthState, FormData>(
    register,
    initialState,
  );
  const [passwordError, setPasswordError] = useState("");

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    const form = e.currentTarget;
    const password = (form.elements.namedItem("password") as HTMLInputElement)
      .value;
    const confirm = (
      form.elements.namedItem("confirmPassword") as HTMLInputElement
    ).value;
    if (password !== confirm) {
      e.preventDefault();
      setPasswordError("Passwords don't match — please re-enter them.");
      return;
    }
    setPasswordError("");
  }

  return (
    <div className="min-h-screen bg-stone-50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <span className="text-2xl font-semibold tracking-tight text-stone-900">
            Artwork Bank
          </span>
          <p className="text-sm text-stone-500 mt-1">Create your storefront</p>
        </div>

        {/* Card */}
        <div className="bg-white rounded-xl border border-stone-200 shadow-sm p-6">
          <form action={formAction} onSubmit={handleSubmit} className="space-y-4">
            {state.error && (
              <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
                {state.error}
              </div>
            )}

            <div>
              <label
                htmlFor="businessName"
                className="block text-sm font-medium text-stone-700 mb-1.5"
              >
                Business / artist name
              </label>
              <input
                id="businessName"
                name="businessName"
                type="text"
                required
                className="w-full rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10 transition-colors"
                placeholder="Jane Smith Studio"
              />
            </div>

            <div>
              <span className="block text-sm font-medium text-stone-700 mb-2">
                Account type
              </span>
              <div className="grid grid-cols-2 gap-3">
                {[
                  {
                    value: "ARTIST",
                    label: "Artist",
                    desc: "Selling my own work",
                  },
                  {
                    value: "FRAMER",
                    label: "Framer",
                    desc: "Framing business / gallery",
                  },
                ].map(({ value, label, desc }) => (
                  <label
                    key={value}
                    className="relative flex flex-col cursor-pointer rounded-lg border border-stone-300 p-3 hover:border-stone-400 has-[:checked]:border-stone-900 has-[:checked]:bg-stone-50 transition-colors"
                  >
                    <input
                      type="radio"
                      name="type"
                      value={value}
                      defaultChecked={value === "ARTIST"}
                      className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
                    />
                    <span className="text-sm font-medium text-stone-900">
                      {label}
                    </span>
                    <span className="text-xs text-stone-500 mt-0.5">{desc}</span>
                  </label>
                ))}
              </div>
            </div>

            <div>
              <label
                htmlFor="email"
                className="block text-sm font-medium text-stone-700 mb-1.5"
              >
                Email address
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
            </div>

            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-stone-700 mb-1.5"
              >
                Password{" "}
                <span className="font-normal text-stone-400">(min 8 chars)</span>
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                onChange={() => setPasswordError("")}
                className="w-full rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10 transition-colors"
                placeholder="••••••••"
              />
            </div>

            <div>
              <label
                htmlFor="confirmPassword"
                className="block text-sm font-medium text-stone-700 mb-1.5"
              >
                Confirm password
              </label>
              <input
                id="confirmPassword"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                onChange={() => setPasswordError("")}
                className={`w-full rounded-lg border bg-white px-3.5 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:outline-none focus:ring-2 transition-colors ${
                  passwordError
                    ? "border-red-400 focus:border-red-500 focus:ring-red-500/10"
                    : "border-stone-300 focus:border-stone-900 focus:ring-stone-900/10"
                }`}
                placeholder="••••••••"
              />
              {passwordError && (
                <p className="mt-1.5 text-xs text-red-600">{passwordError}</p>
              )}
            </div>

            <button
              type="submit"
              disabled={isPending}
              className="w-full rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-stone-800 focus:outline-none focus:ring-2 focus:ring-stone-900 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isPending ? "Creating account…" : "Create account"}
            </button>
          </form>
        </div>

        <p className="text-center text-sm text-stone-500 mt-4">
          Already have an account?{" "}
          <Link
            href="/login"
            className="font-medium text-stone-900 hover:underline"
          >
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
