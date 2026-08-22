"use client";

import { useActionState, useState } from "react";
import { addCarrierAccount, type CarrierAccountState } from "../actions";

const initial: CarrierAccountState = { error: null, success: false };

const inputClass =
  "w-full rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10";

export function CarrierAccountForm() {
  const [provider, setProvider] = useState<"AUSTRALIA_POST" | "ARAMEX">(
    "AUSTRALIA_POST",
  );
  const [state, formAction, isPending] = useActionState<
    CarrierAccountState,
    FormData
  >(addCarrierAccount, initial);

  return (
    <form action={formAction} className="space-y-4">
      {state.error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
          {state.error}
        </p>
      )}
      {state.success && (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-700">
          Carrier account connected. Request a quote from an artwork page to confirm it is ready.
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="carrier-provider" className="mb-1.5 block text-sm font-medium text-stone-700">
            Carrier
          </label>
          <select
            id="carrier-provider"
            name="provider"
            value={provider}
            onChange={(event) =>
              setProvider(event.target.value as "AUSTRALIA_POST" | "ARAMEX")
            }
            className={inputClass}
          >
            <option value="AUSTRALIA_POST">Australia Post</option>
            <option value="ARAMEX">Aramex</option>
          </select>
        </div>
        <div>
          <label htmlFor="carrier-label" className="mb-1.5 block text-sm font-medium text-stone-700">
            Account label
          </label>
          <input id="carrier-label" name="label" required maxLength={80} className={inputClass} placeholder={provider === "AUSTRALIA_POST" ? "Australia Post business account" : "Aramex gallery account"} />
        </div>
      </div>

      {provider === "AUSTRALIA_POST" ? (
        <div>
          <label htmlFor="auspost-api-key" className="mb-1.5 block text-sm font-medium text-stone-700">
            Australia Post API key
          </label>
          <input id="auspost-api-key" name="apiKey" type="password" required autoComplete="new-password" className={inputClass} />
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="aramex-username" className="mb-1.5 block text-sm font-medium text-stone-700">Aramex user name</label>
              <input id="aramex-username" name="userName" required autoComplete="off" className={inputClass} />
            </div>
            <div>
              <label htmlFor="aramex-password" className="mb-1.5 block text-sm font-medium text-stone-700">Aramex password</label>
              <input id="aramex-password" name="password" type="password" required autoComplete="new-password" className={inputClass} />
            </div>
            <div>
              <label htmlFor="aramex-account-number" className="mb-1.5 block text-sm font-medium text-stone-700">Account number</label>
              <input id="aramex-account-number" name="accountNumber" required className={inputClass} />
            </div>
            <div>
              <label htmlFor="aramex-pin" className="mb-1.5 block text-sm font-medium text-stone-700">Account PIN</label>
              <input id="aramex-pin" name="accountPin" type="password" required autoComplete="new-password" className={inputClass} />
            </div>
            <div>
              <label htmlFor="aramex-entity" className="mb-1.5 block text-sm font-medium text-stone-700">Account entity</label>
              <input id="aramex-entity" name="accountEntity" required className={inputClass} placeholder="SYD" />
            </div>
            <div>
              <label htmlFor="aramex-country" className="mb-1.5 block text-sm font-medium text-stone-700">Account country</label>
              <input id="aramex-country" name="accountCountryCode" required maxLength={2} defaultValue="AU" className={inputClass} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-stone-600">
            <input type="checkbox" name="useTestEndpoint" />
            Use Aramex test endpoint
          </label>
        </>
      )}

      <label className="flex items-center gap-2 text-sm text-stone-600">
        <input type="checkbox" name="enabled" defaultChecked />
        Offer live quotes from this account
      </label>
      <p className="text-xs leading-relaxed text-stone-400">
        Credentials are encrypted before storage and are not shown again. Disconnect and reconnect the account to replace them.
      </p>
      <button type="submit" disabled={isPending} className="rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-60">
        {isPending ? "Connecting…" : "Connect carrier account"}
      </button>
    </form>
  );
}