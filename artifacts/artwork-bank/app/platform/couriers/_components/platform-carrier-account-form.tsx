"use client";

import { useActionState, useState } from "react";
import {
  savePlatformCarrierAccount,
  type PlatformCarrierAccountState,
} from "../../actions";

const initial: PlatformCarrierAccountState = { error: null, success: false };
const inputClass =
  "w-full rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10";

type ExistingAccount = {
  id: string;
  label: string;
  provider: "AUSTRALIA_POST" | "ARAMEX";
  enabled: boolean;
};

export function PlatformCarrierAccountForm({
  account,
}: {
  account?: ExistingAccount;
}) {
  const [provider, setProvider] = useState<"AUSTRALIA_POST" | "ARAMEX">(
    account?.provider ?? "AUSTRALIA_POST",
  );
  const [state, formAction, isPending] = useActionState<
    PlatformCarrierAccountState,
    FormData
  >(savePlatformCarrierAccount, initial);

  return (
    <form action={formAction} className="space-y-4">
      {account && <input type="hidden" name="carrierAccountId" value={account.id} />}
      {state.error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
          {state.error}
        </p>
      )}
      {state.success && (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-700">
          Courier account saved. Galleries can now opt into it from Freight settings.
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={`${account?.id ?? "new"}-carrier-provider`} className="mb-1.5 block text-sm font-medium text-stone-700">
            Carrier
          </label>
          <select
            id={`${account?.id ?? "new"}-carrier-provider`}
            name="provider"
            value={provider}
            onChange={(event) => setProvider(event.target.value as "AUSTRALIA_POST" | "ARAMEX")}
            className={inputClass}
          >
            <option value="AUSTRALIA_POST">Australia Post</option>
            <option value="ARAMEX">Aramex</option>
          </select>
        </div>
        <div>
          <label htmlFor={`${account?.id ?? "new"}-carrier-label`} className="mb-1.5 block text-sm font-medium text-stone-700">
            Account label
          </label>
          <input
            id={`${account?.id ?? "new"}-carrier-label`}
            name="label"
            required
            maxLength={80}
            defaultValue={account?.label}
            className={inputClass}
            placeholder="e.g. Australia Post platform account"
          />
        </div>
      </div>

      {provider === "AUSTRALIA_POST" ? (
        <div>
          <label htmlFor={`${account?.id ?? "new"}-auspost-api-key`} className="mb-1.5 block text-sm font-medium text-stone-700">
            Australia Post API key
          </label>
          <input id={`${account?.id ?? "new"}-auspost-api-key`} name="apiKey" type="password" required autoComplete="new-password" className={inputClass} />
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <div><label htmlFor={`${account?.id ?? "new"}-aramex-username`} className="mb-1.5 block text-sm font-medium text-stone-700">Aramex user name</label><input id={`${account?.id ?? "new"}-aramex-username`} name="userName" required className={inputClass} /></div>
          <div><label htmlFor={`${account?.id ?? "new"}-aramex-password`} className="mb-1.5 block text-sm font-medium text-stone-700">Aramex password</label><input id={`${account?.id ?? "new"}-aramex-password`} name="password" type="password" required autoComplete="new-password" className={inputClass} /></div>
          <div><label htmlFor={`${account?.id ?? "new"}-aramex-account-number`} className="mb-1.5 block text-sm font-medium text-stone-700">Account number</label><input id={`${account?.id ?? "new"}-aramex-account-number`} name="accountNumber" required className={inputClass} /></div>
          <div><label htmlFor={`${account?.id ?? "new"}-aramex-pin`} className="mb-1.5 block text-sm font-medium text-stone-700">Account PIN</label><input id={`${account?.id ?? "new"}-aramex-pin`} name="accountPin" type="password" required autoComplete="new-password" className={inputClass} /></div>
          <div><label htmlFor={`${account?.id ?? "new"}-aramex-entity`} className="mb-1.5 block text-sm font-medium text-stone-700">Account entity</label><input id={`${account?.id ?? "new"}-aramex-entity`} name="accountEntity" required className={inputClass} placeholder="SYD" /></div>
          <div><label htmlFor={`${account?.id ?? "new"}-aramex-country`} className="mb-1.5 block text-sm font-medium text-stone-700">Account country</label><input id={`${account?.id ?? "new"}-aramex-country`} name="accountCountryCode" required maxLength={2} defaultValue="AU" className={inputClass} /></div>
          <label className="flex items-center gap-2 text-sm text-stone-600 sm:col-span-2"><input type="checkbox" name="useTestEndpoint" /> Use Aramex test endpoint</label>
        </div>
      )}
      <label className="flex items-center gap-2 text-sm text-stone-600">
        <input type="checkbox" name="enabled" defaultChecked={account?.enabled ?? true} />
        Make this courier available for galleries
      </label>
      <p className="text-xs leading-relaxed text-stone-400">
        Credentials are encrypted before storage and are never shown again. Re-enter the details here to replace them.
      </p>
      <button type="submit" disabled={isPending} className="rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-60">
        {isPending ? "Saving…" : account ? "Replace credentials" : "Add approved courier"}
      </button>
    </form>
  );
}