import { Sparkles } from "lucide-react";
import {
  getSubscriptionBadge,
  getTrialDaysRemaining,
} from "@/lib/billing";

/**
 * Subscription status badge rendered in the top-right corner of the billing
 * card on the admin billing page.
 *
 * Extracted into its own file so it can be imported by rendering tests and
 * verified independently of the Next.js server-component data-fetching layer.
 */
export function SubscriptionStatusBadge({
  subscriptionStatus,
  billingExempt,
  iframerAccountId,
  trialEnd,
}: {
  subscriptionStatus: string | null | undefined;
  billingExempt: boolean;
  iframerAccountId?: string | null;
  trialEnd?: Date | null;
}) {
  if (billingExempt && iframerAccountId) {
    return (
      <span className="flex items-center gap-1 rounded-full bg-indigo-100 text-indigo-700 px-3 py-1 text-sm font-semibold">
        <Sparkles className="h-3.5 w-3.5" /> i-Framer Premium
      </span>
    );
  }

  if (billingExempt) {
    return (
      <span className="flex items-center gap-1 rounded-full bg-violet-100 text-violet-700 px-3 py-1 text-sm font-semibold">
        <Sparkles className="h-3.5 w-3.5" /> Complimentary
      </span>
    );
  }

  const badge = getSubscriptionBadge(subscriptionStatus);
  const trialDaysRemaining = getTrialDaysRemaining(subscriptionStatus, trialEnd);

  if (badge) {
    return (
      <div className="flex flex-col items-end gap-1.5">
        <span
          className={`rounded-full px-3 py-1 text-sm font-semibold ${badge.cls}`}
        >
          {badge.label}
        </span>
        {trialDaysRemaining !== null && (
          <span
            className={`text-xs font-medium ${
              trialDaysRemaining <= 3 ? "text-amber-600" : "text-stone-500"
            }`}
          >
            {trialDaysRemaining === 0
              ? "Your trial ends today"
              : `${trialDaysRemaining} day${trialDaysRemaining === 1 ? "" : "s"} remaining in your trial`}
          </span>
        )}
        {subscriptionStatus === "trialing" && trialEnd && (
          <span className="text-xs text-stone-400">
            Ends{" "}
            {new Intl.DateTimeFormat("en-AU", {
              day: "numeric",
              month: "long",
              year: "numeric",
            }).format(trialEnd)}
          </span>
        )}
      </div>
    );
  }

  return (
    <span className="rounded-full bg-stone-100 text-stone-500 px-3 py-1 text-sm font-semibold">
      Not subscribed
    </span>
  );
}
