import { CheckCircle2, AlertCircle } from "lucide-react";

interface Props {
  stripeChargesEnabled: boolean | null;
  stripePayoutsEnabled: boolean | null;
}

/**
 * "Checkout status (cached)" panel shown on the settings page when the gallery
 * has a connected Stripe account.  Displays "Yes", "No", or "Not yet received"
 * for each flag depending on the cached DB values updated by account.updated
 * webhooks.
 */
export function StripeReadinessPanel({
  stripeChargesEnabled,
  stripePayoutsEnabled,
}: Props) {
  return (
    <div className="rounded-lg border border-stone-200 bg-stone-50 px-4 py-3 space-y-2">
      <p className="text-xs font-semibold text-stone-500 uppercase tracking-wider">
        Checkout status (cached)
      </p>
      <div className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
        <span className="text-stone-500">Charges enabled</span>
        {stripeChargesEnabled === true ? (
          <span className="flex items-center gap-1.5 text-emerald-700">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
            Yes
          </span>
        ) : stripeChargesEnabled === false ? (
          <span className="flex items-center gap-1.5 text-red-600">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            No
          </span>
        ) : (
          <span className="text-stone-400">Not yet received</span>
        )}
        <span className="text-stone-500">Payouts enabled</span>
        {stripePayoutsEnabled === true ? (
          <span className="flex items-center gap-1.5 text-emerald-700">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
            Yes
          </span>
        ) : stripePayoutsEnabled === false ? (
          <span className="flex items-center gap-1.5 text-red-600">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            No
          </span>
        ) : (
          <span className="text-stone-400">Not yet received</span>
        )}
      </div>
      <p className="text-xs text-stone-400 leading-relaxed pt-0.5">
        These values are updated by Stripe webhooks and are what buyers
        experience at checkout. If they look stale, complete Stripe
        onboarding and wait for the webhook to arrive.
      </p>
    </div>
  );
}
